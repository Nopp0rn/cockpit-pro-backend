require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const crypto   = require("crypto");
const line     = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");
const { v2: cloudinary } = require("cloudinary");
const cron     = require("node-cron");

const app  = express();

// ─── Micro-cache ลดโควตา Supabase (2026-07-28) ─────────────────────────────
//   ปัญหา: หน้าจอคิวหลายเครื่องที่เปิดสาขาเดียวกัน ต่างคนต่าง poll
//          ทำให้ยิง Supabase ซ้ำด้วยข้อมูลชุดเดียวกันหลายรอบต่อวินาที
//   วิธี:  พักคำตอบไว้ในหน่วยความจำแป๊บหนึ่ง ถ้ามีคำขอเดิมเข้ามาในช่วงนั้นก็ใช้ของเดิมตอบ
//          → หลายเครื่องยุบเหลือ query เดียว โดยข้อมูลยังสดในระดับวินาที
const _cache = new Map();
async function cached(key, ttlMs, producer) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && hit.exp && now < hit.exp) return hit.val;
  if (hit && hit.pending) return hit.pending;          // มีคำขอเดิมวิ่งอยู่ รอผลอันเดียวกัน
  const pending = (async () => {
    const val = await producer();
    _cache.set(key, { val, exp: Date.now() + ttlMs });
    return val;
  })();
  _cache.set(key, { pending });
  return pending;
}
// ล้าง cache ของสาขาเมื่อข้อมูลเปลี่ยน เพื่อให้เห็นผลทันทีไม่ต้องรอ TTL
function invalidateBranch(branchId) {
  _cache.delete(`branch:${branchId}`);
  _cache.delete("overview");
}

const PORT = process.env.PORT || 3001;

// ── Supabase ───────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Cloudinary ────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dd7fg1swh",
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Mascot (แสดงในการ์ดแจ้งเตือน LINE) ────────────────────────
// วางไฟล์ mascot-card.png ไว้ใน public/ ของ frontend (Vercel) แล้ว deploy
// หรือกำหนด MASCOT_URL ผ่าน ENV ก็ได้
// หมายเหตุ: LINE cache รูป Flex ตาม URL — ถ้าเปลี่ยนรูปให้เพิ่มเลข ?v= เพื่อบังคับโหลดใหม่
const MASCOT_VERSION = "1";
const MASCOT_URL = process.env.MASCOT_URL
  || `${(process.env.WEBAPP_URL || "https://cockpit-pro-webapp.vercel.app").replace(/\/$/, "")}/mascot-card.png?v=${MASCOT_VERSION}`;

// ── LINE (Multi-Bot per Branch) ───────────────────────────────
// ใช้ LINE_SECRET_BRXXX / LINE_TOKEN_BRXXX ต่อ branch
// หาก branch ไม่มี token ของตัวเอง ให้ใช้ LINE_SECRET / LINE_TOKEN fallback

function getLineToken(branchId) {
  const key = branchId ? `LINE_TOKEN_${branchId.toUpperCase()}` : null;
  return (key && process.env[key]) || process.env.LINE_TOKEN || null;
}

function getLineSecret(branchId) {
  const key = branchId ? `LINE_SECRET_${branchId.toUpperCase()}` : null;
  return (key && process.env[key]) || process.env.LINE_SECRET || null;
}

function getLineClient(branchId) {
  const token = getLineToken(branchId);
  if (!token) {
    console.warn(`⚠️  LINE_TOKEN ไม่พบสำหรับ branch ${branchId} — LINE push ถูกปิดใช้งาน`);
    return null;
  }
  return new line.messagingApi.MessagingApiClient({ channelAccessToken: token });
}

async function push(userId, messages, branchId) {
  if (!userId) return;
  const client = getLineClient(branchId);
  if (!client) return;
  try { await client.pushMessage({ to: userId, messages }); }
  catch (e) { console.error(`LINE push error (${branchId}):`, e.message); }
}

// ── ค้นหา branchId จาก line_users สำหรับ webhook reply ──────
async function getBranchIdForWebhookReply(branchId, userId) {
  // ถ้ารู้ branchId จาก webhook destination แล้วให้ใช้เลย
  if (branchId) return branchId;
  // fallback: ค้นจาก line_users
  const { data } = await supabase.from("line_users")
    .select("branch_id").eq("user_id", userId).maybeSingle();
  return data?.branch_id || null;
}

// ── Daily cleanup: ลบข้อมูลลูกค้า (line_users, register_tokens) ──────────
async function cleanupCustomerData() {
  try {
    console.log("🧹 Daily PDPA cleanup: ลบข้อมูลลูกค้าประจำวัน...");

    // ลบ register_tokens ที่หมดอายุแล้ว
    const { error: e1, count: c1 } = await supabase.from("register_tokens")
      .delete({ count: "exact" })
      .lt("expires_at", new Date().toISOString());
    if (e1) console.error("register_tokens cleanup error:", e1.message);
    else console.log(`  ✅ ลบ register_tokens หมดอายุ: ${c1||0} รายการ`);

    // ลบ line_users ทั้งหมด (ไม่เก็บข้อมูลส่วนตัวลูกค้าค้างคืน)
    const { error: e2, count: c2 } = await supabase.from("line_users")
      .delete({ count: "exact" })
      .not("user_id", "is", null);
    if (e2) console.error("line_users cleanup error:", e2.message);
    else console.log(`  ✅ ลบ line_users: ${c2||0} รายการ`);

    console.log("✅ Daily PDPA cleanup เสร็จสมบูรณ์");
  } catch (e) {
    console.error("Daily cleanup error:", e.message);
  }
}

// ── Video cleanup: ลบวีดีโอที่เก่ากว่า 24 ชม. อัตโนมัติ (PDPA) ──
async function cleanupOldVideos() {
  try {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - 24);
    console.log(`🧹 Auto-cleanup: ลบวีดีโอที่เก่ากว่า 24 ชม. (ก่อน ${cutoff.toLocaleString("th-TH")})`);

    const { data: oldVideos, error } = await supabase.from("videos")
      .select("id, video_url, plate, branch_id")
      .lt("uploaded_at", cutoff.toISOString());

    if (error) { console.error("Cleanup fetch error:", error.message); return; }
    if (!oldVideos?.length) { console.log("✅ ไม่มีวีดีโอเก่า"); return; }

    console.log(`🗑 พบ ${oldVideos.length} วีดีโอที่จะลบ`);
    let deleted = 0, failed = 0;

    for (const v of oldVideos) {
      try {
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

// รัน Daily PDPA Cleanup ทุกวัน 23:00 น. ไทย (UTC+7 → cron UTC 16:00)
cron.schedule("0 16 * * *", () => {
  console.log("⏰ Daily PDPA cleanup triggered");
  cleanupCustomerData();
}, { timezone: "UTC" });

console.log("✅ Daily PDPA cleanup scheduled (ทุกวัน 23:00 น. ไทย — ลบ line_users + register_tokens)");

// รัน Video Cleanup ทุกชั่วโมง (ลบวีดีโอที่เก่ากว่า 24 ชม.)
cron.schedule("0 * * * *", () => {
  console.log("⏰ Hourly video cleanup triggered");
  cleanupOldVideos();
}, { timezone: "UTC" });

console.log("✅ Video cleanup scheduled (ทุกชั่วโมง — ลบวีดีโอเก่ากว่า 24 ชม.)");


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
    .select("*").eq("branch_id", branchId).eq("bay", bay).maybeSingle();
  return data;
}

// ── ค้นหา branchId ของ LINE userId จากตาราง line_users ────────
// ใช้สำหรับ Webhook แบบ single bot
async function getBranchIdByUserId(userId) {
  const { data } = await supabase.from("line_users")
    .select("branch_id").eq("user_id", userId).maybeSingle();
  return data?.branch_id || null;
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
      size: "giga",
      header: {
        type: "box", layout: "horizontal", backgroundColor: "#1A1A1A",
        paddingAll: "18px", spacing: "md",
        contents: [
          { type: "box", layout: "vertical", flex: 3, justifyContent: "center", contents: [
            { type: "text", text: "🚗 Cockpit Pro – สถานะรถของคุณ", color: "#FFE000", size: "xs", weight: "bold", wrap: true },
            { type: "text", text: plate, color: "#FFFFFF", size: "3xl", weight: "bold" },
            { type: "text", text: `${branchName} · ช่องที่ ${bay}`, color: "#9ca3af", size: "sm", wrap: true },
          ]},
          { type: "image", url: MASCOT_URL, flex: 2,
            aspectMode: "fit", aspectRatio: "1:1.05", gravity: "bottom", align: "end" },
        ],
      },
      body: {
        type: "box", layout: "vertical", spacing: "lg", paddingAll: "20px",
        contents: [
          { type: "box", layout: "horizontal", contents: [
            { type: "text", text: st, color: col, weight: "bold", size: "lg", flex: 1 },
            { type: "text", text: `${pct}%`, color: col, weight: "bold", size: "lg", align: "end" },
          ]},
          ...(real.length ? [{
            type: "box", layout: "vertical", backgroundColor: "#f3f4f6",
            cornerRadius: "8px", paddingAll: "14px",
            contents: [
              { type: "text", text: "รายการงาน", size: "sm", color: "#9ca3af", weight: "bold" },
              ...real.map(j => ({
                type: "box", layout: "horizontal", margin: "md",
                contents: [
                  { type: "text", size: "md", flex: 0,
                    text: j.status==="done"?"✅":j.status==="in_progress"?"🔧":"⏳" },
                  { type: "text", text: j.name, size: "md", flex: 1, margin: "sm",
                    decoration: j.status==="done"?"line-through":"none",
                    color: j.status==="done"?"#9ca3af":"#1A1A1A" },
                  { type: "text", text: `${j.duration} นาที`, size: "sm", color: "#9ca3af", align: "end" },
                ],
              })),
            ],
          }] : []),
          { type: "text", text: "ขอบคุณที่ใช้บริการ Cockpit 🙏", size: "sm", color: "#9ca3af", align: "center" },
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
// WEBHOOK  (Multi-Bot — verify ต่อ branch)
// ═══════════════════════════════════════════════════════════════
app.post("/webhook", async (req, res) => {
  _cache.clear();   // ข้อมูลคิวอาจเปลี่ยนจากฝั่ง LINE — ล้าง cache ทั้งหมด
  const sig = req.headers["x-line-signature"];
  const buf = req.body;

  // ── หา branch ที่ตรงกับ signature ───────────────────────────
  // โหลด secrets ทุก branch แล้วลอง verify ทีละตัว
  let matchedBranchId = null;
  let matchedSecret   = null;

  // รวบรวม secrets ทั้งหมดจาก env
  const branchSecrets = [];
  // per-branch secrets (LINE_SECRET_BRXXX)
  for (const [key, val] of Object.entries(process.env)) {
    const m = key.match(/^LINE_SECRET_(.+)$/);
    if (m && val) branchSecrets.push({ branchId: m[1], secret: val });
  }
  // fallback single secret
  if (process.env.LINE_SECRET) {
    branchSecrets.push({ branchId: null, secret: process.env.LINE_SECRET });
  }

  if (!branchSecrets.length) {
    console.warn("⚠️  ไม่มี LINE_SECRET ใดตั้งค่าไว้");
    return res.sendStatus(200);
  }

  for (const { branchId, secret } of branchSecrets) {
    const hash = crypto.createHmac("sha256", secret).update(buf).digest("base64");
    if (hash === sig) {
      matchedBranchId = branchId;
      matchedSecret   = secret;
      break;
    }
  }

  if (!matchedSecret) {
    console.warn("⚠️  LINE webhook signature ไม่ตรงกับ branch ใดเลย — ละเว้น");
    return res.sendStatus(200);
  }

  res.sendStatus(200); // ตอบ LINE ก่อนเสมอ

  let body; try { body = JSON.parse(buf.toString()); } catch { return; }

  for (const ev of body.events || []) {
    if (ev.type !== "message" || ev.message.type !== "text") continue;
    const userId = ev.source.userId;
    const text   = ev.message.text.trim().toUpperCase().replace(/\s+/g, "");
    if (!/^[ก-ฮ0-9A-Z]{2,10}$/.test(text)) continue;

    // ── ค้นหา branchId ที่ user เคยลงทะเบียนไว้ ───────────────
    const existingBranchId = await getBranchIdByUserId(userId);
    // ใช้ branchId จาก webhook ถ้ามี มิเช่นนั้นใช้จาก line_users
    const branchIdForToken = matchedBranchId || existingBranchId;

    await supabase.from("line_users").upsert(
      { user_id: userId, plate: text, ...(existingBranchId ? { branch_id: existingBranchId } : {}) },
      { onConflict: "user_id" }
    );

    const token   = crypto.randomBytes(16).toString("hex");
    const expires = new Date(Date.now() + 86400000).toISOString();
    // FIX: ใช้ branchIdForToken (matchedBranchId || existingBranchId)
    // เพื่อให้ user ใหม่ที่ยังไม่มีใน line_users ได้รับ branch_id ที่ถูกต้อง
    await supabase.from("register_tokens")
      .insert({ token, branch_id: branchIdForToken, line_user_id: userId, expires_at: expires });

    const base = process.env.WEBAPP_URL || "https://cockpit-pro-webapp.vercel.app";
    const msgText = `🚗 ทะเบียน "${text}"\nกรุณาลงทะเบียนเพื่อเข้าคิว 👇\n${base}/register.html?token=${token}\n\n(ลิงก์ใช้ได้ 24 ชั่วโมง)`;
    const msgPayload = [{ type: "text", text: msgText }];

    // FIX: ใช้ pushMessage แทน replyMessage
    // replyToken expire ใน 30 วินาที — ถ้า Render server sleep แล้ว wake up ช้า link จะไม่ถูกส่ง
    // pushMessage ใช้ userId โดยตรง ไม่มี time limit
    try {
      await push(userId, msgPayload, branchIdForToken);
    } catch (pushErr) {
      console.error(`❌ push register link failed (${branchIdForToken}):`, pushErr.message);
      try {
        const replyClient = getLineClient(branchIdForToken);
        if (replyClient) {
          await replyClient.replyMessage({ replyToken: ev.replyToken, messages: msgPayload });
        }
      } catch (replyErr) {
        console.error(`❌ reply fallback also failed (${branchIdForToken}):`, replyErr.message);
      }
    }
  }
});

// ─── Validate register token (called by register.html on load) ───
app.get("/api/register/check", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ valid: false, error: "No token" });

    const { data: tk } = await supabase.from("register_tokens")
      .select("*").eq("token", token).maybeSingle();

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

// ─── Validate token via path param: /api/register/:token ───────
app.get("/api/register/:token", async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ valid: false, error: "No token" });

    const { data: tk } = await supabase.from("register_tokens")
      .select("*").eq("token", token).maybeSingle();

    if (!tk) return res.status(404).json({ valid: false, error: "Token not found" });
    if (new Date(tk.expires_at) < new Date())
      return res.status(400).json({ valid: false, error: "Token expired" });


    // FIX: ป้องกัน token เก่าที่มี branch_id = null
    if (!tk.branch_id)
      return res.status(400).json({ valid: false, error: "Token ไม่มีสาขา กรุณาขอลิงก์ใหม่" });
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

    const { data: tk } = await supabase.from("register_tokens").select().eq("token", token).maybeSingle();
    if (!tk || new Date(tk.expires_at) < new Date())
      return res.status(400).json({ error: "Token หมดอายุหรือไม่ถูกต้อง" });

    const { branch_id: branchId, line_user_id: userId } = tk;
    // FIX: ป้องกัน branchId เป็น null (เกิดจาก bug เก่าที่ token ถูกสร้างโดยไม่มี branch_id)
    if (!branchId) return res.status(400).json({ error: "ไม่พบสาขา กรุณาขอลิงก์ใหม่" });

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
    // 2026-07-27 (ลดโควตา Supabase):
    //   เดิมวน count ทีละสาขา = ยิง Supabase 1 ครั้งต่อสาขา (16 สาขา = 16 request ต่อการเรียก 1 ครั้ง)
    //   หน้ารวมสาขา refresh ทุก 15 วิ จึงกลายเป็นทราฟฟิกก้อนใหญ่ที่สุดของโปรเจกต์
    //   เปลี่ยนเป็นดึง branch_id ของคิวทั้งหมดครั้งเดียวแล้วนับในหน่วยความจำ → 16 request เหลือ 1
    //   (ตาราง queue มีไม่กี่สิบแถว payload เล็กกว่าเดิมมาก)
    const overview = await cached("overview", 10000, async () => {
      const [{ data: branches }, { data: qrows }] = await Promise.all([
        supabase.from("branches").select("id,name"),
        supabase.from("queue").select("branch_id"),
      ]);
      const counts = {};
      (qrows||[]).forEach(r => { counts[r.branch_id] = (counts[r.branch_id]||0) + 1; });
      return (branches||[]).map(br => ({
        branchId: br.id, name: br.name, activeQueues: counts[br.id]||0,
      }));
    });
    res.json({ overview });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// BRANCH DATA
// ═══════════════════════════════════════════════════════════════
app.get("/api/branch/:branchId", async (req, res) => {
  try {
    const { branchId } = req.params;
    // 2026-07-27 (ลดโควตา Supabase):
    //   เดิมหน้าจอคิวเรียก 2 endpoint ทุกรอบ (branch + history?limit=50)
    //   ทั้งที่ history เอาไปใช้แค่ "ของวันนี้" เพื่อโชว์ปุ่มคืนสถานะ
    //   จึงรวมมาไว้ใน response เดียว และให้ Postgres กรองเฉพาะวันนี้ตั้งแต่ต้นทาง
    //   ผล: request ต่อรอบลดครึ่ง + payload เล็กลงมาก (เดิมดึง 50 แถวข้ามวัน)
    // cache 8 วินาที — จอหลายเครื่องที่ดูสาขาเดียวกันใช้ผลร่วมกัน ยิง Supabase ครั้งเดียว
    // (มี invalidateBranch() ในทุก endpoint ที่แก้ข้อมูล จึงเห็นการเปลี่ยนแปลงทันทีไม่ต้องรอ TTL)
    const payload = await cached(`branch:${branchId}`, 8000, async () => {
      const startOfToday = new Date(); startOfToday.setHours(0,0,0,0);
      const [{ data: br }, { data: rows }, { data: hist }] = await Promise.all([
        supabase.from("branches").select("id,name").eq("id", branchId).maybeSingle(),
        supabase.from("queue")
          .select("bay,plate,province,phone,line_user_id,bay_status,jobs,start_time")
          .eq("branch_id", branchId),
        supabase.from("history")
          .select("id,plate,province,jobs,closed_at,cancelled,bay")
          .eq("branch_id", branchId)
          .gte("closed_at", startOfToday.toISOString())
          .order("closed_at", { ascending: false }),
      ]);
      if (!br) return null;
      const baysData = {};
      (rows||[]).forEach(r => {
        baysData[r.bay] = {
          plate: r.plate, province: r.province, phone: r.phone,
          userId: r.line_user_id, bayStatus: r.bay_status,
          jobs: r.jobs||[], startTime: r.start_time,
        };
      });
      return { ...br, baysData, todayHistory: (hist||[]).filter(h => !h.cancelled) };
    });
    if (!payload) return res.status(404).json({ error: "Branch not found" });
    res.json(payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Open bay ─────────────────────────────────────────────────
app.post("/api/branch/:branchId/bay/:bay/open", async (req, res) => {
  invalidateBranch(req.params.branchId);   // ล้าง cache ให้เห็นผลทันที
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
  invalidateBranch(req.params.branchId);   // ล้าง cache ให้เห็นผลทันที
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
  invalidateBranch(req.params.branchId);   // ล้าง cache ให้เห็นผลทันที
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
  invalidateBranch(req.params.branchId);   // ล้าง cache ให้เห็นผลทันที
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
  invalidateBranch(req.params.branchId);   // ล้าง cache ให้เห็นผลทันที
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
  invalidateBranch(req.params.branchId);   // ล้าง cache ให้เห็นผลทันที
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

// ─── Video compression + iOS-safe delivery ──────────────────────────
// เดิม: rename นามสกุลเป็น .mp4 เฉยๆ แล้วปล่อยให้ Cloudinary auto-transcode
// ตอน request แรก — ไฟล์ใหญ่ + transcode ครั้งแรกช้า ทำให้ iOS Safari
// (timeout ไวกว่า) โหลดวิดีโอไม่ขึ้นเป็นบางเครื่อง แก้โดย:
//   1. แทรก transformation บีบ bitrate/บังคับ codec h264+aac ที่เข้ากับ LINE/iOS
//   2. "อุ่น" URL ด้วย GET request จากฝั่ง server ก่อนส่งลิงก์ให้ลูกค้า
//      เพื่อให้ Cloudinary transcode เสร็จและแคชไว้แล้ว ลูกค้าเปิดแล้วเล่นได้ทันที
const VIDEO_MAX_BITRATE_KBPS = parseInt(process.env.VIDEO_MAX_BITRATE_KBPS || "600", 10);

// 2026-07-29 (ลดโควตา Cloudinary):
//   แอปฝั่งหน้าจอบันทึกวีดีโอเป็น H.264/AAC 854x480 ที่ 600kbps มาให้อยู่แล้ว
//   (ดู MediaRecorder ใน cockpit-dashboard.jsx) ตรวจข้อมูลจริงแล้วพบว่าเป็น .mp4 ทั้ง 100%
//   การให้ Cloudinary แปลงซ้ำเป็น 600kbps h264 อีกรอบจึงไม่ได้อะไรเลย
//   นอกจากเปลืองเครดิต "video transformation" และทำให้ภาพแย่ลงจากการเข้ารหัสสองชั้น
//   จึงส่งไฟล์ต้นฉบับให้เลยถ้าเป็น mp4 อยู่แล้ว — แปลงเฉพาะไฟล์ webm/mov ที่ LINE/iOS เล่นไม่ได้
function buildOptimizedVideoUrl(originalUrl) {
  if (!originalUrl) return originalUrl;
  if (/\.mp4($|\?)/i.test(originalUrl)) return originalUrl;   // เล่นได้อยู่แล้ว ไม่ต้องแปลง
  const mp4Url = originalUrl.replace(/\.(mov|webm|m4v)$/i, ".mp4");
  const transform = `q_auto:low,vc_h264,ac_aac,br_${VIDEO_MAX_BITRATE_KBPS}k`;
  return mp4Url.replace("/upload/", `/upload/${transform}/`);
}

// ต้องอุ่นแคชเฉพาะตอนที่มีการแปลงไฟล์จริง — ถ้าส่งไฟล์ต้นฉบับตรงๆ ไม่มีอะไรให้รอ
function needsWarm(originalUrl, playUrl) {
  return playUrl !== originalUrl;
}

function buildThumbnailUrl(originalUrl) {
  if (!originalUrl) return originalUrl;
  const mp4Url = originalUrl.replace(/\.(mov|webm|m4v)$/i, ".mp4");
  return mp4Url.replace("/upload/", "/upload/so_0/").replace(/\.mp4$/i, ".jpg");
}

async function warmVideoUrl(url, timeoutMs = 25000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 2026-07-29 (ลดโควตา Cloudinary):
    //   เดิมใช้ GET ธรรมดา = เซิร์ฟเวอร์ "ดาวน์โหลดวีดีโอทั้งไฟล์" ทุกครั้งที่ส่งให้ลูกค้า
    //   ทั้งที่จุดประสงค์คือแค่กระตุ้นให้ Cloudinary transcode ให้เสร็จก่อน
    //   เท่ากับจ่ายค่า bandwidth 2 เท่า (เซิร์ฟเวอร์ 1 + ลูกค้า 1) โดยไม่ได้ประโยชน์
    //   แก้เป็นขอแค่ไบต์แรก (Range) — Cloudinary ยัง transcode ให้เหมือนเดิม
    //   แต่เราโหลดจริงแค่ไม่กี่ไบต์ ประหยัด bandwidth ครึ่งหนึ่ง
    const resp = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    // 206 = ส่งบางส่วนตามที่ขอ (ปกติ), 200 = ส่งทั้งไฟล์ (บาง CDN ไม่รองรับ Range)
    if (!resp.ok && resp.status !== 206) console.warn(`⚠️  warmVideoUrl: HTTP ${resp.status} — ${url}`);
    else console.log(`✅ warmVideoUrl: transcode พร้อมแล้ว (${url.split("/upload/")[1]?.split("/")[0]})`);
  } catch (e) {
    // ไม่ throw — ถ้า warm ไม่สำเร็จก็ปล่อยให้ Cloudinary transcode ตอน LINE ดึงเองแทน
    console.warn(`⚠️  warmVideoUrl timeout/error: ${e.message}`);
  }
}

// ─── Send CockpitSure video (ส่งให้ลูกค้าแล้วลบทิ้ง — ไม่เก็บข้อมูลถาวร) ────
app.post("/api/branch/:branchId/bay/:bay/send-video", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { videoUrl, plate } = req.body;
    if (!videoUrl) return res.status(400).json({ error: "videoUrl required" });
    const row = await getQueueRow(branchId, bay);
    const branchName = await getBranchName(branchId);
    const userId = row?.line_user_id;

    // ส่งวีดีโอให้ลูกค้าทาง LINE เป็น video message (เล่นในแชทได้เลย)
    if (userId) {
      // playUrl = mp4/h264/aac ที่บีบอัดแล้ว (≤ ~600kbps) — เล็กลง + เล่นได้บน iOS/LINE แน่นอน
      const playUrl = buildOptimizedVideoUrl(videoUrl);
      const previewImageUrl = buildThumbnailUrl(videoUrl);

      // อุ่นแคชเฉพาะกรณีที่ต้องแปลงไฟล์ (webm/mov) — ไฟล์ mp4 ส่งตรงได้เลย ไม่ต้องรอ
      if (needsWarm(videoUrl, playUrl)) await warmVideoUrl(playUrl);
      // URL ดาวน์โหลด: ใช้หน้า download.html (fetch→blob→save) เพราะ LINE in-app browser
      // ส่วนใหญ่ไม่ยอม trigger การดาวน์โหลดจาก header ตรงๆ (fl_attachment เฉยๆ ใช้ไม่ได้กับ LINE webview)
      const webappBase = (process.env.WEBAPP_URL || "https://cockpit-pro-webapp.vercel.app").replace(/\/$/, "");
      const downloadUrl = `${webappBase}/download.html?`
        + `url=${encodeURIComponent(playUrl)}`
        + `&name=${encodeURIComponent(`CockpitSure_${plate||row?.plate||"video"}.mp4`)}`
        + `&plate=${encodeURIComponent(plate||row?.plate||"")}`
        + `&branch=${encodeURIComponent(branchName||"")}`;

      await push(userId, [
        {
          type: "video",
          originalContentUrl: playUrl,
          previewImageUrl,
        },
        {
          type: "flex",
          altText: "🎥 วีดีโอผลการตรวจสภาพ CockpitSure",
          contents: {
            type: "bubble",
            body: {
              type: "box", layout: "vertical", spacing: "md",
              contents: [
                { type: "text", text: "🎥 วีดีโอผลการตรวจสภาพ CockpitSure",
                  weight: "bold", size: "md", wrap: true, color: "#1A1A1A" },
                { type: "box", layout: "vertical", spacing: "xs", contents: [
                  { type: "text", text: `🚗 ทะเบียน: ${plate||row?.plate}`, size: "sm", color: "#555555", wrap: true },
                  { type: "text", text: `📍 ${branchName}`, size: "sm", color: "#555555", wrap: true },
                ]},
                { type: "text", text: "⏳ วีดีโอจะหมดอายุใน 24 ชั่วโมง — กรุณาดาวน์โหลดเก็บไว้",
                  size: "xs", color: "#e11d48", wrap: true },
              ],
            },
            footer: {
              type: "box", layout: "vertical", spacing: "sm",
              contents: [
                { type: "button", style: "primary", color: "#1A1A1A", height: "md",
                  action: { type: "uri", label: "⬇️ ดาวน์โหลดเก็บวิดีโอ", uri: downloadUrl } },
                { type: "text", text: "จะเปิดหน้าดาวน์โหลด กดปุ่มอีกครั้งในหน้านั้นเพื่อบันทึก",
                  size: "xxs", color: "#9ca3af", wrap: true, align: "center" },
              ],
            },
          },
        },
      ], branchId);
    }

    // ❗ ไม่ลบวิดีโอทันที — LINE ต้องดึงวิดีโอจาก URL ไปแคชก่อน
    // ถ้าลบทันทีวิดีโอจะเล่นไม่ได้ → ปล่อยให้ cron ลบเมื่อครบ 24 ชม.

    // บันทึกลงตาราง videos เพื่อให้แสดงในแท็บวีดีโอ (ดาวน์โหลดเก็บได้)
    // เก็บ URL ที่บีบอัดแล้ว (playUrl) แทน videoUrl ดิบ — เล่น/โหลดในแท็บวีดีโอเร็วขึ้นด้วย
    try {
      await supabase.from("videos").insert({
        branch_id:   branchId,
        branch_name: branchName,
        plate:       plate || row?.plate || null,
        province:    row?.province || null,
        video_url:   buildOptimizedVideoUrl(videoUrl),
        uploaded_at: new Date().toISOString(),
      });
    } catch (e) {
      console.error("videos insert error:", e.message);
    }

    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Send quotation photos via LINE ──────────────────────────
app.post("/api/branch/:branchId/bay/:bay/quote", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { imageUrls, message } = req.body;
    if (!imageUrls?.length) return res.status(400).json({ error: "imageUrls required" });

    const row = await getQueueRow(branchId, bay);
    if (!row?.line_user_id) return res.status(400).json({ error: "ไม่พบ LINE user ของรถคันนี้" });

    const branchName = await getBranchName(branchId);
    const msgs = [];

    // ส่งข้อความก่อน (ถ้ามี)
    if (message) msgs.push({ type:"text", text: message });

    // ส่งรูปภาพแต่ละรูป
    for (const url of imageUrls) {
      msgs.push({
        type: "image",
        originalContentUrl: url,
        previewImageUrl:    url,
      });
    }

    await push(row.line_user_id, msgs, branchId);
    res.json({ success: true });
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
  invalidateBranch(req.params.branchId);   // ล้าง cache ให้เห็นผลทันที
  try {
    const { branchId, historyId } = req.params;
    const { data: h } = await supabase.from("history")
      .select("*").eq("id", +historyId).eq("branch_id", branchId).single();
    if (!h) return res.status(404).json({ error: "ไม่พบข้อมูล" });

    const isSameDay = new Date(h.closed_at).toDateString() === new Date().toDateString();
    if (!isSameDay) return res.status(400).json({ error: "คืนสถานะได้เฉพาะวันเดียวกัน" });

    const bay = await getFreeBay(branchId) || h.bay;
    const { data: existing } = await supabase.from("queue")
      .select("id").eq("branch_id", branchId).eq("bay", bay).maybeSingle();
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

app.delete("/api/branch/:branchId/videos/:videoId", async (req, res) => {
  try {
    const { branchId, videoId } = req.params;
    const { data: v } = await supabase.from("videos")
      .select("video_url").eq("id", +videoId).eq("branch_id", branchId).single();

    if (v?.video_url && process.env.CLOUDINARY_API_KEY) {
      const match = v.video_url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
      if (match?.[1]) {
        await cloudinary.uploader.destroy(match[1], { resource_type: "video" })
          .catch(e => console.error("Cloudinary delete:", e.message));
      }
    }

    const { error } = await supabase.from("videos")
      .delete().eq("id", +videoId).eq("branch_id", branchId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════════
app.get("/", (req, res) => res.json({
  status: "ok",
  env:    process.env.NODE_ENV || "development",
  db:     "supabase",
  time:   new Date().toISOString(),
}));

app.listen(PORT, () => console.log(`✅ Cockpit Pro (Multi-Bot) running on port ${PORT}`));
