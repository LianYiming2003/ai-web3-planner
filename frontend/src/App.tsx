import { useState, useEffect } from "react";
import { useWallet } from "./hooks/useWallet";
import { Contract } from "ethers";
import "./App.css";

// 1) 你 TaskManager 的 ABI（只保留你要用到的函数）
//   为啥要 ABI？因为 ethers 需要 ABI 才知道怎么编码调用。
//   替代方案：import 你 hardhat artifacts 的完整 abi JSON。
const TASK_MANAGER_ABI = [
  "function createTask(string ipfsHash, uint256 dueAt, uint8 priority) external",
  "function nextId() view returns (uint256)",
  "function tasks(uint256) view returns (uint256 id, address owner, string ipfsHash, uint256 dueAt, uint8 priority, uint8 status, uint256 createdAt)"
];

// 2) 合约地址（你部署后填这里 or 用 env）
//   为啥 env 更好？不同网络不同地址，切网不用改代码。
const TASK_MANAGER_ADDRESS = import.meta.env.VITE_TASK_MANAGER_ADDR as string;

type ParsedTask = {
  title: string;
  description?: string;
  due?: string; // ISO string
  priority: number; // 1-5
  durationMinutes?: number;
};

function App() {
  const { provider, account, connect, error } = useWallet();

  const [chainId, setChainId] = useState<number | null>(null);
  const [msg, setMsg] = useState("");

  // ---- Week 3 新增状态 ----
  const [inputText, setInputText] = useState("");
  const [parsedTask, setParsedTask] = useState<ParsedTask | null>(null);
  const [ipfsCid, setIpfsCid] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!provider || !account) return;
    provider
      .getNetwork()
      .then((net) => {
        setChainId(Number(net.chainId));
        setMsg("");
      })
      .catch((err) => setMsg(err.message));
  }, [provider, account]);

  const shouldShowConnect =
    !account && (!error || !error.startsWith("No Ethereum wallet found"));

  // 3) 核心：自然语言 → 后端解析+IPFS → 上链
  const handleAskGene = async () => {
    if (!provider || !account) {
      setMsg("Please connect wallet first.");
      return;
    }
    if (!inputText.trim()) {
      setMsg("Input text is empty.");
      return;
    }

    setLoading(true);
    setMsg("");
    setParsedTask(null);
    setIpfsCid(null);
    setTxHash(null);

    try {
      // --- A) 调后端 parsing endpoint ---
      // 为啥要后端？因为 OpenAI key 和 IPFS token 不能暴露在前端。
      const resp = await fetch("http://localhost:4000/api/parse-and-store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: inputText })
      });

      if (!resp.ok) {
        throw new Error(`Parsing endpoint failed: ${resp.status}`);
      }

      const data = await resp.json();
      const parsed: ParsedTask = data.parsed;
      const cid: string = data.ipfsCid;

      setParsedTask(parsed);
      setIpfsCid(cid);

      // --- B) 计算 dueTs 并上链 ---
      // 合约要 uint 秒级时间戳
      // 如果 parsed.due 缺失，就设置为 0（你也可以改成 now+1day）
      const dueTs = parsed.due
        ? Math.floor(new Date(parsed.due).getTime() / 1000)
        : 0;

      // priority 强制转 number，再 clamp 到 uint8 范围
      const priority = Math.max(1, Math.min(5, Number(parsed.priority || 3)));

      // ethers v6: provider.getSigner()
      const signer = await provider.getSigner();
      const taskManager = new Contract(
        TASK_MANAGER_ADDRESS,
        TASK_MANAGER_ABI,
        signer
      );

      const tx = await taskManager.createTask(cid, dueTs, priority);
      setMsg("Transaction sent, waiting confirmation...");
      const receipt = await tx.wait();

      setTxHash(receipt.hash);
      setMsg("Task created on-chain ✅");
    } catch (e: any) {
      console.error(e);
      setMsg(e.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-container">
      <h1 className="app-title">Week 3 - Ask Gene Demo</h1>
      <hr className="app-divider" />

      {account && (
        <div>
          <p><b>Account:</b> {account}</p>
          <p><b>Chain ID:</b> {chainId ?? "-"}</p>
        </div>
      )}

      {shouldShowConnect && (
        <button
          className="app-connect-btn"
          onClick={() => connect()}
        >
          Connect Wallet
        </button>
      )}

      {/* ---- Week 3 UI：Ask Gene 输入框 ---- */}
      {account && (
        <div style={{ marginTop: 20 }}>
          <p><b>Ask Gene</b></p>
          <input
            style={{ width: "100%", padding: 8 }}
            placeholder='e.g. "Tomorrow 3pm finish CS544 HW, priority 4, 90min"'
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            disabled={loading}
          />
          <button
            style={{ marginTop: 10 }}
            className="app-connect-btn"
            onClick={handleAskGene}
            disabled={loading}
          >
            {loading ? "Processing..." : "Create Task"}
          </button>
        </div>
      )}

      {/* ---- 展示解析结果 + cid + tx ---- */}
      {parsedTask && (
        <div style={{ marginTop: 20 }}>
          <h3>Parsed Task (from GPT)</h3>
          <pre style={{ background: "#111", padding: 10 }}>
            {JSON.stringify(parsedTask, null, 2)}
          </pre>
        </div>
      )}

      {ipfsCid && (
        <p style={{ marginTop: 10 }}>
          <b>IPFS CID:</b> {ipfsCid}
        </p>
      )}

      {txHash && (
        <p style={{ marginTop: 10 }}>
          <b>Tx Hash:</b> {txHash}
        </p>
      )}

      {msg && <p style={{ color: "gray" }}>{msg}</p>}
      {error && <p className="app-error">{error}</p>}
    </div>
  );
}

export default App;
