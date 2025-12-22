// backend/server.js
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const { ethers } = require("ethers");
const path = require("path");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* -------------------- 现有：parse-and-store -------------------- */

app.post("/api/parse-and-store", async (req, res) => {
  try {
    const { text } = req.body;
    console.log("Received text:", text);

    // 先用一个假解析结果，确认前后端能连通
    const fakeParsed = {
      title: "Fake task from backend",
      description: text,
      due: null,
      priority: 3,
      durationMinutes: 60,
    };

    const fakeCid = "bafyfakecid1234567890"; // 先随便写一个

    res.json({
      parsed: fakeParsed,
      ipfsCid: fakeCid,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message || "Internal server error in parse-and-store",
    });
  }
});

/* -------------------- Google Calendar 配置 -------------------- */

// 创建 OAuth2 client（这里先用固定 refresh_token 简化）
function getOAuthClient() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  if (process.env.GOOGLE_REFRESH_TOKEN) {
    oAuth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
  }

  return oAuth2Client;
}

function getEventsClient() {
  return google.calendar("v3").events;
}

/* -------------------- Ethers + TaskManager 合约 -------------------- */

// 注意：这里假设你把 Hardhat 的 TaskManager.json 放到了 backend 根目录
const TaskManagerArtifact = require(path.join(__dirname, "TaskManager.json"));

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);

const taskManager = new ethers.Contract(
  process.env.TASK_MANAGER_ADDRESS,
  TaskManagerArtifact.abi,
  wallet
);

/* -------------------- 日历 API：获取 Google 事件 -------------------- */

// GET /api/calendar/events?timeMin=xxx&timeMax=yyy
app.get("/api/calendar/events", async (req, res) => {
  try {
    const auth = getOAuthClient();
    const eventsClient = getEventsClient();

    const now = new Date();
    const weekLater = new Date(now.getTime() + 7 * 24 * 3600 * 1000);

    const timeMin = req.query.timeMin || now.toISOString();
    const timeMax = req.query.timeMax || weekLater.toISOString();

    const response = await eventsClient.list({
      auth,
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
    });

    res.json(response.data.items || []);
  } catch (err) {
    console.error("Error listing events:", err);
    res.status(500).json({ error: "failed to list events" });
  }
});

/* --------- 日历 API：从 task 创建一个 Google Calendar 事件 --------- */

// POST /api/calendar/events
// body: { taskId, title, description, start, end }
app.post("/api/calendar/events", async (req, res) => {
  try {
    const { taskId, title, description, start, end } = req.body;

    const auth = getOAuthClient();
    const eventsClient = getEventsClient();

    const response = await eventsClient.insert({
      auth,
      calendarId: "primary",
      requestBody: {
        summary: title,
        description,
        start: { dateTime: new Date(start).toISOString() },
        end: { dateTime: new Date(end).toISOString() },
        extendedProperties: {
          private: {
            taskId: String(taskId),
          },
        },
      },
    });

    res.json(response.data);
  } catch (err) {
    console.error("Error creating event:", err);
    res.status(500).json({ error: "failed to create event" });
  }
});

/* ---- 日历 API：更新时间块 + 调 TaskManager.logScheduleChange ---- */

// PATCH /api/calendar/events/:eventId
// body: { taskId, start, end, ipfsCidOfChange }
app.patch("/api/calendar/events/:eventId", async (req, res) => {
  try {
    const { eventId } = req.params;
    const { taskId, start, end, ipfsCidOfChange } = req.body;

    const auth = getOAuthClient();
    const eventsClient = getEventsClient();

    // 1) 先更新 Google Calendar 事件时间
    const patched = await eventsClient.patch({
      auth,
      calendarId: "primary",
      eventId,
      requestBody: {
        start: { dateTime: new Date(start).toISOString() },
        end: { dateTime: new Date(end).toISOString() },
      },
    });

    // 2) 再在链上记一条「时间修改」的审计日志
    const newStartTs = Math.floor(new Date(start).getTime() / 1000);
    const newEndTs = Math.floor(new Date(end).getTime() / 1000);

    const tx = await taskManager.logScheduleChange(
      taskId,
      newStartTs,
      newEndTs,
      ipfsCidOfChange || ""
    );
    await tx.wait();

    res.json({ calendarEvent: patched.data, txHash: tx.hash });
  } catch (err) {
    console.error("Error patching event / logging schedule:", err);
    res.status(500).json({ error: "failed to patch event or log on-chain" });
  }
});

/* ==================== Week6：Meeting store + dummy recap（不需要 OpenAI）==================== */

// 依赖：npm i web3.storage
let Web3Storage, File;
try {
  ({ Web3Storage, File } = require("web3.storage"));
} catch (e) {
  console.warn("web3.storage not installed yet. (OK for now, will use fake CID)");
}

function getW3() {
  const token = process.env.WEB3STORAGE_TOKEN;
  if (!token) return null;
  if (!Web3Storage) return null;
  return new Web3Storage({ token });
}

async function putDir(files) {
  const w3 = getW3();
  if (!w3) return null;
  return await w3.put(files, { wrapWithDirectory: true });
}

function yyyyMmDdPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// POST /api/meeting/store
// body: { title, attendees: string[], notes, startAt, endAt }
app.post("/api/meeting/store", async (req, res) => {
  try {
    const { title, attendees, notes, startAt, endAt } = req.body || {};
    if (!title || !startAt || !endAt) {
      return res.status(400).json({ error: "title, startAt, endAt are required" });
    }

    const meeting = {
      title,
      attendees: Array.isArray(attendees) ? attendees : [],
      notes: notes || "",
      startAt,
      endAt,
      createdAt: new Date().toISOString(),
    };

    // if no web3.storage token, return fake
    if (!File || !getW3()) {
      return res.json({ cid: "bafyfakecid-meeting-dev", path: "meeting.json", meeting });
    }

    const cid = await putDir([
      new File([JSON.stringify(meeting, null, 2)], "meeting.json", { type: "application/json" }),
    ]);

    res.json({ cid, path: "meeting.json", meeting });
  } catch (e) {
    console.error("meeting/store error:", e);
    res.status(500).json({ error: e.message || "meeting store failed" });
  }
});

// POST /api/meeting/recap
// body: { meeting: {...} }
app.post("/api/meeting/recap", async (req, res) => {
  try {
    const { meeting } = req.body || {};
    if (!meeting || !meeting.title) {
      return res.status(400).json({ error: "meeting is required" });
    }

    // ✅ Dummy recap generator（后面你有 OpenAI key 再替换这一段）
    const title = meeting.title || "(Untitled)";
    const attendees = Array.isArray(meeting.attendees) ? meeting.attendees : [];
    const notes = meeting.notes || "";
    const startAt = meeting.startAt || "";
    const endAt = meeting.endAt || "";

    const recapJson = {
      title,
      summary_bullets: [
        "This is a placeholder recap (no OpenAI API key configured).",
        "It demonstrates the pipeline: Meeting → Recap JSON/MD → IPFS → on-chain pointer.",
        notes ? `Notes length: ${String(notes).length} characters.` : "No notes provided.",
      ],
      action_items: [
        {
          title: "Follow up on discussion points",
          owner: attendees[0] || "Unassigned",
          due: yyyyMmDdPlus(2),
          priority: 3,
        },
        {
          title: "Draft next steps / plan",
          owner: attendees[1] || attendees[0] || "Unassigned",
          due: yyyyMmDdPlus(4),
          priority: 3,
        },
        {
          title: "Schedule the next meeting",
          owner: "Unassigned",
          due: null,
          priority: 2,
        },
      ],
    };

    const actionItems = recapJson.action_items;

    const md = [
      `# ${title}`,
      "",
      startAt || endAt ? `**When:** ${startAt} → ${endAt}` : "",
      attendees.length ? `**Attendees:** ${attendees.join(", ")}` : "",
      "",
      "## Summary",
      ...recapJson.summary_bullets.map((b) => `- ${b}`),
      "",
      "## Action Items",
      ...actionItems.map((ai) => {
        const due = ai.due ? ` (due ${ai.due})` : "";
        return `- ${ai.title} — **${ai.owner}**${due}`;
      }),
      "",
      "---",
      "Generated by dummy backend recap (no OpenAI).",
    ]
      .filter(Boolean)
      .join("\n");

    // if no web3.storage token, return fake CID but still return content
    if (!File || !getW3()) {
      return res.json({
        recapCid: "bafyfakecid-recap-dev",
        actionItems,
        recapMd: md,
        recapJson,
      });
    }

    const files = [
      new File([JSON.stringify(recapJson, null, 2)], "recap.json", { type: "application/json" }),
      new File([md], "recap.md", { type: "text/markdown" }),
      new File([JSON.stringify(actionItems, null, 2)], "action_items.json", { type: "application/json" }),
    ];

    actionItems.forEach((ai, i) => {
      files.push(
        new File([JSON.stringify(ai, null, 2)], `action_item_${i}.json`, { type: "application/json" })
      );
    });

    const recapCid = await putDir(files);

    res.json({ recapCid, actionItems, recapMd: md, recapJson });
  } catch (e) {
    console.error("meeting/recap error:", e);
    res.status(500).json({ error: e.message || "meeting recap failed" });
  }
});

/* -------------------- 启动服务器 -------------------- */

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
