// backend/server.js
const express = require("express");
const cors = require("cors");

const app = express();

// 允许前端（不同端口）访问
app.use(cors());
// 自动解析 JSON body
app.use(express.json());

// 这个就是 POST /api/parse-and-store
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
      durationMinutes: 60
    };

    const fakeCid = "bafyfakecid1234567890"; // 先随便写一个

    res.json({
      parsed: fakeParsed,
      ipfsCid: fakeCid
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: err.message || "Internal server error in parse-and-store" });
  }
});

// 监听 4000 端口
const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
