const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const cors = require("cors");

const app = express();

// ─── Middleware ───────────────────────────────────────────
app.use(cors());

// Raw body สำหรับ LINE Signature Verification
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ─── In-Memory Store (ใช้แทน DB สำหรับทดสอบ) ─────────────
// jobs[branchId][bayNum] = { plate, phone, userId, jobs[], bayStatus, startTime }
const store = {
  jobs: {},       // สถานะช่องซ่อม
  users: {},      // userId -> { plate, phone, branchId, bay }
  branches: {
    BR001: { name: "Cockpit บายพาส อุดร", bays: 8 },
  },
};

// ─── LINE Helpers ──────────────────────────────────────────
const LINE_API = "https://api.line.me/v2/bot";

function lineHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
  };
}

// ส่ง Push Message
async function pushMessage(userId, messages) {
  try {
    await axios.post(
      `${LINE_API}/message/push`,
      { to: userId, messages },
      { headers: lineHeaders() }
    );
    console.log(`✅ Push sent to ${userId}`);
  } catch (err) {
    console.error("❌ Push error:", err.response?.data || err.message);
  }
}

// สร้าง Flex Message แจ้งสถานะ
function buildStatusFlex({ plate, branchName, bay, bayStatus, jobs }) {
  const doneCount = jobs.filter((j) => j.status === "done").length;
  const progress = Math.round((doneCount / jobs.length) * 100);

  const statusLabel = {
    waiting_entry: "🕐 รอเข้าช่องบริการ",
    in_service: "🔧 กำลังดำเนินการ",
    done: "✅ เสร็จเรียบร้อย",
  }[bayStatus] || "กำลังดำเนินการ";

  const jobRows = jobs.map((j) => ({
    type: "box",
    layout: "horizontal",
    contents: [
      {
        type: "text",
        text: j.status === "done" ? "✅" : j.status === "in_progress" ? "🔧" : "⏳",
        size: "sm",
        flex: 0,
      },
      {
        type: "text",
        text: j.name,
        size: "sm",
        color: j.status === "done" ? "#9ca3af" : "#111827",
        decoration: j.status === "done" ? "line-through" : "none",
        flex: 3,
        margin: "sm",
      },
      {
        type: "text",
        text: `${j.duration} นาที`,
        size: "xs",
        color: "#9ca3af",
        align: "end",
        flex: 2,
      },
    ],
    margin: "sm",
  }));

  return {
    type: "flex",
    altText: `[TirePlus] อัปเดตสถานะรถ ${plate}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#1e3a5f",
        contents: [
          {
            type: "text",
            text: "🚗 TirePlus – สถานะรถของคุณ",
            color: "#ffffff",
            size: "sm",
            weight: "bold",
          },
          {
            type: "text",
            text: plate,
            color: "#93c5fd",
            size: "xxl",
            weight: "bold",
            margin: "xs",
          },
          {
            type: "text",
            text: `${branchName} · ช่องที่ ${bay}`,
            color: "#93c5fd",
            size: "xs",
          },
        ],
        paddingAll: "20px",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "text",
                text: statusLabel,
                size: "sm",
                weight: "bold",
                color: "#2563eb",
                flex: 3,
              },
              {
                type: "text",
                text: `${progress}%`,
                size: "sm",
                weight: "bold",
                color: "#2563eb",
                align: "end",
                flex: 1,
              },
            ],
          },
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#f3f4f6",
            cornerRadius: "99px",
            height: "8px",
            margin: "sm",
            contents: [
              {
                type: "box",
                layout: "vertical",
                backgroundColor: "#2563eb",
                cornerRadius: "99px",
                height: "8px",
                width: `${progress}%`,
                contents: [],
              },
            ],
          },
          { type: "separator", margin: "md" },
          { type: "text", text: "รายการงาน", size: "xs", color: "#9ca3af", margin: "md", weight: "bold" },
          ...jobRows,
        ],
        paddingAll: "20px",
      },
      footer: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#f9fafb",
        contents: [
          {
            type: "text",
            text: bayStatus === "done"
              ? "✅ รถพร้อมรับแล้ว กรุณามารับรถได้เลยครับ"
              : "ขอบคุณที่ใช้บริการ TirePlus 🙏",
            size: "xs",
            color: "#6b7280",
            align: "center",
            wrap: true,
          },
        ],
        paddingAll: "12px",
      },
    },
  };
}

// ─── LINE Webhook ──────────────────────────────────────────
app.post("/webhook", (req, res) => {
  // Verify Signature
  const signature = req.headers["x-line-signature"];
  const body = req.body;
  const hash = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
    .update(body)
    .digest("base64");

  if (hash !== signature) {
    console.warn("⚠️ Invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const events = JSON.parse(body).events;

  events.forEach(async (event) => {
    if (event.type === "follow") {
      // ลูกค้า Add LINE OA → บันทึก userId
      const userId = event.source.userId;
      console.log(`👤 New follower: ${userId}`);

      // ส่งข้อความต้อนรับ
      await pushMessage(userId, [
        {
          type: "text",
          text: "🎉 ยินดีต้อนรับสู่ TirePlus!\n\nระบบจะแจ้งเตือนสถานะรถของคุณผ่าน LINE นี้โดยอัตโนมัติครับ 🚗",
        },
      ]);
    }

    if (event.type === "message" && event.message.type === "text") {
      const userId = event.source.userId;
      const text = event.message.text.trim();

      // ลูกค้าส่งทะเบียนรถมาเพื่อเช็คสถานะ
      if (text.startsWith("เช็ค") || text.length <= 10) {
        const plate = text.replace("เช็ค", "").trim();
        // หาข้อมูลรถจาก store
        let found = null;
        Object.entries(store.jobs).forEach(([branchId, bays]) => {
          Object.entries(bays).forEach(([bay, job]) => {
            if (job && job.plate === plate) {
              found = { ...job, branchId, bay };
            }
          });
        });

        if (found) {
          const branch = store.branches[found.branchId];
          await pushMessage(userId, [
            buildStatusFlex({
              plate: found.plate,
              branchName: branch?.name || found.branchId,
              bay: found.bay,
              bayStatus: found.bayStatus,
              jobs: found.jobs,
            }),
          ]);
        } else {
          await pushMessage(userId, [
            { type: "text", text: `ไม่พบข้อมูลรถทะเบียน "${plate}" ในระบบครับ\n\nลองพิมพ์ทะเบียนรถใหม่อีกครั้งนะครับ` },
          ]);
        }
      }
    }
  });

  res.json({ status: "ok" });
});

// ─── Branch API (สาขาใช้) ──────────────────────────────────

// GET สถานะทุกช่องของสาขา
app.get("/api/branch/:branchId/bays", (req, res) => {
  const { branchId } = req.params;
  const bays = store.jobs[branchId] || {};
  const branchInfo = store.branches[branchId] || { name: branchId, bays: 8 };
  res.json({ branchId, ...branchInfo, bays });
});

// POST เปิดงาน
app.post("/api/branch/:branchId/bay/:bay/open", async (req, res) => {
  const { branchId, bay } = req.params;
  const { plate, phone, userId, jobs } = req.body;

  if (!plate || !phone || !jobs?.length) {
    return res.status(400).json({ error: "plate, phone, jobs required" });
  }

  if (!store.jobs[branchId]) store.jobs[branchId] = {};

  const jobData = {
    id: `JOB-${Date.now()}`,
    plate,
    phone,
    userId: userId || null,
    jobs: jobs.map((j) => ({ name: j, duration: getDuration(j), status: "waiting" })),
    bayStatus: "waiting_entry",
    startTime: new Date().toISOString(),
    branchId,
    bay,
  };

  store.jobs[branchId][bay] = jobData;

  // บันทึก userId mapping
  if (userId) {
    store.users[userId] = { plate, phone, branchId, bay };
  }

  // แจ้ง LINE ลูกค้า
  if (userId) {
    const branch = store.branches[branchId] || { name: branchId };
    await pushMessage(userId, [
      buildStatusFlex({
        plate,
        branchName: branch.name,
        bay,
        bayStatus: "waiting_entry",
        jobs: jobData.jobs,
      }),
    ]);
  }

  res.json({ success: true, job: jobData });
});

// POST รถเข้าช่องบริการ
app.post("/api/branch/:branchId/bay/:bay/start", async (req, res) => {
  const { branchId, bay } = req.params;
  const job = store.jobs[branchId]?.[bay];
  if (!job) return res.status(404).json({ error: "No job in this bay" });

  job.bayStatus = "in_service";
  job.jobs[0].status = "in_progress";

  if (job.userId) {
    const branch = store.branches[branchId] || { name: branchId };
    await pushMessage(job.userId, [
      buildStatusFlex({ plate: job.plate, branchName: branch.name, bay, bayStatus: "in_service", jobs: job.jobs }),
    ]);
  }

  res.json({ success: true, job });
});

// PATCH อัปเดตสถานะงานย่อย
app.patch("/api/branch/:branchId/bay/:bay/job/:jobIdx", async (req, res) => {
  const { branchId, bay, jobIdx } = req.params;
  const { status } = req.body; // waiting | in_progress | done
  const job = store.jobs[branchId]?.[bay];
  if (!job) return res.status(404).json({ error: "No job" });

  job.jobs[jobIdx].status = status;

  // ส่ง LINE อัปเดต
  if (job.userId) {
    const branch = store.branches[branchId] || { name: branchId };
    await pushMessage(job.userId, [
      buildStatusFlex({ plate: job.plate, branchName: branch.name, bay, bayStatus: job.bayStatus, jobs: job.jobs }),
    ]);
  }

  res.json({ success: true, job });
});

// POST ปิดงาน (รถลงช่อง)
app.post("/api/branch/:branchId/bay/:bay/close", async (req, res) => {
  const { branchId, bay } = req.params;
  const job = store.jobs[branchId]?.[bay];
  if (!job) return res.status(404).json({ error: "No job" });

  // Mark all done
  job.jobs.forEach((j) => (j.status = "done"));
  job.bayStatus = "done";

  if (job.userId) {
    const branch = store.branches[branchId] || { name: branchId };
    await pushMessage(job.userId, [
      buildStatusFlex({ plate: job.plate, branchName: branch.name, bay, bayStatus: "done", jobs: job.jobs }),
    ]);
  }

  // ล้างช่อง
  store.jobs[branchId][bay] = null;

  res.json({ success: true, message: `Bay ${bay} cleared` });
});

// POST ส่ง LINE Update ด้วยตนเอง
app.post("/api/branch/:branchId/bay/:bay/notify", async (req, res) => {
  const { branchId, bay } = req.params;
  const job = store.jobs[branchId]?.[bay];
  if (!job) return res.status(404).json({ error: "No job" });
  if (!job.userId) return res.status(400).json({ error: "No LINE userId for this job" });

  const branch = store.branches[branchId] || { name: branchId };
  await pushMessage(job.userId, [
    buildStatusFlex({ plate: job.plate, branchName: branch.name, bay, bayStatus: job.bayStatus, jobs: job.jobs }),
  ]);

  res.json({ success: true });
});

// GET Admin – สถานะทุกสาขา
app.get("/api/admin/overview", (req, res) => {
  const overview = Object.entries(store.branches).map(([branchId, info]) => {
    const bays = store.jobs[branchId] || {};
    const activeBays = Object.values(bays).filter(Boolean).length;
    const allJobs = Object.values(bays).filter(Boolean).flatMap((j) => j.jobs);
    return {
      branchId,
      ...info,
      activeBays,
      emptyBays: info.bays - activeBays,
      totalJobs: allJobs.length,
      doneJobs: allJobs.filter((j) => j.status === "done").length,
      inProgressJobs: allJobs.filter((j) => j.status === "in_progress").length,
    };
  });
  res.json({ overview, updatedAt: new Date().toISOString() });
});

// Health check
app.get("/", (req, res) => res.json({ status: "TirePlus Backend OK 🚗", time: new Date().toISOString() }));

// ─── Helpers ───────────────────────────────────────────────
function getDuration(jobName) {
  const map = { ยาง: 45, ตั้งศูนย์: 60, ถ่วงล้อ: 30, แบตเตอรี่: 20, เบรค: 50, โช้คอัพ: 90, น้ำมันเครื่อง: 25, "Cockpit Sure": 35, อื่นๆ: 40 };
  return map[jobName] || 30;
}

// ─── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 TirePlus Backend running on port ${PORT}`));
