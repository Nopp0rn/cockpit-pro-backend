const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

// ─── Firebase Init ─────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ─── Middleware ────────────────────────────────────────────
app.use(cors({ origin: "*", methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.options("*", cors());
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ─── LINE Multi-Branch Config ──────────────────────────────
// อ่าน token/secret จาก env แบบ LINE_TOKEN_BR107, LINE_SECRET_BR107
// ถ้าไม่มี branchId-specific ให้ fallback ไปใช้ LINE_CHANNEL_ACCESS_TOKEN เดิม
function getBranchToken(branchId) {
  return process.env[`LINE_TOKEN_${branchId}`] || process.env.LINE_CHANNEL_ACCESS_TOKEN;
}
function getBranchSecret(branchId) {
  return process.env[`LINE_SECRET_${branchId}`] || process.env.LINE_CHANNEL_SECRET;
}

// หา branchId จาก Channel Secret (ใช้ตอน Webhook เข้ามา)
function getBranchIdFromSecret(secret) {
  const env = process.env;
  // หาจาก LINE_SECRET_BRxxx
  for(const key of Object.keys(env)) {
    if(key.startsWith("LINE_SECRET_") && env[key] === secret) {
      return key.replace("LINE_SECRET_", "");
    }
  }
  // fallback: ถ้าตรงกับ secret เดิม = BR107
  if(secret === process.env.LINE_CHANNEL_SECRET) return "BR107";
  return null;
}

const LINE_API = "https://api.line.me/v2/bot";

async function pushMessage(userId, messages, branchId="BR107") {
  const token = getBranchToken(branchId);
  try {
    await axios.post(`${LINE_API}/message/push`,
      { to: userId, messages },
      { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } }
    );
    console.log(`✅ Push sent to ${userId} via ${branchId}`);
  } catch (err) {
    console.error(`❌ Push error [${branchId}]:`, err.response?.data || err.message);
  }
}

// ─── Flex Message Builder ──────────────────────────────────

// Auto-lookup userId จาก plate ถ้า job.userId เป็น null
function cleanBranchId(id) {
  if (!id) return "BR107";
  return id.replace(/[^\w]/g, "").toUpperCase();
}

function normalizePlate(plate) {
  if (!plate) return "";
  // Normalize Unicode และลบช่องว่าง แปลงเป็นตัวพิมพ์ใหญ่
  return plate.normalize("NFC").replace(/\s+/g, "").toUpperCase();
}

async function resolveUserId(job) {
  if (job.userId) return { userId: job.userId, branchId: cleanBranchId(job.branchId), province: job.province || "" };
  if (!job.plate) return null;
  const normalizedPlate = normalizePlate(job.plate);
  const jobProvince = (job.province || "").trim();
  try {
    const snap = await db.collection("lineUsers").get();
    let bestMatch = null;
    for (const doc of snap.docs) {
      const data = doc.data();
      if (normalizePlate(data.plate) !== normalizedPlate) continue;

      // ถ้ามีจังหวัดทั้งสองฝั่ง ต้องตรงกัน
      const userProvince = (data.province || "").trim();
      if (jobProvince && userProvince && jobProvince !== userProvince) {
        console.log(`⏭️ Plate match but province mismatch: job=${jobProvince} user=${userProvince}`);
        continue; // ข้ามถ้าจังหวัดไม่ตรง
      }

      bestMatch = { userId: data.userId, branchId: cleanBranchId(data.branchId || job.branchId), province: userProvince };
      break;
    }

    if (bestMatch) {
      if (job._ref) await job._ref.update({ userId: bestMatch.userId, branchId: bestMatch.branchId, province: bestMatch.province });
      console.log(`✅ resolveUserId: ${normalizedPlate} จ.${bestMatch.province} → ${bestMatch.userId}`);
      return bestMatch;
    }
    console.log(`❌ resolveUserId: ไม่พบ ${normalizedPlate} จ.${jobProvince}`);
  } catch (e) {
    console.error("resolveUserId error:", e.message);
  }
  return null;
}

function buildStatusFlex({ plate, province, branchName, bay, bayStatus, jobs }) {
  const doneCount = jobs.filter((j) => j.status === "done").length;
  const progress = Math.round((doneCount / jobs.length) * 100);
  const statusLabel = {
    waiting_entry: "🕐 รอเข้าช่องบริการ",
    in_service: "🔧 กำลังดำเนินการ",
    done: "✅ เสร็จเรียบร้อย",
  }[bayStatus] || "กำลังดำเนินการ";

  const provinceText = province ? ` จ.${province}` : "";

  const jobRows = jobs.map((j) => ({
    type: "box", layout: "horizontal",
    contents: [
      { type: "text", text: j.status === "done" ? "✅" : j.status === "in_progress" ? "🔧" : "⏳", size: "md", flex: 0 },
      { type: "text", text: j.name, size: "md", color: j.status === "done" ? "#9ca3af" : "#111827", decoration: j.status === "done" ? "line-through" : "none", flex: 3, margin: "sm", weight: j.status === "in_progress" ? "bold" : "regular" },
      { type: "text", text: `${j.duration} นาที`, size: "sm", color: "#9ca3af", align: "end", flex: 2 },
    ],
    margin: "md",
  }));

  return {
    type: "flex",
    altText: `[Cockpit] อัปเดตสถานะรถ ${plate}${provinceText}`,
    contents: {
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#1A1A1A",
        contents: [
          { type: "text", text: "🚗 Cockpit Pro – สถานะรถของคุณ", color: "#FFE000", size: "md", weight: "bold" },
          { type: "text", text: plate, color: "#FFFFFF", size: "3xl", weight: "bold", margin: "sm" },
          { type: "text", text: `${branchName} · ช่องที่ ${bay}${provinceText}`, color: "#aaaaaa", size: "sm", margin: "xs" },
        ],
        paddingAll: "22px",
      },
      body: {
        type: "box", layout: "vertical",
        contents: [
          { type: "box", layout: "horizontal", contents: [
            { type: "text", text: statusLabel, size: "lg", weight: "bold", color: "#1A1A1A", flex: 3 },
            { type: "text", text: `${progress}%`, size: "lg", weight: "bold", color: "#1A1A1A", align: "end", flex: 1 },
          ]},
          { type: "box", layout: "vertical", backgroundColor: "#f3f4f6", cornerRadius: "99px", height: "10px", margin: "md",
            contents: [{ type: "box", layout: "vertical", backgroundColor: "#FFE000", cornerRadius: "99px", height: "10px", width: `${progress}%`, contents: [] }]
          },
          { type: "separator", margin: "lg" },
          { type: "text", text: "รายการงาน", size: "sm", color: "#9ca3af", margin: "lg", weight: "bold" },
          ...jobRows,
        ],
        paddingAll: "22px",
      },
      footer: {
        type: "box", layout: "vertical", backgroundColor: "#f9fafb",
        contents: [{
          type: "text",
          text: bayStatus === "done" ? "✅ รถพร้อมรับแล้ว กรุณามารับรถได้เลยครับ" : "ขอบคุณที่ใช้บริการ Cockpit 🙏",
          size: "md", color: "#374151", align: "center", wrap: true, weight: "bold",
        }],
        paddingAll: "16px",
      },
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────
function getDuration(name) {
  const map = { ยาง: 45, ตั้งศูนย์: 60, ถ่วงล้อ: 30, แบตเตอรี่: 20, เบรค: 50, โช้คอัพ: 90, น้ำมันเครื่อง: 25, "Cockpit Sure": 35, อื่นๆ: 40 };
  return map[name] || 30;
}

// ─── LINE Webhook ──────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const signature = req.headers["x-line-signature"];
  const bodyBuf = req.body;

  // ตรวจสอบว่า Webhook มาจากสาขาไหนโดยเทียบ Secret ทุกสาขา
  let branchId = null;
  const env = process.env;
  const lineSecretKeys = Object.keys(env).filter(k => k.startsWith("LINE_SECRET_"));
  console.log(`🔍 Checking signature against: ${lineSecretKeys.join(", ")}`);

  for(const key of lineSecretKeys) {
    const secret = env[key];
    const hash = crypto.createHmac("sha256", secret).update(bodyBuf).digest("base64");
    console.log(`   ${key}: hash=${hash.substring(0,10)}... sig=${signature?.substring(0,10)}... match=${hash === signature}`);
    if(hash === signature) {
      branchId = key.replace("LINE_SECRET_", "");
      break;
    }
  }
  // fallback สำหรับ LINE_CHANNEL_SECRET เดิม
  if(!branchId && process.env.LINE_CHANNEL_SECRET) {
    const hash = crypto.createHmac("sha256", process.env.LINE_CHANNEL_SECRET).update(bodyBuf).digest("base64");
    if(hash === signature) branchId = "BR107";
  }

  if(!branchId) {
    console.warn("⚠️ Invalid webhook signature - no matching branch");
    return res.status(401).json({ error: "Invalid signature" });
  }

  console.log(`📩 Webhook from branch: ${branchId}`);
  const events = JSON.parse(bodyBuf).events;

  for (const event of events) {
    const userId = event.source?.userId;

    // ─ Follow event → welcome message ตามชื่อสาขา
    if (event.type === "follow") {
      const branchDoc = await db.collection("branches").doc(branchId).get();
      const branchName = branchDoc.exists ? branchDoc.data().name : "Cockpit";
      await pushMessage(userId, [{
        type: "text",
        text: `🎉 ยินดีต้อนรับสู่ ${branchName}!\n\nพิมพ์ทะเบียนรถของคุณ เพื่อให้ระบบแจ้งเตือนสถานะรถผ่าน LINE นี้โดยอัตโนมัติครับ 🚗`,
      }], branchId);
    }

    // ─ Message event
    if (event.type === "message" && event.message.type === "text") {
      const text = event.message.text.trim();
      const stripped = text.replace(/\s/g, "").toUpperCase();
      const hasLetter = /[ก-ฮA-Z]/.test(stripped);
      const hasNumber = /[0-9]/.test(stripped);
      const isPlate = hasLetter && hasNumber && stripped.length >= 3 && stripped.length <= 10 && /^[ก-ฮA-Z0-9]+$/.test(stripped);

      if (isPlate) {
        // ส่งลิงก์ลงทะเบียนพร้อม token
        const token = `${userId}_${Date.now()}`;
        await db.collection("registerTokens").doc(token).set({
          userId, branchId, createdAt: new Date().toISOString()
        });
        const regUrl = `https://cockpit-pro-webapp.vercel.app/register.html?token=${token}`;
        await pushMessage(userId, [{
          type: "text",
          text: `🚗 ทะเบียน "${stripped}"\n\nกรุณาลงทะเบียนเพื่อรับแจ้งเตือนสถานะรถครับ\n👇 กดลิงก์ด้านล่าง\n\n${regUrl}`
        }], branchId);
      }
      // ข้อความอื่น → ไม่ตอบ
    }
  }
  res.json({ status: "ok" });
});

// ─── Register API ──────────────────────────────────────────

// GET ตรวจสอบ token
app.get("/api/register/:token", async (req, res) => {
  try {
    const doc = await db.collection("registerTokens").doc(req.params.token).get();
    if (!doc.exists) return res.json({ valid: false });
    const data = doc.data();
    // token หมดอายุหลัง 24 ชั่วโมง
    const age = Date.now() - new Date(data.createdAt).getTime();
    if (age > 24 * 60 * 60 * 1000) return res.json({ valid: false });
    const branchDoc = await db.collection("branches").doc(data.branchId).get();
    res.json({ valid: true, branchName: branchDoc.data()?.name || "Cockpit Pro" });
  } catch (err) {
    res.json({ valid: false });
  }
});

// POST submit ลงทะเบียน
app.post("/api/register/submit", async (req, res) => {
  try {
    const { token, plate, province, phone } = req.body;
    if (!token || !plate || !province) return res.status(400).json({ error: "ข้อมูลไม่ครบ" });
    const tokenDoc = await db.collection("registerTokens").doc(token).get();
    if (!tokenDoc.exists) return res.status(400).json({ error: "Token ไม่ถูกต้อง" });
    const { userId, branchId } = tokenDoc.data();
    // บันทึก lineUsers
    await db.collection("lineUsers").doc(userId).set({
      userId, plate: plate.toUpperCase().replace(/\s/g,""),
      province, phone, branchId,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    // ลบ pendingPlate ถ้ามี
    await db.collection("lineUsers").doc(userId).update({
      pendingPlate: admin.firestore.FieldValue.delete()
    }).catch(()=>{});
    // ลบ token
    await db.collection("registerTokens").doc(token).delete();
    // แจ้งยืนยันใน LINE
    const branchDoc = await db.collection("branches").doc(branchId).get();
    await pushMessage(userId, [{
      type: "text",
      text: `✅ ลงทะเบียนสำเร็จครับ!\n\nทะเบียน: ${plate.toUpperCase()}\nจังหวัด: ${province}\n\nระบบจะแจ้งเตือนสถานะรถผ่าน LINE นี้โดยอัตโนมัติครับ 🚗`
    }], branchId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Branch API ────────────────────────────────────────────

// GET ข้อมูลสาขา + ช่องซ่อมทั้งหมด
app.get("/api/branch/:branchId", async (req, res) => {
  try {
    const { branchId } = req.params;
    const branchDoc = await db.collection("branches").doc(branchId).get();
    if (!branchDoc.exists) return res.status(404).json({ error: "Branch not found" });

    const branchInfo = branchDoc.data();
    const baysSnap = await db.collection("branches").doc(branchId).collection("bays").get();
    const baysData = {};
    baysSnap.forEach((doc) => { baysData[doc.id] = doc.data(); });

    // ส่ง totalBays แยกจาก baysData เพื่อไม่ให้ทับกัน
    res.json({
      id: branchId,
      name: branchInfo.name,
      lineOA: branchInfo.lineOA,
      totalBays: branchInfo.bays || 8,  // จำนวนช่องซ่อม
      baysData,                          // ข้อมูลช่องที่มีงาน
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT ตั้งค่าจำนวนช่อง
app.put("/api/branch/:branchId/settings", async (req, res) => {
  try {
    const { branchId } = req.params;
    const { bays } = req.body;
    // บันทึก bays (จำนวนช่อง) ลงใน Firestore
    await db.collection("branches").doc(branchId).set({ bays }, { merge: true });
    res.json({ success: true, branchId, totalBays: bays });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST เปิดงาน
app.post("/api/branch/:branchId/bay/:bay/open", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { plate, phone, province, userId: manualUserId, jobs } = req.body;
    if (!plate || !phone || !jobs?.length) return res.status(400).json({ error: "plate, phone, jobs required" });

    // Auto-lookup userId โดยต้องตรงทั้ง plate และ province
    let userId = manualUserId || null;
    if (!userId) {
      const normalizedPlate = normalizePlate(plate);
      const jobProvince = (province || "").trim();
      const allUsers = await db.collection("lineUsers").get();
      for (const doc of allUsers.docs) {
        const data = doc.data();
        if (normalizePlate(data.plate) !== normalizedPlate) continue;
        const userProvince = (data.province || "").trim();
        // ถ้ามีจังหวัดทั้งสองฝั่ง ต้องตรงกัน
        if (jobProvince && userProvince && jobProvince !== userProvince) {
          console.log(`⏭️ open job: province mismatch job=${jobProvince} user=${userProvince}`);
          continue;
        }
        userId = data.userId;
        console.log(`✅ open job: found ${normalizedPlate} จ.${userProvince} → ${userId}`);
        break;
      }
    }

    const jobData = {
      id: `JOB-${Date.now()}`,
      plate: plate.toUpperCase(), phone,
      province: province || "",
      userId: userId || null,
      bay: parseInt(bay),
      jobs: jobs.map((j) => ({ name: j, duration: getDuration(j), status: "waiting" })),
      bayStatus: "waiting_entry",
      startTime: new Date().toISOString(),
      branchId,
    };

    await db.collection("branches").doc(branchId).collection("bays").doc(bay).set(jobData);

    // แจ้ง LINE ลูกค้า (ถ้ามี userId)
    if (userId) {
      const branchDoc = await db.collection("branches").doc(branchId).get();
      const branchName = branchDoc.data()?.name || branchId;
      await pushMessage(userId, [buildStatusFlex({ plate: jobData.plate, branchName, bay, bayStatus: "waiting_entry", jobs: jobData.jobs })], branchId);
    }

    res.json({ success: true, job: jobData, lineNotified: !!userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST เพิ่มงานในช่องที่มีรถอยู่แล้ว
app.post("/api/branch/:branchId/bay/:bay/addjobs", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { jobs: newJobNames } = req.body;
    if (!newJobNames?.length) return res.status(400).json({ error: "jobs required" });

    const ref = db.collection("branches").doc(branchId).collection("bays").doc(bay);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "No job in this bay" });

    const job = doc.data();
    const existingNames = job.jobs.map(j => j.name);

    // เพิ่มเฉพาะงานที่ยังไม่มี
    const toAdd = newJobNames
      .filter(name => !existingNames.includes(name))
      .map(name => ({ name, duration: getDuration(name), status: "waiting" }));

    if (!toAdd.length) return res.status(400).json({ error: "All jobs already exist" });

    const updatedJobs = [...job.jobs, ...toAdd];
    await ref.update({ jobs: updatedJobs });

    // แจ้ง LINE ลูกค้า
    if (job.userId) {
      const branchDoc = await db.collection("branches").doc(branchId).get();
      await pushMessage(job.userId, [buildStatusFlex({
        plate: job.plate,
        branchName: branchDoc.data()?.name || branchId,
        bay,
        bayStatus: job.bayStatus,
        jobs: updatedJobs,
      })], branchId);
    }

    res.json({ success: true, addedJobs: toAdd.map(j=>j.name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST ลบงานย่อยออกจากช่อง
app.post("/api/branch/:branchId/bay/:bay/removejob", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { jobIdx } = req.body;
    if (jobIdx === undefined) return res.status(400).json({ error: "jobIdx required" });

    const ref = db.collection("branches").doc(branchId).collection("bays").doc(bay);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "No job in this bay" });

    const job = doc.data();
    const updatedJobs = job.jobs.filter((_, i) => i !== parseInt(jobIdx));
    if (!updatedJobs.length) return res.status(400).json({ error: "Cannot remove all jobs - must have at least 1" });

    await ref.update({ jobs: updatedJobs });

    const resolvedUserId3 = await resolveUserId({ ...job, _ref: ref });
    if (resolvedUserId3) {
      const branchDoc = await db.collection("branches").doc(branchId).get();
      await pushMessage(resolvedUserId3, [buildStatusFlex({
        plate: job.plate, branchName: branchDoc.data()?.name || branchId,
        bay, bayStatus: job.bayStatus, jobs: updatedJobs,
      })], branchId);
    }
    res.json({ success: true, remainingJobs: updatedJobs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/branch/:branchId/bay/:bay/start", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const ref = db.collection("branches").doc(branchId).collection("bays").doc(bay);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "No job in this bay" });

    const job = doc.data();
    const updatedJobs = [...job.jobs];
    if (updatedJobs[0]) updatedJobs[0].status = "in_progress";

    await ref.update({ bayStatus: "in_service", jobs: updatedJobs });

    if (job.userId) {
      const branchDoc = await db.collection("branches").doc(branchId).get();
      await pushMessage(job.userId, [buildStatusFlex({ plate: job.plate, branchName: branchDoc.data()?.name, bay, bayStatus: "in_service", jobs: updatedJobs })], branchId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH อัปเดตสถานะงานย่อย
app.patch("/api/branch/:branchId/bay/:bay/job/:jobIdx", async (req, res) => {
  try {
    const { branchId, bay, jobIdx } = req.params;
    const { status } = req.body;
    const ref = db.collection("branches").doc(branchId).collection("bays").doc(bay);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "No job" });

    const job = doc.data();
    const updatedJobs = [...job.jobs];
    updatedJobs[parseInt(jobIdx)].status = status;
    await ref.update({ jobs: updatedJobs, bayStatus: "in_service" });

    // ตอบ frontend ทันที ไม่รอ LINE
    res.json({ success: true });

    // ส่ง LINE ใน background
    resolveUserId({ ...job, _ref: ref }).then(resolved => {
      if (!resolved) return;
      const useBranchId = resolved.branchId || branchId;
      db.collection("branches").doc(useBranchId).get().then(branchDoc => {
        pushMessage(resolved.userId, [buildStatusFlex({
          plate: job.plate, branchName: branchDoc.data()?.name,
          bay, bayStatus: "in_service", jobs: updatedJobs
        })], useBranchId);
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST ส่ง LINE อัปเดตด้วยตนเอง
app.post("/api/branch/:branchId/bay/:bay/notify", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const ref = db.collection("branches").doc(branchId).collection("bays").doc(bay);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "No job" });

    const job = doc.data();
    // Auto-lookup userId จาก plate ถ้า job.userId เป็น null
    const resolved = await resolveUserId({ ...job, _ref: ref });
    if (!resolved) return res.status(400).json({ error: "No LINE userId - ลูกค้ายังไม่ได้พิมพ์ทะเบียนใน LINE" });

    const useBranchId = resolved.branchId || branchId;
    const branchDoc = await db.collection("branches").doc(useBranchId).get();
    await pushMessage(resolved.userId, [buildStatusFlex({ plate: job.plate, branchName: branchDoc.data()?.name, bay, bayStatus: job.bayStatus, jobs: job.jobs })], useBranchId);
    await ref.update({ lineNotified: true, userId: resolved.userId });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST เพิ่มงานในช่องที่มีรถอยู่แล้ว
app.post("/api/branch/:branchId/bay/:bay/addjobs", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const { jobs: newJobNames } = req.body;
    if (!newJobNames?.length) return res.status(400).json({ error: "jobs required" });

    const ref = db.collection("branches").doc(branchId).collection("bays").doc(bay);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "No job in this bay" });

    const job = doc.data();
    const existingNames = job.jobs.map(j => j.name);

    // เพิ่มเฉพาะงานที่ยังไม่มี
    const toAdd = newJobNames
      .filter(name => !existingNames.includes(name))
      .map(name => ({ name, duration: getDuration(name), status: "waiting" }));

    if (!toAdd.length) return res.status(400).json({ error: "All jobs already exist" });

    const updatedJobs = [...job.jobs, ...toAdd];
    await ref.update({ jobs: updatedJobs });

    // แจ้ง LINE ลูกค้า
    if (job.userId) {
      const branchDoc = await db.collection("branches").doc(branchId).get();
      await pushMessage(job.userId, [buildStatusFlex({
        plate: job.plate,
        branchName: branchDoc.data()?.name || branchId,
        bay,
        bayStatus: job.bayStatus,
        jobs: updatedJobs,
      })], branchId);
    }

    res.json({ success: true, addedJobs: toAdd.map(j => j.name), totalJobs: updatedJobs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST ปิดงาน
app.post("/api/branch/:branchId/bay/:bay/close", async (req, res) => {
  try {
    const { branchId, bay } = req.params;
    const ref = db.collection("branches").doc(branchId).collection("bays").doc(bay);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "No job" });

    const job = doc.data();
    const doneJobs = job.jobs.map((j) => ({ ...j, status: "done" }));

    // ลบข้อมูลออกจาก Firestore ทันที
    await ref.delete();
    await db.collection("branches").doc(branchId).collection("history").add({
      ...job, jobs: doneJobs, closedAt: new Date().toISOString(),
    });

    // ตอบ frontend ทันที ไม่รอ LINE
    res.json({ success: true, message: `Bay ${bay} cleared` });

    // ส่ง LINE ใน background
    resolveUserId({ ...job }).then(resolved => {
      if (!resolved) return;
      const useBranchId = resolved.branchId || branchId;
      db.collection("branches").doc(useBranchId).get().then(branchDoc => {
        pushMessage(resolved.userId, [buildStatusFlex({
          plate: job.plate, branchName: branchDoc.data()?.name,
          bay, bayStatus: "done", jobs: doneJobs
        })], useBranchId);
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Admin – ภาพรวมทุกสาขา
app.get("/api/admin/overview", async (req, res) => {
  try {
    const branchesSnap = await db.collection("branches").get();
    const overview = [];

    for (const branchDoc of branchesSnap.docs) {
      const data = branchDoc.data();
      const baysSnap = await db.collection("branches").doc(branchDoc.id).collection("bays").get();
      const activeBays = baysSnap.size;
      const allJobs = [];
      baysSnap.forEach((b) => allJobs.push(...(b.data().jobs || [])));

      overview.push({
        branchId: branchDoc.id,
        name: data.name,
        lineOA: data.lineOA || "",
        totalBays: data.bays || 8,
        activeBays,
        emptyBays: (data.bays || 8) - activeBays,
        totalJobs: allJobs.length,
        doneJobs: allJobs.filter((j) => j.status === "done").length,
        inProgressJobs: allJobs.filter((j) => j.status === "in_progress").length,
        waitingJobs: allJobs.filter((j) => j.status === "waiting").length,
      });
    }

    res.json({ overview, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Health check
app.get("/", (req, res) => res.json({ status: "Cockpit Pro Backend OK 🚗", time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Cockpit Pro Backend running on port ${PORT}`));
