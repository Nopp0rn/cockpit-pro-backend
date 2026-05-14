```javascript
// ───────────────────────────────────────────────────────────
//  Cockpit Pro Backend
//  LINE OA + Firebase + Multi Branch
// ───────────────────────────────────────────────────────────

const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

// ───────────────────────────────────────────────────────────
// Firebase Init
// ───────────────────────────────────────────────────────────

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ───────────────────────────────────────────────────────────
// Middleware
// ───────────────────────────────────────────────────────────

app.use(cors({
  origin: "*",
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

app.options("*", cors());

app.use("/webhook", express.raw({
  type: "application/json"
}));

app.use(express.json());

// ───────────────────────────────────────────────────────────
// LINE Config
// ───────────────────────────────────────────────────────────

const LINE_API = "https://api.line.me/v2/bot";

function getBranchToken(branchId) {
  return (
    process.env[`LINE_TOKEN_${branchId}`] ||
    process.env.LINE_CHANNEL_ACCESS_TOKEN
  );
}

function getBranchSecret(branchId) {
  return (
    process.env[`LINE_SECRET_${branchId}`] ||
    process.env.LINE_CHANNEL_SECRET
  );
}

function cleanBranchId(branchId) {
  if (!branchId) return "BR107";
  return String(branchId).trim().toUpperCase();
}

// ───────────────────────────────────────────────────────────
// Push LINE Message
// ───────────────────────────────────────────────────────────

async function pushMessage(
  userId,
  messages,
  branchId = "BR107"
) {

  const token = getBranchToken(branchId);

  try {

    await axios.post(
      `${LINE_API}/message/push`,
      {
        to: userId,
        messages,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    console.log(
      `✅ Push sent to ${userId} via ${branchId}`
    );

  } catch (err) {

    console.error(
      `❌ Push error [${branchId}]:`,
      err.response?.data || err.message
    );
  }
}

// ───────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────

function normalizePlate(plate) {

  if (!plate) return "";

  return plate
    .normalize("NFC")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function getDuration(name) {

  const map = {
    ยาง: 45,
    ตั้งศูนย์: 60,
    ถ่วงล้อ: 30,
    แบตเตอรี่: 20,
    เบรค: 50,
    โช้คอัพ: 90,
    น้ำมันเครื่อง: 25,
    "Cockpit Sure": 35,
    อื่นๆ: 40,
  };

  return map[name] || 30;
}

// ───────────────────────────────────────────────────────────
// Resolve UserId
// ───────────────────────────────────────────────────────────

async function resolveUserId(job) {

  if (job.userId) {

    return {
      userId: job.userId,
      branchId: cleanBranchId(job.branchId),
    };
  }

  if (!job.plate) return null;

  const normalizedPlate =
    normalizePlate(job.plate);

  try {

    const snap =
      await db.collection("lineUsers").get();

    for (const doc of snap.docs) {

      const data = doc.data();

      if (
        normalizePlate(data.plate) ===
        normalizedPlate
      ) {

        const userId = data.userId;

        const userBranchId =
          cleanBranchId(
            data.branchId || job.branchId
          );

        if (job._ref) {

          await job._ref.update({
            userId,
            branchId: userBranchId,
          });
        }

        console.log(
          `✅ resolveUserId: ${normalizedPlate}`
        );

        return {
          userId,
          branchId: userBranchId,
        };
      }
    }

  } catch (e) {

    console.error(
      "resolveUserId error:",
      e.message
    );
  }

  return null;
}

// ───────────────────────────────────────────────────────────
// Flex Message
// ───────────────────────────────────────────────────────────

function buildStatusFlex({
  plate,
  branchName,
  bay,
  bayStatus,
  jobs,
}) {

  const doneCount =
    jobs.filter(j => j.status === "done").length;

  const progress =
    Math.round((doneCount / jobs.length) * 100);

  const statusLabel = {
    waiting_entry: "🕐 รอเข้าช่องบริการ",
    in_service: "🔧 กำลังดำเนินการ",
    done: "✅ เสร็จเรียบร้อย",
  }[bayStatus] || "กำลังดำเนินการ";

  const jobRows = jobs.map(j => ({
    type: "box",
    layout: "horizontal",
    contents: [
      {
        type: "text",
        text:
          j.status === "done"
            ? "✅"
            : j.status === "in_progress"
            ? "🔧"
            : "⏳",
        size: "sm",
        flex: 0,
      },
      {
        type: "text",
        text: j.name,
        size: "sm",
        flex: 3,
        margin: "sm",
      },
      {
        type: "text",
        text: `${j.duration} นาที`,
        size: "xs",
        align: "end",
        flex: 2,
      },
    ],
    margin: "sm",
  }));

  return {
    type: "flex",
    altText: `[Cockpit] ${plate}`,
    contents: {
      type: "bubble",
      size: "mega",

      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#1A1A1A",

        contents: [
          {
            type: "text",
            text: "🚗 Cockpit Pro",
            color: "#FFE000",
            size: "sm",
            weight: "bold",
          },
          {
            type: "text",
            text: plate,
            color: "#FFFFFF",
            size: "xxl",
            weight: "bold",
            margin: "xs",
          },
          {
            type: "text",
            text: `${branchName} · ช่อง ${bay}`,
            color: "#9ca3af",
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
                flex: 3,
              },
              {
                type: "text",
                text: `${progress}%`,
                size: "sm",
                weight: "bold",
                align: "end",
                flex: 1,
              },
            ],
          },

          {
            type: "separator",
            margin: "md",
          },

          {
            type: "text",
            text: "รายการงาน",
            size: "xs",
            margin: "md",
            weight: "bold",
          },

          ...jobRows,
        ],

        paddingAll: "20px",
      },
    },
  };
}

// ───────────────────────────────────────────────────────────
// LINE Webhook
// ───────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {

  try {

    const signature =
      req.headers["x-line-signature"];

    const bodyBuf = req.body;

    let branchId = null;

    const env = process.env;

    const lineSecretKeys =
      Object.keys(env).filter(k =>
        k.startsWith("LINE_SECRET_")
      );

    for (const key of lineSecretKeys) {

      const secret = env[key];

      const hash = crypto
        .createHmac("sha256", secret)
        .update(bodyBuf)
        .digest("base64");

      if (hash === signature) {

        branchId =
          key.replace("LINE_SECRET_", "");

        break;
      }
    }

    if (
      !branchId &&
      process.env.LINE_CHANNEL_SECRET
    ) {

      const hash = crypto
        .createHmac(
          "sha256",
          process.env.LINE_CHANNEL_SECRET
        )
        .update(bodyBuf)
        .digest("base64");

      if (hash === signature) {
        branchId = "BR107";
      }
    }

    if (!branchId) {

      console.warn(
        "⚠️ Invalid webhook signature"
      );

      return res
        .status(401)
        .json({
          error: "Invalid signature",
        });
    }

    console.log(
      `📩 Webhook from ${branchId}`
    );

    const events =
      JSON.parse(bodyBuf).events;

    for (const event of events) {

      const userId =
        event.source?.userId;

      // ─────────────────────────
      // Follow Event
      // ─────────────────────────

      if (event.type === "follow") {

        const branchDoc =
          await db.collection("branches")
          .doc(branchId)
          .get();

        const branchName =
          branchDoc.exists
            ? branchDoc.data().name
            : "Cockpit";

        await pushMessage(
          userId,
          [{
            type: "text",
            text:
`🎉 ยินดีต้อนรับสู่ ${branchName}

พิมพ์ทะเบียนรถของคุณ
เพื่อรับแจ้งเตือนสถานะรถ 🚗`
          }],
          branchId
        );
      }

      // ─────────────────────────
      // Message Event
      // ─────────────────────────

      if (
        event.type === "message" &&
        event.message.type === "text"
      ) {

        const text =
          event.message.text
          .trim()
          .toUpperCase();

        // รองรับ:
        // กข1234
        // กก 9999
        // 1กก9999

        const plateRegex =
          /^([ก-ฮ]{1,3}\s?\d{1,4}|\d[ก-ฮ]{1,2}\s?\d{1,4})$/;

        // ถ้าไม่ใช่ทะเบียน
        // ไม่ตอบอะไรเลย

        if (!plateRegex.test(text)) {

          console.log(
            `⏭️ Ignore: ${text}`
          );

          continue;
        }

        const plate =
          text.replace(/\s+/g, "");

        console.log(
          `🚗 Plate: ${plate}`
        );

        // บันทึกทะเบียน

        await db.collection("lineUsers")
          .doc(userId)
          .set({
            userId,
            plate,
            branchId,
            updatedAt:
              new Date().toISOString(),
          }, {
            merge: true,
          });

        // ค้นหาในสาขา

        let snapshot =
          await db.collection("branches")
          .doc(branchId)
          .collection("bays")
          .where("plate", "==", plate)
          .where("bayStatus", "!=", "done")
          .limit(1)
          .get();

        // ถ้าไม่เจอ → ค้นหาทุกสาขา

        if (snapshot.empty) {

          snapshot =
            await db.collectionGroup("bays")
            .where("plate", "==", plate)
            .where("bayStatus", "!=", "done")
            .limit(1)
            .get();
        }

        // ─────────────────────
        // เจอรถในระบบ
        // ─────────────────────

        if (!snapshot.empty) {

          const doc =
            snapshot.docs[0];

          const job =
            doc.data();

          const branchRef =
            doc.ref.parent.parent;

          const foundBranchId =
            branchRef.id;

          const branchDoc =
            await branchRef.get();

          await doc.ref.update({
            userId,
          });

          await pushMessage(
            userId,
            [
              buildStatusFlex({
                plate: job.plate,
                branchName:
                  branchDoc.data()?.name ||
                  "Cockpit",
                bay: job.bay,
                bayStatus:
                  job.bayStatus,
                jobs: job.jobs,
              })
            ],
            foundBranchId
          );

          console.log(
            `✅ Status sent`
          );

        } else {

          // ─────────────────
          // ยังไม่มีรถในระบบ
          // ─────────────────

          await pushMessage(
            userId,
            [{
              type: "text",
              text:
`✅ รับทราบทะเบียน "${plate}" แล้วครับ

เมื่อรถเข้าระบบ
เราจะแจ้งเตือนผ่าน LINE นี้ทันที 🚗`
            }],
            branchId
          );

          console.log(
            `📭 Registered only`
          );
        }
      }
    }

    res.json({
      status: "ok",
    });

  } catch (err) {

    console.error(
      "Webhook error:",
      err.message
    );

    res.status(500).json({
      error: err.message,
    });
  }
});

// ───────────────────────────────────────────────────────────
// Health Check
// ───────────────────────────────────────────────────────────

app.get("/", (req, res) => {

  res.json({
    status: "Cockpit Pro Backend OK 🚗",
    time: new Date().toISOString(),
  });
});

// ───────────────────────────────────────────────────────────
// Start Server
// ───────────────────────────────────────────────────────────

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(
    `🚀 Server running on ${PORT}`
  );
});
```
