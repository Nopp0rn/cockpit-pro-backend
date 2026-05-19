require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const crypto   = require("crypto");
const line     = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");
const { v2: cloudinary } = require("cloudinary");
const cron     = require("node-cron");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Supabase ───────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Cloudinary ────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD || "dnmzyoobh",
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Monthly video cleanup ─────────────────────────────────────
async function cleanupOldVideos() {
  try {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 1);
    console.log(`🧹 Auto-cleanup: ลบวีดีโอก่อน ${cutoff.toLocaleDateString("th-TH")}`);

    const { data: oldVideos, error } = await supabase.from("videos")
      .select("id, video_url, plate, branch_id")
      .lt("uploaded_at", cutoff.toISOString());

    if (error) { console.error("Cleanup fetch error:", error.message); return; }
    if (!oldVideos?.length) { console.log("✅ ไม่มีวีดีโอเก่า"); return; }

    console.log(`🗑 พบ ${oldVideos.length} วีดีโอที่จะลบ`);
    let deleted = 0, failed = 0;

    for (const v of oldVideos) {
      try {
        // Extract Cloudinary public_id from URL
        const match = v.video_url?.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
        if (match?.[1]) {
          await cloudinary.uploader.destroy(match[1], { resource_type: "video" });
        }
        await supabase.from("videos").delete().eq("id", v.id);
        console.log(`  ✅ ลบแล้ว: ${v.plate} (${v.id})`);
        deleted++;
      } catch (e) {
        console.error(`  ❌ ลบไม่ได้: ${v.plate} — ${e.message}`);
        failed++;
      }
    }
    console.log(`🧹 Cleanup เสร็จ: ลบ ${deleted} คลิป, ล้มเหลว ${failed} คลิป`);
  } catch (e) {
    console.error("Cleanup error:", e.message);
  }
}

// รัน Cleanup ทุกวันที่ 1 เวลา 02:00 น. (ไทย = UTC+7)
// cron: '0 19 1 * *' = 02:00 Thailand (UTC 19:00 วันก่อน)
cron.schedule("0 19 1 * *", () => {
  console.log("⏰ Monthly cleanup triggered");
  cleanupOldVideos();
}, { timezone: "UTC" });

console.log("✅ Monthly video cleanup scheduled (วันที่ 1 ของทุกเดือน 02:00 น.)");


// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use((req, res, next) => {
  req.path === "/webhook"
    ? express.raw({ type: "application/json" })(req, res, next)
    : express.json()(req, res, next);
});

// ── Helpers ───────────────────────────────────────────────────
function getDuration(name) {
  const map = {
    "เปลี่ยนยาง 4 เส้น":52, "สลับยาง":12, "ยาง 1,2,3 เส้น":20,
    "ถ่วงล้อ":35, "ตั้งศูนย์ล้อ":52, "เปลี่ยนถ่ายน้ำมันเครื่อง":35,
    "เปลี่ยนแบตเตอรี่":25, "เปลี่ยนเบรก":52, "CockpitSure":17,
    "เปลี่ยนโช้คอัพ":52, "งานซ่อมช่วงล่าง":135,
    "เบิกอะไหล่":85, "งานซ่อมอื่น":75,
  };
  return map[name] || 30;
}

async function getFreeBay(branchId) {
  const { data } = await supabase.from("queue").select("bay").eq("branch_id", branchId);
  const used = (data || []).map(r => r.bay);
  for (let i = 1; i <= 20; i++) if (!used.includes(String(i))) return String(i);
  return null;
}

async function getBranchName(branchId) {
  const { data } = await supabase.from("branches").select("name").eq("id", branchId).single();
  return data?.name || branchId;
}

async function getQueueRow(branchId, bay) {
  const { data } = await supabase.from("queue")
    .select("*").eq("branch_id", branchId).eq("bay", bay).single();
  return data;
}

// ── LINE ──────────────────────────────────────────────────────
function lineClient(branchId) {
  const token = process.env[`LINE_TOKEN_${branchId}`];
  return token ? new line.messagingApi.MessagingApiClient({ channelAccessToken: token }) : null;
}

async function push(userId, messages, branchId) {
  const client = lineClient(branchId);
  if (!client || !userId) return;
  try { await client.pushMessage({ to: userId, messages }); }
  catch (e) { console.error("LINE:", e.message); }
}

function statusFlex({ plate, branchName, bay, bayStatus, jobs }) {
  const real = jobs.filter(j => j.name !== "รับรถเข้า");
  const done = real.filter(j => j.status === "done").length;
  const pct  = real.length ? Math.round(done / real.length * 100) : 0;
  const st   = bayStatus === "done" ? "✅ เสร็จเรียบร้อย"
             : bayStatus === "in_service" ? "🔧 กำลังดำเนินการ"
             : "⏳ รอเข้าช่องซ่อม";
  const col  = bayStatus === "done" ? "#059669"
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
          { type: "box", layout: "horizontal", contents: [
            { type: "text", text: st, color: col, weight: "bold", size: "md", flex: 1 },
            { type: "text", text: `${pct}%`, color: col, weight: "bold", size: "md", align: "end" },
          ]},
          ...(real.length ? [{
            type: "box", layout: "vertical", backgroundColor: "#f3f4f6",
            cornerRadius: "8px", paddingAll: "12px",
            contents: [
              { type: "text", text: "รายการงาน", size: "xs", color: "#9ca3af", weight: "bold" },
              ...real.map(j => ({
                type: "box", layout: "horizontal", margin: "sm",
                contents: [
                  { type: "text", size: "sm", flex: 0,
                    text: j.status==="done"?"✅":j.status==="in_progress"?"🔧":"⏳" },
                  { type: "text", text: j.name, size: "sm", flex: 1, margin: "sm",
                    decoration: j.status==="done"?"line-through":"none",
                    color: j.status==="done"?"#9ca3af":"#1A1A1A" },
                  { type: "text", text: `${j.duration} นาที`, size: "xs", color: "#9ca3af", align: "end" },
                ],
              })),
            ],
          }] : []),
          { type: "text", text: "ขอบคุณที่ใช้บริการ Cockpit 🙏", size: "xs", color: "#9ca3af", align: "center" },
          ...(bayStatus === "done" ? [{
            type: "text",
            text: "งานเสร็จเรียบร้อย\nหากท่านอยู่ในสาขากรุณารอสักครู่\nพนักงานจะไปพบท่านเพื่อชำระสินค้าและบริการ",
            size: "sm", color: "#1A1A1A", weight: "bold",
            align: "center", wrap: true, margin: "sm",
          }] : []),
        ],
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// WEBHOOK
// ═══════════════════════════════════════════════════════════════
app.post("/webhook", async (req, res) => {
  const sig = req.headers["x-line-signature"];
  const buf = req.body;
  let branchId = null;

  for (const key of Object.keys(process.env).filter(k => k.startsWith("LINE_SECRET_"))) {
    const hash = crypto.createHmac("sha256", process.env[key]).update(buf).digest("base64");
    if (hash === sig) { branchId = key.replace("LINE_SECRET_", ""); break; }
  }
  if (!branchId) return res.sendStatus(200);
  res.sendStatus(200);

  let body; try { body = JSON.parse(buf.toString()); } catch { return; }

  for (const ev of body.events || []) {
    if (ev.type !== "message" || ev.message.type !== "text") continue;
    const userId = ev.source.userId;
    const text   = ev.message.text.trim().toUpperCase().replace(/\s+/g, "");
    if (!/^[ก-ฮ0-9A-Z]{2,10}$/.test(text)) continue;

    await supabase.from("line_users").upsert(
      { user_id: userId, plate: text, branch_id: branchId },
      { onConflict: "user_id" }
    );

    const token   = crypto.randomBytes(16).toString("hex");
    const expires = new Date(Date.now() + 86400000).toISOString();
    await supabase.from("register_tokens")
      .insert({ token, branch_id: branchId, line_user_id: userId, expires_at: expires });

    const base = process.env.WEBAPP_URL || "https://cockpit-pro-webapp.vercel.app";
    const client = lineClient(branchId);
    if (client) {
      await client.replyMessage({
        replyToken: ev.replyToken,
        messages: [{ type: "text",
          text: `🚗 ทะเบียน "${text}"\nกรุณาลงทะเบียนเพื่อเข้าคิว 👇\n${base}/register.html?token=${token}\n\n(ลิงก์ใช้ได้ 24 ชั่วโมง)` }],
      });
    }
  }
});

// ─── Validate register token (called by register.html on load) ───
app.get("/api/register/check", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ valid: false, error: "No token" });

    const { data: tk } = await supabase.from("register_tokens")
      .select("*").eq("token", token).single();

    if (!tk) return res.status(404).json({ valid: false, error: "Token not found" });
    if (new Date(tk.expires_at) < new Date())
      return res.status(400).json({ valid: false, error: "Token expired" });

    const { data: br } = await supabase.from("branches")
      .select("name").eq("id", tk.branch_id).single();

    res.json({
      valid: true,
      branchId: tk.branch_id,
      branchName: br?.name || tk.branch_id,
    });
  } catch (e) { res.status(500).json({ valid: false, error: e.message }); }
});

// ─── Validate token via path param: /api/register/:token (register.html format) ───
app.get("/api/register/:token", async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ valid: false, error: "No token" });

    const { data: tk } = await supabase.from("register_tokens")
      .select("*").eq("token", token).single();

    if (!tk) return res.status(404).json({ valid: false, error: "Token not found" });
    if (new Date(tk.expires_at) < new Date())
      return res.status(400).json({ valid: false, error: "Token expired" });

    const { data: br } = await supabase.from("branches")
      .select("name").eq("id", tk.branch_id).single();

    res.json({
      valid: true,
      branchId: tk.branch_id,
      branchName: br?.name || tk.branch_id,
    });
  } catch (e) { res.status(500).json({ valid: false, error: e.message }); }
});

// ─── Register submit ──────────────────────────────────────────
app.post("/api/register/submit", async (req, res) => {
  try {
    const { token, plate, province, phone } = req.body;
    if (!token || !plate) return res.status(400).json({ error: "token+plate required" });

    const { data: tk } = await supabase.from("register_tokens").select().eq("token", token).single();
    if (!tk || new Date(tk.expires_at) < new Date())
      return res.status(400).json({ error: "Token หมดอายุหรือไม่ถูกต้อง" });

    const { branch_id: branchId, line_user_id: userId } = tk;

    await supabase.from("line_users").upsert(
      { user_id: userId, plate, province: province||"", phone: phone||"", branch_id: branchId },
      { onConflict: "user_id" }
    );

    const bay = await getFreeBay(branchId);
    if (!bay) return res.status(400).json({ error: "ไม่มีช่องว่าง" });

    const jobs = [{ name: "รับรถเข้า", duration: 5, status: "waiting" }];
    await supabase.from("queue").insert({
      branch_id: branchId, bay, plate,
      province: province||"", phone: phone||"",
      line_user_id: userId, bay_status: "waiting_entry", jobs,
    });
    await supabase.from("register_tokens").delete().eq("token", token);

    const branchName = await getBranchName(branchId);
    await push(userId, [statusFlex({ plate, branchName, bay, bayStatus:"waiting_entry", jobs })], branchId);
    res.json({ success: true, bay });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN OVERVIEW
// ═══════════════════════════════════════════════════════════════
app.get("/api/admin/overview", async (req, res) => {
  try {
    const { data: branches } = await supabase.from("branches").select("*");
    const overview = await Promise.all((branches||[]).map(async br => {
      const { count } = await supabase.from("queue")
        .select("*", { count:"exact", head:true }).eq("branch_id", br.id);
      return { branchId: br.id, name: br.name, activeQueues: count||0 };
    }));
    res.json({ overview });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// BRANCH DATA
// ═══════════════════════════════════════════════════════════════
app.get("/api/branch/:branchId", async (req, res) => {
  try {
    const { branchId } = req.params;
    const { data: br } = await supabase.from("branches").select("*").eq("id", branchId).single();
    if (!br) return res.status(404).json({ error: "Branch not found" });
    const { data: rows } = await supabase.from("queue").select("*").eq("branch_id", branchId);
    const baysData = {};
    (rows||[]).forEach(r => {
      baysData[r.bay] = {
        plate: r.plate, province: r.province, phone: r.phone,
        userId: r.line_user_id, bayStatus: r.bay_status,
        jobs: r.jobs||[], startTime: r.start_time,
      };
    });
    res.json({ ...br, baysData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Open bay ─────────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/open", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { plate, province, phone, userId } = req.body;
    if (!plate) return res.status(400).json({ error: "plate required" });
    const jobs = [{ name:"รับรถเข้า", duration:5, status:"waiting" }];
    await supabase.from("queue").upsert(
      { branch_id:branchId, bay, plate, province:province||"",
        phone:phone||"", line_user_id:userId||null,
        bay_status:"waiting_entry", jobs },
      { onConflict:"branch_id,bay" }
    );
    if (userId) {
      const branchName = await getBranchName(branchId);
      await push(userId, [statusFlex({ plate, branchName, bay, bayStatus:"waiting_entry", jobs })], branchId);
    }
    res.json({ success: true, bay });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start service ────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/start", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const row = await getQueueRow(branchId, bay);
    if (!row) return res.status(404).json({ error: "Not found" });
    await supabase.from("queue")
      .update({ bay_status:"in_service", start_time: new Date().toISOString() })
      .eq("branch_id", branchId).eq("bay", bay);
    const branchName = await getBranchName(branchId);
    await push(row.line_user_id, [statusFlex({ plate:row.plate, branchName, bay, bayStatus:"in_service", jobs:row.jobs })], branchId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Update job ───────────────────────────────────────────────
app.patch("/api/branch/:branchId/bay/:bay/job/:jobIdx", async (req, res) => {
  try {
    const { branchId, bay, jobIdx } = req.params;
    const { status } = req.body;
    const row = await getQueueRow(branchId, bay);
    if (!row) return res.status(404).json({ error: "Not found" });
    const jobs = [...(row.jobs||[])];
    if (!jobs[+jobIdx]) return res.status(400).json({ error: "Invalid index" });
    jobs[+jobIdx] = { ...jobs[+jobIdx], status };
    await supabase.from("queue").update({ jobs }).eq("branch_id", branchId).eq("bay", bay);
    const branchName = await getBranchName(branchId);
    await push(row.line_user_id, [statusFlex({ plate:row.plate, branchName, bay, bayStatus:row.bay_status, jobs })], branchId);
    res.json({ success:true, jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Add jobs ─────────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/addjobs", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { jobs: names } = req.body;
    const row = await getQueueRow(branchId, bay);
    if (!row) return res.status(404).json({ error: "Not found" });
    const existing = (row.jobs||[]).map(j => j.name);
    const added = (names||[]).filter(n => !existing.includes(n))
      .map(n => ({ name:n, duration:getDuration(n), status:"waiting" }));
    const jobs = [...(row.jobs||[]), ...added];
    await supabase.from("queue").update({ jobs }).eq("branch_id", branchId).eq("bay", bay);
    const branchName = await getBranchName(branchId);
    await push(row.line_user_id, [statusFlex({ plate:row.plate, branchName, bay, bayStatus:row.bay_status, jobs })], branchId);
    res.json({ success:true, jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Remove job ───────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/removejob", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { jobIdx, nonotify } = req.body;
    const row = await getQueueRow(branchId, bay);
    if (!row) return res.status(404).json({ error: "Not found" });
    const jobs = (row.jobs||[]).filter((_, i) => i !== +jobIdx);
    if (!jobs.length) return res.status(400).json({ error: "Cannot remove all" });
    await supabase.from("queue").update({ jobs }).eq("branch_id", branchId).eq("bay", bay);
    if (!nonotify) {
      const branchName = await getBranchName(branchId);
      await push(row.line_user_id, [statusFlex({ plate:row.plate, branchName, bay, bayStatus:row.bay_status, jobs })], branchId);
    }
    res.json({ success:true, remainingJobs: jobs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Close / Cancel ───────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/close", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { nonotify } = req.body;
    const row = await getQueueRow(branchId, bay);
    if (!row) return res.status(404).json({ error: "Not found" });
    const branchName = await getBranchName(branchId);
    const doneJobs = (row.jobs||[]).map(j => ({ ...j, status:"done" }));

    await supabase.from("history").insert({
      branch_id:branchId, branch_name:branchName, bay,
      plate:row.plate, province:row.province, phone:row.phone,
      line_user_id:row.line_user_id, jobs:doneJobs,
      closed_at: new Date().toISOString(), cancelled:!!nonotify,
    });
    await supabase.from("queue").delete().eq("branch_id", branchId).eq("bay", bay);
    res.json({ success:true });

    if (!nonotify && row.line_user_id) {
      await push(row.line_user_id, [statusFlex({
        plate: row.plate, branchName, bay,
        bayStatus: "done", jobs: doneJobs,
      })], branchId);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Notify manual ────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/notify", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const row = await getQueueRow(branchId, bay);
    if (!row) return res.status(404).json({ error: "Not found" });
    const branchName = await getBranchName(branchId);
    await push(row.line_user_id, [statusFlex({ plate:row.plate, branchName, bay, bayStatus:row.bay_status, jobs:row.jobs })], branchId);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Send CockpitSure video ───────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/send-video", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { videoUrl, plate } = req.body;
    if (!videoUrl) return res.status(400).json({ error: "videoUrl required" });
    const row = await getQueueRow(branchId, bay);
    const branchName = await getBranchName(branchId);
    const userId = row?.line_user_id;

    await supabase.from("videos").insert({
      branch_id:branchId, branch_name:branchName,
      plate: plate||row?.plate||"", province: row?.province||"",
      video_url: videoUrl, uploaded_at: new Date().toISOString(),
    });

    if (userId) {
      await push(userId, [{
        type:"text",
        text:`🎥 วีดีโอผลการตรวจสภาพ CockpitSure\n\n🚗 ทะเบียน: ${plate||row?.plate}\n📍 ${branchName}\n\n👇 กดดูวีดีโอได้เลยครับ\n${videoUrl}`,
      }], branchId);
    }
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════════════════════
app.get("/api/branch/:branchId/history", async (req, res) => {
  try {
    const { branchId } = req.params;
    const { from, to, limit = 500 } = req.query;
    let query = supabase.from("history")
      .select("*").eq("branch_id", branchId)
      .order("closed_at", { ascending: false })
      .limit(+limit);
    if (from) query = query.gte("closed_at", new Date(from).toISOString());
    if (to)   query = query.lte("closed_at", new Date(to + "T23:59:59").toISOString());
    const { data, error } = await query;
    if (error) throw error;
    res.json({ history: data||[], branchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Reopen from history ──────────────────────────────────────
app.post("/api/branch/:branchId/history/:historyId/reopen", async (req, res) => {
  try {
    const { branchId, historyId } = req.params;
    const { data: h } = await supabase.from("history")
      .select("*").eq("id", +historyId).eq("branch_id", branchId).single();
    if (!h) return res.status(404).json({ error: "ไม่พบข้อมูล" });

    const isSameDay = new Date(h.closed_at).toDateString() === new Date().toDateString();
    if (!isSameDay) return res.status(400).json({ error: "คืนสถานะได้เฉพาะวันเดียวกัน" });

    const bay = await getFreeBay(branchId) || h.bay;
    const { data: existing } = await supabase.from("queue")
      .select("id").eq("branch_id", branchId).eq("bay", bay).single();
    if (existing) return res.status(400).json({ error: "ช่องเต็ม ลองใหม่" });

    const jobs = (h.jobs||[]).map(j =>
      j.name === "รับรถเข้า" ? j : { ...j, status:"waiting" }
    );
    await supabase.from("queue").insert({
      branch_id: branchId, bay,
      plate: h.plate, province: h.province||"",
      phone: h.phone||"", line_user_id: h.line_user_id,
      bay_status: "waiting_entry", jobs,
      created_at: new Date().toISOString(),
    });
    await supabase.from("history").delete().eq("id", +historyId);
    res.json({ success:true, bay });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// VIDEOS
// ═══════════════════════════════════════════════════════════════
app.get("/api/branch/:branchId/videos", async (req, res) => {
  try {
    const { branchId } = req.params;
    const { data } = await supabase.from("videos")
      .select("*").eq("branch_id", branchId)
      .order("uploaded_at", { ascending:false }).limit(60);
    res.json({ videos: data||[], branchId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE video by id (ลบจาก Supabase + Cloudinary)
app.delete("/api/branch/:branchId/videos/:videoId", async (req, res) => {
  try {
    const { branchId, videoId } = req.params;
    const { data: v } = await supabase.from("videos")
      .select("video_url").eq("id", +videoId).eq("branch_id", branchId).single();

    // ลบจาก Cloudinary
    if (v?.video_url && process.env.CLOUDINARY_API_KEY) {
      const match = v.video_url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
      if (match?.[1]) {
        await cloudinary.uploader.destroy(match[1], { resource_type: "video" })
          .catch(e => console.error("Cloudinary delete:", e.message));
      }
    }

    // ลบจาก Supabase
    const { error } = await supabase.from("videos")
      .delete().eq("id", +videoId).eq("branch_id", branchId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════════
app.get("/", (req, res) => res.json({ status:"ok", db:"supabase", time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`✅ Cockpit Pro (Supabase) running on port ${PORT}`));
