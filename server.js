require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const crypto   = require("crypto");
const axios    = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { v2: cloudinary } = require("cloudinary");
const cron     = require("node-cron");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Supabase ───────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Cloudinary ─────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dnmzyoobh",
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const WEBAPP_URL = process.env.WEBAPP_URL || "https://cockpit-pro-webapp-staging.vercel.app";

// ── Middleware ─────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use((req, res, next) => {
  if (req.path === "/webhook") {
    express.raw({ type: "application/json" })(req, res, next);
  } else {
    express.json({ limit: "10mb" })(req, res, next);
  }
});

// ── Multi-LINE OA: Token Cache (10 min) ───────────────────────
// แต่ละสาขามี LINE OA แยกกัน — ดึง credentials จาก Supabase
const credCache = {};

async function getBranchCreds(branchId) {
  if (credCache[branchId]) return credCache[branchId];
  const { data } = await supabase
    .from("branches")
    .select("id, name, line_channel_id, line_secret, line_token")
    .eq("id", branchId)
    .single();
  if (!data) return null;
  credCache[branchId] = data;
  setTimeout(() => { delete credCache[branchId]; }, 10 * 60 * 1000);
  return data;
}

// หา branch จาก LINE Channel destination ID (Ub1ce970...)
async function getBranchByChannelId(channelId) {
  const { data } = await supabase
    .from("branches")
    .select("id, name, line_channel_id, line_secret, line_token")
    .eq("line_channel_id", channelId)
    .single();
  return data || null;
}

// ── LINE Push / Reply ──────────────────────────────────────────
async function linePush(branchId, userId, messages) {
  if (!userId) return;
  const creds = await getBranchCreds(branchId);
  if (!creds?.line_token) {
    console.error(`[LINE] No token for branch: ${branchId}`);
    return;
  }
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/push",
      { to: userId, messages },
      { headers: { Authorization: `Bearer ${creds.line_token}`, "Content-Type": "application/json" } }
    );
    console.log(`[LINE] Push → ${userId} via ${branchId}`);
  } catch (e) {
    console.error(`[LINE] Push error [${branchId}]:`, e.response?.data || e.message);
  }
}

async function lineReply(branchId, replyToken, messages) {
  if (!replyToken) return;
  const creds = await getBranchCreds(branchId);
  if (!creds?.line_token) return;
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      { replyToken, messages },
      { headers: { Authorization: `Bearer ${creds.line_token}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error(`[LINE] Reply error [${branchId}]:`, e.response?.data || e.message);
  }
}

// ── Flex Message: Status ───────────────────────────────────────
function statusFlex({ plate, branchName, bay, bayStatus, jobs }) {
  const real = (jobs || []).filter(j => j.name !== "รับรถเข้า");
  const done = real.filter(j => j.status === "done").length;
  const pct  = real.length ? Math.round(done / real.length * 100) : 0;
  const st   = bayStatus === "done"       ? "✅ เสร็จเรียบร้อย"
             : bayStatus === "in_service" ? "🔧 กำลังดำเนินการ"
             : "⏳ รอเข้าช่องซ่อม";
  const col  = bayStatus === "done"       ? "#059669"
             : bayStatus === "in_service" ? "#d97706" : "#374151";
  return {
    type: "flex", altText: `สถานะ ${plate} — ${st}`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#1A1A1A", paddingAll: "16px",
        contents: [
          { type: "text", text: "🚗 Cockpit Pro – สถานะรถของคุณ", color: "#FFE000", size: "xs", weight: "bold" },
          { type: "text", text: plate, color: "#FFFFFF", size: "3xl", weight: "bold" },
          { type: "text", text: `${branchName} · ช่องที่ ${bay}`, color: "#9ca3af", size: "sm" },
        ],
      },
      body: {
        type: "box", layout: "vertical", spacing: "md",
        contents: [
          {
            type: "box", layout: "horizontal",
            contents: [
              { type: "text", text: st, color: col, weight: "bold", size: "md", flex: 1 },
              { type: "text", text: `${pct}%`, color: col, weight: "bold", size: "md", align: "end" },
            ],
          },
          ...(real.length ? [{
            type: "box", layout: "vertical", backgroundColor: "#f3f4f6",
            cornerRadius: "8px", paddingAll: "12px",
            contents: [
              { type: "text", text: "รายการงาน", size: "xs", color: "#9ca3af", weight: "bold" },
              ...real.map(j => ({
                type: "box", layout: "horizontal", margin: "sm",
                contents: [
                  { type: "text", size: "sm", flex: 0, text: j.status === "done" ? "✅" : j.status === "in_progress" ? "🔧" : "⏳" },
                  { type: "text", text: j.name, size: "sm", flex: 1, margin: "sm", decoration: j.status === "done" ? "line-through" : "none", color: j.status === "done" ? "#9ca3af" : "#1A1A1A" },
                  { type: "text", text: `${j.duration || 30} นาที`, size: "xs", color: "#9ca3af", align: "end" },
                ],
              })),
            ],
          }] : []),
          { type: "text", text: "ขอบคุณที่ใช้บริการ Cockpit 🙏", size: "xs", color: "#9ca3af", align: "center" },
          ...(bayStatus === "done" ? [{
            type: "text",
            text: "งานเสร็จเรียบร้อย\nหากท่านอยู่ในสาขากรุณารอสักครู่\nพนักงานจะไปพบท่านเพื่อชำระสินค้าและบริการ",
            size: "sm", color: "#1A1A1A", weight: "bold", align: "center", wrap: true, margin: "sm",
          }] : []),
        ],
      },
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────
function getDuration(name) {
  const map = {
    "เปลี่ยนยาง 4 เส้น": 52, "สลับยาง": 12, "ยาง 1,2,3 เส้น": 20,
    "ถ่วงล้อ": 35, "ตั้งศูนย์ล้อ": 52, "เปลี่ยนถ่ายน้ำมันเครื่อง": 35,
    "เปลี่ยนแบตเตอรี่": 25, "เปลี่ยนเบรก": 52, "CockpitSure": 17,
    "เปลี่ยนโช้คอัพ": 52, "งานซ่อมช่วงล่าง": 135, "เบิกอะไหล่": 85, "งานซ่อมอื่น": 75,
  };
  return map[name] || 30;
}

async function getQueueRow(branchId, bay) {
  const { data } = await supabase.from("queue")
    .select("*").eq("branch_id", branchId).eq("bay", bay).single();
  return data;
}

async function getBranchName(branchId) {
  const { data } = await supabase.from("branches").select("name").eq("id", branchId).single();
  return data?.name || branchId;
}

// ── Monthly Video Cleanup ──────────────────────────────────────
async function cleanupOldVideos() {
  try {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 1);
    console.log(`🧹 Auto-cleanup: ลบวีดีโอก่อน ${cutoff.toLocaleDateString("th-TH")}`);
    const { data: oldVideos, error } = await supabase.from("videos")
      .select("id, video_url, plate, branch_id").lt("uploaded_at", cutoff.toISOString());
    if (error) { console.error("Cleanup fetch error:", error.message); return; }
    if (!oldVideos?.length) { console.log("✅ ไม่มีวีดีโอเก่า"); return; }
    console.log(`🗑 พบ ${oldVideos.length} วีดีโอที่จะลบ`);
    let deleted = 0, failed = 0;
    for (const v of oldVideos) {
      try {
        const match = v.video_url?.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
        if (match?.[1]) await cloudinary.uploader.destroy(match[1], { resource_type: "video" });
        await supabase.from("videos").delete().eq("id", v.id);
        deleted++;
      } catch (e) { console.error(`  ❌ ลบไม่ได้: ${v.plate} — ${e.message}`); failed++; }
    }
    console.log(`🧹 Cleanup เสร็จ: ลบ ${deleted} คลิป, ล้มเหลว ${failed} คลิป`);
  } catch (e) { console.error("Cleanup error:", e.message); }
}

cron.schedule("0 19 1 * *", () => { console.log("⏰ Monthly cleanup triggered"); cleanupOldVideos(); }, { timezone: "UTC" });
console.log("✅ Monthly video cleanup scheduled (วันที่ 1 ของทุกเดือน 02:00 น.)");

// ══════════════════════════════════════════════════════════════
// WEBHOOK — Multi-LINE OA
// ══════════════════════════════════════════════════════════════
app.post("/webhook", async (req, res) => {
  // ต้อง return 200 เสมอ ไม่งั้น LINE จะ retry
  res.sendStatus(200);

  let body;
  try { body = JSON.parse(req.body.toString()); } catch { return; }

  // destination = Channel destination ID ของ LINE OA ที่รับ event
  const channelId = body.destination;
  if (!channelId) return;

  // หา branch จาก Channel ID
  const branch = await getBranchByChannelId(channelId);
  if (!branch) {
    console.error(`[Webhook] Unknown channel ID: ${channelId}`);
    return;
  }

  // Verify signature ด้วย line_secret ของสาขานั้น
  const sig = req.headers["x-line-signature"];
  if (sig && branch.line_secret) {
    const hash = crypto.createHmac("sha256", branch.line_secret).update(req.body).digest("base64");
    if (hash !== sig) {
      console.error(`[Webhook] Invalid signature for branch: ${branch.id}`);
      return;
    }
  }

  for (const ev of body.events || []) {
    try {
      await handleLineEvent(ev, branch);
    } catch (e) {
      console.error(`[Webhook] Event error [${branch.id}]:`, e.message);
    }
  }
});

async function handleLineEvent(ev, branch) {
  const userId = ev.source?.userId;
  const branchId = branch.id;
  const branchName = branch.name;

  // ── Follow event ───────────────────────────────────────────
  if (ev.type === "follow") {
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    await supabase.from("register_tokens").insert({
      token, branch_id: branchId, line_user_id: userId, expires_at: expiresAt,
    });
    const regUrl = `${WEBAPP_URL}/register.html?token=${token}`;
    await lineReply(branchId, ev.replyToken, [
      { type: "text", text: `ยินดีต้อนรับสู่ ${branchName || "Cockpit Pro"} 🚗\nกรุณาลงทะเบียนทะเบียนรถของคุณที่ลิงก์ด้านล่าง\nเพื่อรับการแจ้งเตือนเมื่อรถพร้อม` },
      {
        type: "template", altText: "ลงทะเบียน Cockpit Pro",
        template: { type: "buttons", text: "ลงทะเบียนทะเบียนรถ",
          actions: [{ type: "uri", label: "📝 ลงทะเบียน", uri: regUrl }] },
      },
    ]);
    return;
  }

  // ── Message event ──────────────────────────────────────────
  if (ev.type === "message" && ev.message?.type === "text") {
    const text = ev.message.text.trim().toLowerCase();

    if (text === "ลงทะเบียน" || text === "register") {
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 86400000).toISOString();
      await supabase.from("register_tokens").insert({
        token, branch_id: branchId, line_user_id: userId, expires_at: expiresAt,
      });
      const regUrl = `${WEBAPP_URL}/register.html?token=${token}`;
      await lineReply(branchId, ev.replyToken, [
        { type: "text", text: `คลิกลิงก์ด้านล่างเพื่อลงทะเบียนทะเบียนรถ:\n${regUrl}\n\n(ลิงก์ใช้ได้ 24 ชั่วโมง)` },
      ]);
      return;
    }

    if (text === "สถานะ" || text === "status") {
      const { data: queue } = await supabase.from("queue")
        .select("*").eq("line_user_id", userId)
        .order("created_at", { ascending: false }).limit(1);
      if (queue?.length) {
        const q = queue[0];
        await lineReply(branchId, ev.replyToken, [
          statusFlex({ plate: q.plate, branchName, bay: q.bay, bayStatus: q.bay_status, jobs: q.jobs }),
        ]);
      } else {
        await lineReply(branchId, ev.replyToken, [{ type: "text", text: "ไม่มีรถในคิวขณะนี้" }]);
      }
      return;
    }
  }
}

// ══════════════════════════════════════════════════════════════
// REGISTER
// ══════════════════════════════════════════════════════════════

// GET /api/register/:token — register.html เรียกเพื่อ validate
app.get("/api/register/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { data: tk } = await supabase.from("register_tokens")
      .select("*").eq("token", token).single();
    if (!tk) return res.status(404).json({ valid: false, error: "Token not found" });
    if (new Date(tk.expires_at) < new Date())
      return res.status(400).json({ valid: false, error: "Token expired" });
    const { data: br } = await supabase.from("branches")
      .select("name").eq("id", tk.branch_id).single();
    res.json({ valid: true, line_user_id: tk.line_user_id, branch_id: tk.branch_id, branchName: br?.name || tk.branch_id });
  } catch (e) { res.status(500).json({ valid: false, error: e.message }); }
});

// GET /api/register/check — legacy support
app.get("/api/register/check", async (req, res) => {
  try {
    const { plate, province } = req.query;
    if (!plate || !province) return res.status(400).json({ error: "Missing params" });
    const { data } = await supabase.from("line_users")
      .select("user_id").eq("plate", plate.toUpperCase()).eq("province", province).single();
    res.json({ registered: !!data, user_id: data?.user_id || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/register/submit — register.html กดยืนยัน
app.post("/api/register/submit", async (req, res) => {
  try {
    const { token, plate, province, phone } = req.body;
    if (!token || !plate) return res.status(400).json({ error: "token + plate required" });

    const { data: tk } = await supabase.from("register_tokens")
      .select("*").eq("token", token).single();
    if (!tk || new Date(tk.expires_at) < new Date())
      return res.status(400).json({ error: "Token หมดอายุหรือไม่ถูกต้อง" });

    const { branch_id: branchId, line_user_id: userId } = tk;

    // บันทึกข้อมูลลูกค้า
    await supabase.from("line_users").upsert(
      { user_id: userId, plate: plate.toUpperCase(), province: province || "", phone: phone || "", branch_id: branchId },
      { onConflict: "user_id" }
    );

    // ลบ token ที่ใช้แล้ว
    await supabase.from("register_tokens").delete().eq("token", token);

    // แจ้งยืนยัน
    await linePush(branchId, userId, [{
      type: "text",
      text: `✅ ลงทะเบียนสำเร็จ!\nทะเบียน: ${plate.toUpperCase()} ${province || ""}\nระบบจะแจ้งเตือนเมื่อรถพร้อม 🚗`,
    }]);

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// ADMIN OVERVIEW
// ══════════════════════════════════════════════════════════════
app.get("/api/admin/overview", async (req, res) => {
  try {
    const { data: branches } = await supabase.from("branches").select("id, name, max_bays");
    const overview = await Promise.all((branches || []).map(async br => {
      const { count } = await supabase.from("queue")
        .select("*", { count: "exact", head: true }).eq("branch_id", br.id);
      return { branchId: br.id, name: br.name, maxBays: br.max_bays, activeQueues: count || 0 };
    }));
    res.json({ overview });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// BRANCH DATA
// ══════════════════════════════════════════════════════════════
app.get("/api/branch/:branchId", async (req, res) => {
  try {
    const { branchId } = req.params;
    const { data: br } = await supabase.from("branches")
      .select("id, name, max_bays").eq("id", branchId).single();
    if (!br) return res.status(404).json({ error: "Branch not found" });
    const { data: rows } = await supabase.from("queue").select("*").eq("branch_id", branchId);
    const baysData = {};
    (rows || []).forEach(r => {
      baysData[r.bay] = {
        plate: r.plate, province: r.province, phone: r.phone,
        userId: r.line_user_id, bayStatus: r.bay_status || "waiting_entry",
        jobs: r.jobs || [], startTime: r.start_time, createdAt: r.created_at,
      };
    });
    res.json({ id: br.id, name: br.name, max_bays: br.max_bays, baysData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Open bay ───────────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/open", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { plate, province, phone, userId } = req.body;
    if (!plate) return res.status(400).json({ error: "plate required" });
    const jobs = [{ name: "รับรถเข้า", duration: 5, status: "waiting" }];
    await supabase.from("queue").upsert(
      { branch_id: branchId, bay, plate: plate.toUpperCase(), province: province || "",
        phone: phone || "", line_user_id: userId || null, bay_status: "waiting_entry", jobs },
      { onConflict: "branch_id,bay" }
    );
    if (userId) {
      const branchName = await getBranchName(branchId);
      await linePush(branchId, userId, [statusFlex({ plate: plate.toUpperCase(), branchName, bay, bayStatus: "waiting_entry", jobs })]);
    }
    res.json({ success: true, bay });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start service ──────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/start", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const row = await getQueueRow(branchId, bay);
    if (!row) return res.status(404).json({ error: "Not found" });
    await supabase.from("queue")
      .update({ bay_status: "in_service", start_time: new Date().toISOString() })
      .eq("branch_id", branchId).eq("bay", bay);
    const branchName = await getBranchName(branchId);
    await linePush(branchId, row.line_user_id, [statusFlex({ plate: row.plate, branchName, bay, bayStatus: "in_service", jobs: row.jobs })]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update job status ──────────────────────────────────────────
app.patch("/api/branch/:branchId/bay/:bay/job/:jobIdx", async (req, res) => {
  try {
    const { branchId, bay, jobIdx } = req.params;
    const { status } = req.body;
    const row = await getQueueRow(branchId, bay);
    if (!row) return res.status(404).json({ error: "Not found" });
    const jobs = [...(row.jobs || [])];
    if (!jobs[+jobIdx]) return res.status(400).json({ error: "Invalid index" });
    jobs[+jobIdx] = { ...jobs[+jobIdx], status };
    // Auto-update bay_status
    const real = jobs.filter(j => j.name !== "รับรถเข้า");
    const allDone = real.length > 0 && real.every(j => j.status === "done");
    const updateData = { jobs };
    if (allDone) updateData.bay_status = "done";
    await supabase.from("queue").update(updateData).eq("branch_id", branchId).eq("bay", bay);
    const branchName = await getBranchName(branchId);
    const currentStatus = allDone ? "done" : row.bay_status;
    await linePush(branchId, row.line_user_id, [statusFlex({ plate: row.plate, branchName, bay, bayStatus: currentStatus, jobs })]);
    res.json({ success: true, jobs, allDone });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Add jobs ───────────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/addjobs", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { jobs: names } = req.body;  // รับ array of strings
    const row = await getQueueRow(branchId, bay);
    if (!row) return res.status(404).json({ error: "Not found" });
    const existing = (row.jobs || []).map(j => j.name);
    const added = (names || []).filter(n => !existing.includes(n))
      .map(n => ({ name: n, duration: getDuration(n), status: "waiting" }));
    const jobs = [...(row.jobs || []), ...added];
    await supabase.from("queue").update({ jobs }).eq("branch_id", branchId).eq("bay", bay);
    const branchName = await getBranchName(branchId);
    await linePush(branchId, row.line_user_id, [statusFlex({ plate: row.plate, branchName, bay, bayStatus: row.bay_status, jobs })]);
    res.json({ success: true, jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Remove job ─────────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/removejob", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { jobIdx, nonotify } = req.body;
    const row = await getQueueRow(branchId, bay);
    if (!row) return res.status(404).json({ error: "Not found" });
    const jobs = (row.jobs || []).filter((_, i) => i !== +jobIdx);
    if (!jobs.length) return res.status(400).json({ error: "Cannot remove all jobs" });
    await supabase.from("queue").update({ jobs }).eq("branch_id", branchId).eq("bay", bay);
    if (!nonotify) {
      const branchName = await getBranchName(branchId);
      await linePush(branchId, row.line_user_id, [statusFlex({ plate: row.plate, branchName, bay, bayStatus: row.bay_status, jobs })]);
    }
    res.json({ success: true, remainingJobs: jobs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Close / Cancel ─────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/close", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { nonotify } = req.body;
    const row = await getQueueRow(branchId, bay);
    if (!row) return res.status(404).json({ error: "Not found" });
    const branchName = await getBranchName(branchId);
    const doneJobs = (row.jobs || []).map(j => ({ ...j, status: "done" }));
    await supabase.from("history").insert({
      branch_id: branchId, branch_name: branchName, bay,
      plate: row.plate, province: row.province, phone: row.phone,
      line_user_id: row.line_user_id, jobs: doneJobs,
      closed_at: new Date().toISOString(), cancelled: !!nonotify,
    });
    await supabase.from("queue").delete().eq("branch_id", branchId).eq("bay", bay);
    if (!nonotify && row.line_user_id) {
      await linePush(branchId, row.line_user_id, [statusFlex({ plate: row.plate, branchName, bay, bayStatus: "done", jobs: doneJobs })]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Notify manual ──────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/notify", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const row = await getQueueRow(branchId, bay);
    if (!row) return res.status(404).json({ error: "Not found" });
    const branchName = await getBranchName(branchId);
    await linePush(branchId, row.line_user_id, [statusFlex({ plate: row.plate, branchName, bay, bayStatus: row.bay_status, jobs: row.jobs })]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Quotation (photos → LINE) ──────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/quote", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { plate, note, photoUrls } = req.body;
    const row = await getQueueRow(branchId, bay);
    const userId = row?.line_user_id;
    if (!userId) return res.status(400).json({ error: "ลูกค้ายังไม่ได้ลงทะเบียน LINE" });
    const branchName = await getBranchName(branchId);
    const carPlate = plate || row?.plate;
    await linePush(branchId, userId, [{
      type: "text",
      text: `📋 ใบเสนอราคาสำหรับ ${carPlate}\n📍 ${branchName} · ช่องที่ ${bay}\n\nช่างได้จัดทำใบเสนอราคาไว้ด้านล่างครับ 👇${note ? `\n\n📝 ${note}` : ""}`,
    }]);
    for (const url of (photoUrls || []).slice(0, 5)) {
      await linePush(branchId, userId, [{ type: "image", originalContentUrl: url, previewImageUrl: url }]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Send CockpitSure video ─────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/send-video", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { videoUrl, plate } = req.body;
    if (!videoUrl) return res.status(400).json({ error: "videoUrl required" });
    const row = await getQueueRow(branchId, bay);
    const branchName = await getBranchName(branchId);
    const userId = row?.line_user_id;
    await supabase.from("videos").insert({
      branch_id: branchId, branch_name: branchName,
      plate: (plate || row?.plate || "").toUpperCase(),
      province: row?.province || "",
      video_url: videoUrl, uploaded_at: new Date().toISOString(),
    });
    if (userId) {
      await linePush(branchId, userId, [{
        type: "text",
        text: `🎥 วีดีโอผลการตรวจสภาพ CockpitSure\n\n🚗 ทะเบียน: ${plate || row?.plate}\n📍 ${branchName}\n\n👇 กดดูวีดีโอได้เลยครับ\n${videoUrl}`,
      }]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// HISTORY
// ══════════════════════════════════════════════════════════════
app.get("/api/branch/:branchId/history", async (req, res) => {
  try {
    const { branchId } = req.params;
    const { from, to, limit = 500 } = req.query;
    let query = supabase.from("history").select("*").eq("branch_id", branchId)
      .order("closed_at", { ascending: false }).limit(+limit);
    if (from) query = query.gte("closed_at", new Date(from).toISOString());
    if (to)   query = query.lte("closed_at", new Date(to + "T23:59:59").toISOString());
    const { data, error } = await query;
    if (error) throw error;
    res.json({ history: data || [], branchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/branch/:branchId/history/:historyId/reopen", async (req, res) => {
  try {
    const { branchId, historyId } = req.params;
    const { data: h } = await supabase.from("history")
      .select("*").eq("id", +historyId).eq("branch_id", branchId).single();
    if (!h) return res.status(404).json({ error: "ไม่พบข้อมูล" });

    // หาช่องว่าง
    const { data: occupied } = await supabase.from("queue").select("bay").eq("branch_id", branchId);
    const usedBays = (occupied || []).map(r => r.bay);
    let freeBay = null;
    for (let i = 1; i <= 20; i++) {
      if (!usedBays.includes(String(i))) { freeBay = String(i); break; }
    }
    if (!freeBay) return res.status(400).json({ error: "ไม่มีช่องว่าง" });

    const jobs = (h.jobs || []).map(j =>
      j.name === "รับรถเข้า" ? j : { ...j, status: "waiting" }
    );
    await supabase.from("queue").insert({
      branch_id: branchId, bay: freeBay,
      plate: h.plate, province: h.province || "",
      phone: h.phone || "", line_user_id: h.line_user_id,
      bay_status: "waiting_entry", jobs,
      created_at: new Date().toISOString(),
    });
    await supabase.from("history").delete().eq("id", +historyId);
    res.json({ success: true, bay: freeBay });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// VIDEOS
// ══════════════════════════════════════════════════════════════
app.get("/api/branch/:branchId/videos", async (req, res) => {
  try {
    const { branchId } = req.params;
    const { data } = await supabase.from("videos").select("*").eq("branch_id", branchId)
      .order("uploaded_at", { ascending: false }).limit(60);
    res.json({ videos: data || [], branchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/branch/:branchId/videos/:videoId", async (req, res) => {
  try {
    const { branchId, videoId } = req.params;
    const { data: v } = await supabase.from("videos")
      .select("video_url").eq("id", +videoId).eq("branch_id", branchId).single();
    if (v?.video_url && process.env.CLOUDINARY_API_KEY) {
      const match = v.video_url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
      if (match?.[1]) await cloudinary.uploader.destroy(match[1], { resource_type: "video" })
        .catch(e => console.error("Cloudinary delete:", e.message));
    }
    const { error } = await supabase.from("videos").delete().eq("id", +videoId).eq("branch_id", branchId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// HEALTH
// ══════════════════════════════════════════════════════════════
app.get("/health", (req, res) => res.json({
  status: "ok", ts: new Date().toISOString(),
  env: { supabase: !!process.env.SUPABASE_URL, cloudinary: !!process.env.CLOUDINARY_API_KEY, webapp: WEBAPP_URL },
}));
app.get("/", (req, res) => res.json({ status: "ok", db: "supabase", time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`✅ Cockpit Pro backend (Multi-LINE OA) running on port ${PORT}`));
