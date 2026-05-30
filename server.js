const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;

// ─── Init ─────────────────────────────────────────────────────
const app = express();

app.use(cors({ origin: "*" }));

// Raw body สำหรับ LINE webhook signature verification
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "10mb" }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dnmzyoobh",
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const WEBAPP_URL = process.env.WEBAPP_URL || "https://cockpit-pro-webapp-staging.vercel.app";

// ─── Token Cache (10 นาที) ────────────────────────────────────
// ป้องกัน query Supabase ทุก request
const tokenCache = {};

async function getBranchCreds(branchId) {
  if (tokenCache[branchId]) return tokenCache[branchId];
  const { data, error } = await supabase
    .from("branches")
    .select("id, name, line_channel_id, line_secret, line_token")
    .eq("id", branchId)
    .single();
  if (error || !data) return null;
  tokenCache[branchId] = data;
  setTimeout(function () { delete tokenCache[branchId]; }, 10 * 60 * 1000);
  return data;
}

// หา branchId จาก LINE Channel ID (destination)
async function getBranchByChannelId(channelId) {
  const { data, error } = await supabase
    .from("branches")
    .select("id, name, line_channel_id, line_secret, line_token")
    .eq("line_channel_id", channelId)
    .single();
  if (error || !data) return null;
  return data;
}

// ─── LINE Helpers ─────────────────────────────────────────────
async function linePush(branchId, userId, messages) {
  if (!userId) return;
  const creds = await getBranchCreds(branchId);
  if (!creds || !creds.line_token) {
    console.error("[LINE] No token for branch:", branchId);
    return;
  }
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/push",
      { to: userId, messages },
      {
        headers: {
          Authorization: "Bearer " + creds.line_token,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("[LINE] Push sent to", userId, "via branch", branchId);
  } catch (err) {
    console.error("[LINE] Push error [" + branchId + "]:",
      err.response ? JSON.stringify(err.response.data) : err.message);
  }
}

async function lineReply(branchId, replyToken, messages) {
  if (!replyToken) return;
  const creds = await getBranchCreds(branchId);
  if (!creds || !creds.line_token) return;
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      { replyToken, messages },
      {
        headers: {
          Authorization: "Bearer " + creds.line_token,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("[LINE] Reply error [" + branchId + "]:",
      err.response ? JSON.stringify(err.response.data) : err.message);
  }
}

// ─── LINE Event Handler ───────────────────────────────────────
async function handleLineEvent(event, branchId, branchName) {
  const userId = event.source && event.source.userId;

  // Follow event — ส่งลิงก์ลงทะเบียน
  if (event.type === "follow") {
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await supabase.from("register_tokens").insert({
      token,
      branch_id: branchId,
      line_user_id: userId,
      expires_at: expiresAt,
    });
    const regUrl = WEBAPP_URL + "/register.html?token=" + token;
    await lineReply(branchId, event.replyToken, [
      {
        type: "text",
        text:
          "ยินดีต้อนรับสู่ " + (branchName || "Cockpit Pro") + " 🚗\n" +
          "กรุณาลงทะเบียนทะเบียนรถของคุณที่ลิงก์ด้านล่าง\n" +
          "เพื่อรับการแจ้งเตือนเมื่อรถพร้อม",
      },
      {
        type: "template",
        altText: "ลงทะเบียน Cockpit Pro",
        template: {
          type: "buttons",
          text: "ลงทะเบียนทะเบียนรถ",
          actions: [{ type: "uri", label: "📝 ลงทะเบียน", uri: regUrl }],
        },
      },
    ]);
    return;
  }

  // Message event
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim().toLowerCase();

    if (text === "ลงทะเบียน" || text === "register") {
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await supabase.from("register_tokens").insert({
        token,
        branch_id: branchId,
        line_user_id: userId,
        expires_at: expiresAt,
      });
      const regUrl = WEBAPP_URL + "/register.html?token=" + token;
      await lineReply(branchId, event.replyToken, [
        {
          type: "text",
          text: "คลิกลิงก์ด้านล่างเพื่อลงทะเบียนทะเบียนรถ:\n" + regUrl,
        },
      ]);
      return;
    }

    if (text === "สถานะ" || text === "status") {
      const { data: queue } = await supabase
        .from("queue")
        .select("*")
        .eq("line_user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (queue && queue.length > 0) {
        const q = queue[0];
        const statusTh =
          q.bay_status === "waiting_entry" ? "รอเข้าช่อง" :
          q.bay_status === "in_service" ? "กำลังดำเนินการ" :
          q.bay_status === "done" ? "เสร็จแล้ว" : q.bay_status;
        await lineReply(branchId, event.replyToken, [
          {
            type: "text",
            text:
              "🚗 " + q.plate + " " + (q.province || "") + "\n" +
              "📍 ช่อง " + q.bay + "\n" +
              "⏱ สถานะ: " + statusTh,
          },
        ]);
      } else {
        await lineReply(branchId, event.replyToken, [
          { type: "text", text: "ไม่มีรถในคิวขณะนี้" },
        ]);
      }
      return;
    }
  }
}

// ─── Webhook ──────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // ต้อง return 200 เสมอ ไม่งั้น LINE จะ retry
  res.json({ ok: true });

  let body;
  try {
    body = JSON.parse(req.body.toString());
  } catch (e) {
    console.error("[Webhook] Bad JSON:", e.message);
    return;
  }

  // destination = Channel ID ของ LINE OA ที่รับ event
  const channelId = body.destination;
  if (!channelId) return;

  // หา branch จาก Channel ID
  const branch = await getBranchByChannelId(channelId);
  if (!branch) {
    console.error("[Webhook] Unknown channel ID:", channelId);
    return;
  }

  // Verify signature ด้วย line_secret ของสาขานั้น
  const sig = req.headers["x-line-signature"];
  if (sig && branch.line_secret) {
    const hash = crypto
      .createHmac("sha256", branch.line_secret)
      .update(req.body)
      .digest("base64");
    if (hash !== sig) {
      console.error("[Webhook] Invalid signature for branch:", branch.id);
      return;
    }
  }

  // Process events
  const events = body.events || [];
  for (const event of events) {
    try {
      await handleLineEvent(event, branch.id, branch.name);
    } catch (err) {
      console.error("[Webhook] Event error:", err.message);
    }
  }
});

// ─── Register ─────────────────────────────────────────────────
app.get("/api/register/check", async (req, res) => {
  const { plate, province } = req.query;
  if (!plate || !province) return res.status(400).json({ error: "Missing params" });
  const { data } = await supabase
    .from("line_users")
    .select("user_id")
    .eq("plate", plate.toUpperCase())
    .eq("province", province)
    .single();
  res.json({ registered: !!data, user_id: data ? data.user_id : null });
});

app.get("/api/register/:token", async (req, res) => {
  const { token } = req.params;
  const { data, error } = await supabase
    .from("register_tokens")
    .select("*")
    .eq("token", token)
    .single();
  if (error || !data) return res.status(404).json({ error: "Token not found" });
  if (new Date(data.expires_at) < new Date())
    return res.status(400).json({ error: "Token expired" });
  res.json({ valid: true, line_user_id: data.line_user_id, branch_id: data.branch_id });
});

app.post("/api/register/submit", async (req, res) => {
  const { token, plate, province, phone } = req.body;
  if (!token || !plate || !province)
    return res.status(400).json({ error: "Missing fields" });

  const { data: tokenData, error: tokenErr } = await supabase
    .from("register_tokens")
    .select("*")
    .eq("token", token)
    .single();
  if (tokenErr || !tokenData) return res.status(404).json({ error: "Invalid token" });
  if (new Date(tokenData.expires_at) < new Date())
    return res.status(400).json({ error: "Token expired" });

  const { error: upsertErr } = await supabase.from("line_users").upsert(
    {
      user_id: tokenData.line_user_id,
      plate: plate.toUpperCase(),
      province,
      phone: phone || null,
      branch_id: tokenData.branch_id || null,
    },
    { onConflict: "user_id" }
  );
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  await supabase.from("register_tokens").delete().eq("token", token);

  // แจ้งยืนยันการลงทะเบียน
  if (tokenData.line_user_id && tokenData.branch_id) {
    await linePush(tokenData.branch_id, tokenData.line_user_id, [
      {
        type: "text",
        text:
          "✅ ลงทะเบียนสำเร็จ!\n" +
          "ทะเบียน: " + plate.toUpperCase() + " " + province + "\n" +
          "ระบบจะแจ้งเตือนเมื่อรถพร้อม 🚗",
      },
    ]);
  }

  res.json({ ok: true });
});

// ─── Admin Overview ───────────────────────────────────────────
app.get("/api/admin/overview", async (req, res) => {
  try {
    const { data: branches, error: brErr } = await supabase
      .from("branches")
      .select("id, name, max_bays")
      .order("name");
    if (brErr) return res.status(500).json({ error: brErr.message });

    const { data: allQueue } = await supabase.from("queue").select("*");

    const overview = (branches || []).map(function (b) {
      const bQueue = (allQueue || []).filter(function (q) {
        return q.branch_id === b.id;
      });
      return {
        branchId: b.id,
        name: b.name,
        maxBays: b.max_bays,
        activeQueues: bQueue.length,
        waiting: bQueue.filter(function (q) { return q.bay_status === "waiting_entry"; }).length,
        inService: bQueue.filter(function (q) { return q.bay_status === "in_service"; }).length,
        done: bQueue.filter(function (q) { return q.bay_status === "done"; }).length,
      };
    });

    res.json({ overview });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Branch Data ──────────────────────────────────────────────
app.get("/api/branch/:branchId", async (req, res) => {
  try {
    const { branchId } = req.params;
    const { data: br, error: brErr } = await supabase
      .from("branches")
      .select("id, name, max_bays")
      .eq("id", branchId)
      .single();
    if (brErr || !br) return res.status(404).json({ error: "Branch not found" });

    const { data: rows } = await supabase
      .from("queue")
      .select("*")
      .eq("branch_id", branchId);

    const baysData = {};
    (rows || []).forEach(function (r) {
      baysData[r.bay] = {
        plate: r.plate,
        province: r.province,
        phone: r.phone,
        lineUserId: r.line_user_id,
        bayStatus: r.bay_status || "waiting_entry",
        jobs: r.jobs || [],
        startTime: r.start_time,
        createdAt: r.created_at,
        queueId: r.id,
      };
    });

    res.json({
      id: br.id,
      name: br.name,
      max_bays: br.max_bays,
      baysData,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Open Bay ─────────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/open", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { plate, province, phone } = req.body;
    if (!plate || !province)
      return res.status(400).json({ error: "plate and province required" });

    // ตรวจว่าช่องว่างอยู่
    const { data: existing } = await supabase
      .from("queue")
      .select("id")
      .eq("branch_id", branchId)
      .eq("bay", bay)
      .single();
    if (existing) return res.status(409).json({ error: "Bay already occupied" });

    // หา LINE user
    const { data: lineUser } = await supabase
      .from("line_users")
      .select("user_id")
      .eq("plate", plate.toUpperCase())
      .eq("province", province)
      .single();

    // สร้าง job เริ่มต้น "รับรถเข้า"
    const initialJobs = [{ name: "รับรถเข้า", status: "done", duration: 5 }];

    const { data, error } = await supabase
      .from("queue")
      .insert({
        branch_id: branchId,
        bay: bay,
        plate: plate.toUpperCase(),
        province,
        phone: phone || null,
        line_user_id: lineUser ? lineUser.user_id : null,
        bay_status: "waiting_entry",
        jobs: initialJobs,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    // แจ้งลูกค้า
    if (lineUser) {
      await linePush(branchId, lineUser.user_id, [
        {
          type: "text",
          text:
            "🚗 รับรถของคุณแล้ว\n" +
            "ทะเบียน: " + plate.toUpperCase() + " " + province + "\n" +
            "ช่อง: " + bay + "\n" +
            "กรุณารอสักครู่ เจ้าหน้าที่กำลังดูแลอยู่ค่ะ",
        },
      ]);
    }

    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Add Jobs ─────────────────────────────────────────────────
// รับ jobs เป็น array of strings ["ชื่องาน1", "ชื่องาน2"]
app.post("/api/branch/:branchId/bay/:bay/addjobs", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { jobs: newJobNames } = req.body;
    if (!newJobNames || !Array.isArray(newJobNames))
      return res.status(400).json({ error: "jobs must be array of strings" });

    const { data: row, error: fetchErr } = await supabase
      .from("queue")
      .select("jobs, bay_status")
      .eq("branch_id", branchId)
      .eq("bay", bay)
      .single();
    if (fetchErr || !row) return res.status(404).json({ error: "Queue not found" });

    const JOB_DURATIONS = {
      "เปลี่ยนยาง 4 เส้น": 52, "สลับยาง": 12, "ยาง 1,2,3 เส้น": 20,
      "ถ่วงล้อ": 35, "ตั้งศูนย์ล้อ": 52, "เปลี่ยนถ่ายน้ำมันเครื่อง": 35,
      "เปลี่ยนแบตเตอรี่": 25, "เปลี่ยนเบรก": 52, "CockpitSure": 17,
      "เปลี่ยนโช้คอัพ": 52, "งานซ่อมช่วงล่าง": 135, "เบิกอะไหล่": 85,
      "งานซ่อมอื่น": 75,
    };

    const addedJobs = newJobNames.map(function (name) {
      return { name, status: "waiting", duration: JOB_DURATIONS[name] || 30 };
    });

    const merged = (row.jobs || []).concat(addedJobs);

    const { error } = await supabase
      .from("queue")
      .update({ jobs: merged })
      .eq("branch_id", branchId)
      .eq("bay", bay);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start Work ───────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/start", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { data: row, error: fetchErr } = await supabase
      .from("queue")
      .select("*")
      .eq("branch_id", branchId)
      .eq("bay", bay)
      .single();
    if (fetchErr || !row) return res.status(404).json({ error: "Queue not found" });

    // อัปเดต jobs แรกที่ waiting เป็น in_progress
    const jobs = (row.jobs || []).map(function (j, idx) {
      if (idx === 0 || j.name === "รับรถเข้า") return j;
      return j;
    });

    const { data, error } = await supabase
      .from("queue")
      .update({
        bay_status: "in_service",
        start_time: new Date().toISOString(),
        jobs,
      })
      .eq("branch_id", branchId)
      .eq("bay", bay)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    if (row.line_user_id) {
      await linePush(branchId, row.line_user_id, [
        {
          type: "text",
          text:
            "🔧 เริ่มดำเนินการแล้ว!\n" +
            "รถ: " + row.plate + " " + (row.province || "") + "\n" +
            "ช่อง: " + bay,
        },
      ]);
    }

    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Update Job Status ────────────────────────────────────────
app.patch("/api/branch/:branchId/bay/:bay/job/:jobIdx", async (req, res) => {
  try {
    const { branchId, bay, jobIdx } = req.params;
    const { status } = req.body;
    const validStatuses = ["waiting", "in_progress", "done"];
    if (!validStatuses.includes(status))
      return res.status(400).json({ error: "Invalid status" });

    const { data: row, error: fetchErr } = await supabase
      .from("queue")
      .select("jobs, line_user_id, plate, province")
      .eq("branch_id", branchId)
      .eq("bay", bay)
      .single();
    if (fetchErr || !row) return res.status(404).json({ error: "Queue not found" });

    const jobs = row.jobs || [];
    const idx = Number(jobIdx);
    if (idx < 0 || idx >= jobs.length)
      return res.status(400).json({ error: "Invalid job index" });

    jobs[idx] = Object.assign({}, jobs[idx], { status });

    // ถ้างานทั้งหมด (ยกเว้น รับรถเข้า) เสร็จหมด → เปลี่ยนสถานะเป็น done
    const realJobs = jobs.filter(function (j) { return j.name !== "รับรถเข้า"; });
    const allDone = realJobs.length > 0 && realJobs.every(function (j) { return j.status === "done"; });
    const updateData = { jobs };
    if (allDone) updateData.bay_status = "done";

    const { error } = await supabase
      .from("queue")
      .update(updateData)
      .eq("branch_id", branchId)
      .eq("bay", bay);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true, allDone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Remove Job ───────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/removejob", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { jobIdx } = req.body;

    const { data: row, error: fetchErr } = await supabase
      .from("queue")
      .select("jobs")
      .eq("branch_id", branchId)
      .eq("bay", bay)
      .single();
    if (fetchErr || !row) return res.status(404).json({ error: "Queue not found" });

    const jobs = (row.jobs || []).filter(function (_, i) {
      return i !== Number(jobIdx);
    });

    const { error } = await supabase
      .from("queue")
      .update({ jobs })
      .eq("branch_id", branchId)
      .eq("bay", bay);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Close Bay ────────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/close", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { cancelled, nonotify } = req.body;

    const { data: row, error: fetchErr } = await supabase
      .from("queue")
      .select("*")
      .eq("branch_id", branchId)
      .eq("bay", bay)
      .single();
    if (fetchErr || !row) return res.status(404).json({ error: "Queue not found" });

    const { data: branch } = await supabase
      .from("branches")
      .select("name")
      .eq("id", branchId)
      .single();

    // บันทึกลง history
    await supabase.from("history").insert({
      branch_id: branchId,
      branch_name: branch ? branch.name : null,
      bay: row.bay,
      plate: row.plate,
      province: row.province,
      phone: row.phone,
      line_user_id: row.line_user_id,
      jobs: row.jobs,
      closed_at: new Date().toISOString(),
      cancelled: !!cancelled,
      reopened_at: null,
    });

    // ลบออกจาก queue
    await supabase
      .from("queue")
      .delete()
      .eq("branch_id", branchId)
      .eq("bay", bay);

    // แจ้งลูกค้า (ถ้าไม่ใช่ nonotify และไม่ใช่ cancelled)
    if (row.line_user_id && !cancelled && !nonotify) {
      await linePush(branchId, row.line_user_id, [
        {
          type: "text",
          text:
            "✅ รถพร้อมแล้ว!\n" +
            "🚗 " + row.plate + " " + (row.province || "") + "\n" +
            "งานเสร็จสมบูรณ์ ยินดีต้อนรับมารับรถได้เลยค่ะ 🙏",
        },
      ]);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Notify Customer ──────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/notify", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { message } = req.body;

    const { data: row } = await supabase
      .from("queue")
      .select("line_user_id, plate, province")
      .eq("branch_id", branchId)
      .eq("bay", bay)
      .single();
    if (!row) return res.status(404).json({ error: "Queue not found" });
    if (!row.line_user_id) return res.status(400).json({ error: "No LINE user" });

    const msg = message ||
      "🚗 อัปเดตสถานะรถ " + row.plate + " " + (row.province || "") +
      "\nช่อง: " + bay + "\nกรุณาติดต่อเจ้าหน้าที่";

    await linePush(branchId, row.line_user_id, [{ type: "text", text: msg }]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Quotation (Photo → LINE) ─────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/quote", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { plate, note, photoUrls } = req.body;

    const { data: row } = await supabase
      .from("queue")
      .select("line_user_id, plate, province")
      .eq("branch_id", branchId)
      .eq("bay", bay)
      .single();
    if (!row) return res.status(404).json({ error: "Queue not found" });
    if (!row.line_user_id)
      return res.status(400).json({ error: "No LINE user registered" });

    const messages = [
      {
        type: "text",
        text:
          "📋 ใบเสนอราคา\n" +
          "🚗 " + (plate || row.plate) + " " + (row.province || "") +
          (note ? "\n\n" + note : ""),
      },
    ];

    (photoUrls || []).forEach(function (url) {
      messages.push({ type: "image", originalContentUrl: url, previewImageUrl: url });
    });

    await linePush(branchId, row.line_user_id, messages);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Send Video (CockpitSure) ─────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/send-video", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { videoUrl, plate } = req.body;
    if (!videoUrl) return res.status(400).json({ error: "videoUrl required" });

    const { data: branch } = await supabase
      .from("branches")
      .select("name")
      .eq("id", branchId)
      .single();

    const { data: row } = await supabase
      .from("queue")
      .select("line_user_id, plate, province")
      .eq("branch_id", branchId)
      .eq("bay", bay)
      .single();

    // บันทึกลง videos table
    await supabase.from("videos").insert({
      branch_id: branchId,
      branch_name: branch ? branch.name : null,
      plate: (plate || (row && row.plate) || "").toUpperCase(),
      province: row ? row.province : null,
      video_url: videoUrl,
    });

    // แจ้งลูกค้าผ่าน LINE
    if (row && row.line_user_id) {
      await linePush(branchId, row.line_user_id, [
        {
          type: "text",
          text:
            "🎥 วิดีโอตรวจสภาพรถ CockpitSure พร้อมแล้ว!\n" +
            "🚗 " + (plate || row.plate) + " " + (row.province || "") +
            "\n\n" + videoUrl,
        },
      ]);
    }

    res.json({ ok: true, videoUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── History ──────────────────────────────────────────────────
app.get("/api/branch/:branchId/history", async (req, res) => {
  try {
    const { branchId } = req.params;
    const { from, to } = req.query;

    let query = supabase
      .from("history")
      .select("*")
      .eq("branch_id", branchId)
      .order("closed_at", { ascending: false })
      .limit(500);

    if (from) query = query.gte("closed_at", from);
    if (to) query = query.lte("closed_at", to + "T23:59:59");

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ history: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/branch/:branchId/history/:historyId/reopen", async (req, res) => {
  try {
    const { branchId, historyId } = req.params;

    const { data: hist, error: histErr } = await supabase
      .from("history")
      .select("*")
      .eq("id", Number(historyId))
      .eq("branch_id", branchId)
      .single();
    if (histErr || !hist) return res.status(404).json({ error: "History not found" });

    // หาช่องว่าง
    const { data: branch } = await supabase
      .from("branches")
      .select("max_bays")
      .eq("id", branchId)
      .single();
    const maxBays = (branch && branch.max_bays) || 6;

    const { data: occupied } = await supabase
      .from("queue")
      .select("bay")
      .eq("branch_id", branchId);
    const occupiedSet = new Set((occupied || []).map(function (q) { return q.bay; }));

    let freeBay = null;
    for (let i = 1; i <= maxBays; i++) {
      if (!occupiedSet.has(String(i)) && !occupiedSet.has(i)) {
        freeBay = String(i);
        break;
      }
    }
    if (!freeBay) return res.status(409).json({ error: "All bays occupied" });

    await supabase.from("queue").insert({
      branch_id: branchId,
      bay: freeBay,
      plate: hist.plate,
      province: hist.province,
      phone: hist.phone,
      line_user_id: hist.line_user_id,
      bay_status: "waiting_entry",
      jobs: (hist.jobs || []).map(function (j) {
        return Object.assign({}, j, { status: j.name === "รับรถเข้า" ? "done" : "waiting" });
      }),
    });

    await supabase
      .from("history")
      .update({ reopened_at: new Date().toISOString() })
      .eq("id", Number(historyId));

    res.json({ ok: true, bay: freeBay });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Videos ───────────────────────────────────────────────────
app.get("/api/branch/:branchId/videos", async (req, res) => {
  try {
    const { branchId } = req.params;
    const { data, error } = await supabase
      .from("videos")
      .select("*")
      .eq("branch_id", branchId)
      .order("uploaded_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ videos: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/branch/:branchId/videos/:videoId", async (req, res) => {
  try {
    const { branchId, videoId } = req.params;

    const { data: video } = await supabase
      .from("videos")
      .select("video_url")
      .eq("id", Number(videoId))
      .eq("branch_id", branchId)
      .single();

    // ลบจาก Cloudinary
    if (video && video.video_url) {
      try {
        const parts = video.video_url.split("/");
        const file = parts[parts.length - 1];
        const folder = parts[parts.length - 2];
        const publicId = folder + "/" + file.split(".")[0];
        await cloudinary.uploader.destroy(publicId, { resource_type: "video" });
      } catch (e) {
        console.error("[Cloudinary] Delete error:", e.message);
      }
    }

    const { error } = await supabase
      .from("videos")
      .delete()
      .eq("id", Number(videoId))
      .eq("branch_id", branchId);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Health Check ─────────────────────────────────────────────
app.get("/health", function (req, res) {
  res.json({
    status: "ok",
    ts: new Date().toISOString(),
    env: {
      supabase: !!process.env.SUPABASE_URL,
      cloudinary: !!process.env.CLOUDINARY_API_KEY,
      webapp: process.env.WEBAPP_URL || "not set",
    },
  });
});

// ─── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log("✅ Cockpit Pro backend (Multi-LINE OA) running on port", PORT);
});
