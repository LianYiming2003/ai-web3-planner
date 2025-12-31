// backend/server.js
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const { ethers } = require("ethers");
const path = require("path");

require("dotenv").config();

// Week7 optional: IPFS upload (Web3.Storage). If no token installed, will return fake CID.
let Web3Storage, File;
try {
  ({ Web3Storage, File } = require("web3.storage"));
} catch (e) {
  console.warn("web3.storage not installed (OK). Planner/recap will return fake CID.");
}

function getW3() {
  const token = process.env.WEB3STORAGE_TOKEN;
  if (!token || !Web3Storage) return null;
  return new Web3Storage({ token });
}

async function putDir(files) {
  const w3 = getW3();
  if (!w3) return null;
  // wrapWithDirectory makes URLs like https://<cid>.ipfs.w3s.link/<filename>
  return await w3.put(files, { wrapWithDirectory: true });
}

const app = express();

// 允许前端（不同端口）访问
app.use(cors());
// 自动解析 JSON body
app.use(express.json());

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
    res
      .status(500)
      .json({
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
const TaskManagerArtifact = require(path.join(
  __dirname,
  "TaskManager.json"
));

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
            taskId: String(taskId), // 把 taskId 挂到 event 上，之后拖拽还能知道对应哪个任务
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

    // 注意：这里的钱包是 WALLET_PRIVATE_KEY 对应的账户，
    // 必须和任务 owner 一致，合约里的 require(t.owner == msg.sender) 才会通过。
    const tx = await taskManager.logScheduleChange(
      taskId,
      newStartTs,
      newEndTs,
      ipfsCidOfChange
    );
    await tx.wait();

    res.json({ calendarEvent: patched.data, txHash: tx.hash });
  } catch (err) {
    console.error("Error patching event / logging schedule:", err);
    res
      .status(500)
      .json({ error: "failed to patch event or log on-chain" });
  }
});

/* -------------------- 启动服务器 -------------------- */

const PORT = process.env.PORT || 4000;

/* ==================== Week 7: Planner (no OpenAI, heuristic framework) ==================== */
// POST /api/planner
// body: { address, mode: "today" | "week" }
app.post("/api/planner", async (req, res) => {
  try {
    const { address, mode } = req.body || {};
    if (!address) return res.status(400).json({ error: "address is required" });
    const planMode = mode === "week" ? "week" : "today";

    // 1) Fetch tasks from chain
    // IMPORTANT: uses on-chain task list; does NOT require Google account linkage.
    const rawTasks = await taskManager.getTasksByOwner(address);

    // Keep only Active & non-meeting tasks for planning
    const tasks = rawTasks
      .filter((t) => Number(t.status) === 0)
      .filter((t) => !Boolean(t.isMeeting))
      .map((t) => ({
        id: Number(t.id),
        title: t.title,
        priority: Number(t.priority),
        dueAt: Number(t.dueAt || 0),
      }))
      .sort((a, b) => b.priority - a.priority);

    // 2) Build a very simple plan
    const now = new Date();
    const blocks = [];

    function startOfDay(d) {
      const x = new Date(d);
      x.setHours(0, 0, 0, 0);
      return x;
    }

    function nextHour(d) {
      const x = new Date(d);
      x.setMinutes(0, 0, 0);
      x.setHours(x.getHours() + 1);
      return x;
    }

    if (planMode === "today") {
      let cursor = nextHour(now);

      const startWindow = new Date(now);
      startWindow.setHours(9, 0, 0, 0);
      if (cursor < startWindow) cursor = startWindow;

      const endWindow = new Date(now);
      endWindow.setHours(17, 0, 0, 0);

      let i = 0;
      while (cursor < endWindow && i < tasks.length) {
        const t = tasks[i++];
        const end = new Date(cursor.getTime() + 60 * 60 * 1000);
        blocks.push({
          title: `Focus: ${t.title}`,
          start: cursor.toISOString(),
          end: end.toISOString(),
          taskId: t.id,
        });
        cursor = end;
      }
    } else {
      // next 5 days, 3 blocks per day
      const base = startOfDay(now);
      let idx = 0;
      for (let day = 0; day < 5; day++) {
        const d = new Date(base.getTime() + day * 24 * 3600 * 1000);

        const slots = [
          new Date(d.setHours(10, 0, 0, 0)),
          new Date(d.setHours(13, 0, 0, 0)),
          new Date(d.setHours(15, 0, 0, 0)),
        ];

        for (const s of slots) {
          if (idx >= tasks.length) break;
          const t = tasks[idx++];
          const e = new Date(s.getTime() + 60 * 60 * 1000);
          blocks.push({
            title: `Focus: ${t.title}`,
            start: s.toISOString(),
            end: e.toISOString(),
            taskId: t.id,
          });
        }
        if (idx >= tasks.length) break;
      }
    }

    const plan = {
      mode: planMode,
      owner: address,
      generatedAt: new Date().toISOString(),
      blocks,
      notes: "Heuristic planner (no OpenAI key). Replace with GPT later.",
    };

    // 3) Upload plan to IPFS if possible
    let cid = planMode === "today" ? "bafyfakecid-plan-today" : "bafyfakecid-plan-week";

    if (File && getW3()) {
      const md = [
        `# Plan (${planMode})`,
        "",
        `Owner: ${address}`,
        `Generated: ${plan.generatedAt}`,
        "",
        "## Blocks",
        ...blocks.map((b) => `- ${b.start} → ${b.end}: ${b.title}`),
        "",
        "---",
        "Generated by heuristic backend (no OpenAI).",
      ].join("\n");

      const uploaded = await putDir([
        new File([JSON.stringify(plan, null, 2)], "plan.json", { type: "application/json" }),
        new File([md], "plan.md", { type: "text/markdown" }),
      ]);
      if (uploaded) cid = uploaded;
    }

    const startTs = Math.floor(startOfDay(now).getTime() / 1000);
    res.json({ cid, startTs, plan });
  } catch (e) {
    console.error("planner error:", e);
    res.status(500).json({ error: e.message || "planner failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
