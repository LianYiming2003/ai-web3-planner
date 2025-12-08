// src/App.tsx
import { useState, useEffect } from "react";
import { Contract, ethers } from "ethers";
import { useWallet } from "./hooks/useWallet";
import TaskInbox from "./components/TaskInbox";
import TaskCalendar from "./components/TaskCalendar";
import TaskManagerABIJson from "./abis/TaskManager.json";
import "./App.css";

// ----------------- 合约 ABI & 地址 -----------------
const TASK_MANAGER_ABI =
  (TaskManagerABIJson as any).abi ?? TaskManagerABIJson;

const TASK_MANAGER_ADDRESS = import.meta.env
  .VITE_TASK_MANAGER_ADDR as string;

// ----------------- 类型定义 -----------------
export type OnChainTask = {
  id: bigint;
  owner: string;
  title: string;
  ipfsHash: string;
  dueAt: bigint;
  priority: number;
  status: number; // 0 Active, 1 Completed, 2 Cancelled
  createdAt: bigint;
  lastStart: bigint;
  lastEnd: bigint;
};

type ParsedTask = {
  title: string;
  description?: string;
  due?: string; // ISO string
  priority: number; // 1-5
  durationMinutes?: number;
};

// ----------------- 组件本体 -----------------
function App() {
  const { provider, account, connect, error } = useWallet();

  const [chainId, setChainId] = useState<number | null>(null);
  const [msg, setMsg] = useState("");

  // Week3：自然语言输入状态
  const [inputText, setInputText] = useState("");
  const [parsedTask, setParsedTask] = useState<ParsedTask | null>(null);
  const [ipfsCid, setIpfsCid] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Week5：给 Calendar 用的链上任务
  const [calendarTasks, setCalendarTasks] = useState<OnChainTask[]>([]);

  // 读取当前 chainId
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

  // ----------------- 工具函数：从合约加载任务 -----------------
  const loadCalendarTasks = async (
    contractInstance: Contract,
    userAccount: string,
    setter: (tasks: OnChainTask[]) => void
  ) => {
    const raw = await contractInstance.getTasksByOwner(userAccount);

    const normalized: OnChainTask[] = raw.map((t: any) => ({
      id: BigInt(t.id),
      owner: t.owner,
      title: t.title,
      ipfsHash: t.ipfsHash,
      dueAt: BigInt(t.dueAt),
      priority: Number(t.priority),
      status: Number(t.status),
      createdAt: BigInt(t.createdAt),
      lastStart: BigInt(t.lastStart ?? 0),
      lastEnd: BigInt(t.lastEnd ?? 0),
    }));

    setter(normalized);
  };

  // 供 TaskInbox / TaskCalendar 调用的刷新函数
  const refreshCalendarTasks = async () => {
    if (!provider || !account) return;
    const signer = await provider.getSigner();
    const contract = new Contract(
      TASK_MANAGER_ADDRESS,
      TASK_MANAGER_ABI,
      signer
    );
    await loadCalendarTasks(contract, account, setCalendarTasks);
  };

  // provider 或 account 变化时，自动拉一次任务给 Calendar
  useEffect(() => {
    if (!provider || !account) return;
    refreshCalendarTasks().catch((e) =>
      console.warn("refreshCalendarTasks error:", e)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, account]);

  // ----------------- Week3：自然语言 → 后端解析 + IPFS → 上链 -----------------
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
      // A) 调后端解析接口
      const backendUrl =
        import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

      const resp = await fetch(`${backendUrl}/api/parse-and-store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: inputText }),
      });

      if (!resp.ok) {
        throw new Error(`Parsing endpoint failed: ${resp.status}`);
      }

      const data = await resp.json();
      const parsed: ParsedTask = data.parsed;
      const cid: string = data.ipfsCid;

      setParsedTask(parsed);
      setIpfsCid(cid);

      // B) 计算 dueTs 并上链
      const dueTs = parsed.due
        ? Math.floor(new Date(parsed.due).getTime() / 1000)
        : 0;

      const priority = Math.max(1, Math.min(5, Number(parsed.priority || 3)));

      // 从 parsed / 输入里搞一个 title 上链
      const titleForChain =
        parsed.title && parsed.title.trim().length > 0
          ? parsed.title.trim()
          : inputText.slice(0, 80); // 防止为空，直接取前 80 个字符当标题

      const signer = await provider.getSigner();
      const taskManager = new Contract(
        TASK_MANAGER_ADDRESS,
        TASK_MANAGER_ABI,
        signer
      );

      const tx = await taskManager.createTask(
        titleForChain,
        cid,
        dueTs,
        priority
      );
      setMsg("Transaction sent, waiting confirmation...");
      const receipt = await tx.wait();

      setTxHash(receipt.hash);
      setMsg("Task created on-chain ✅");

      // C) 上链成功后刷新给 Calendar 用的任务
      await refreshCalendarTasks();
    } catch (e: any) {
      console.error(e);
      setMsg(e.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  // ----------------- 渲染 -----------------
  return (
    <div className="app-container">
      <h1 className="app-title">Week 5 Demo</h1>
      <hr className="app-divider" />

      {account && (
        <div>
          <p>
            <b>Account:</b> {account}
          </p>
          <p>
            <b>Chain ID:</b> {chainId ?? "-"}
          </p>
        </div>
      )}

      {shouldShowConnect && (
        <button className="app-connect-btn" onClick={() => connect()}>
          Connect Wallet
        </button>
      )}

      {/* Week3：Ask Gene 输入区 */}
      {account && (
        <div style={{ marginTop: 20 }}>
          <p>
            <b>Ask Gene</b>
          </p>
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

      {/* 展示解析结果 + CID + Tx */}
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

      {/* Week4：Task Inbox 列表 */}
      {account && provider && (
        <div style={{ marginTop: 40 }}>
          <TaskInbox
            provider={provider as any}
            account={account}
            // TaskInbox 修改任务状态 / due 之后，通知 App 刷新 Calendar 数据
            onTasksChanged={refreshCalendarTasks}
          />
        </div>
      )}

      {/* Week5：Calendar 视图（Google Calendar + time-blocked tasks） */}
      {account && provider && (
        <div style={{ marginTop: 40 }}>
          <h2>Calendar & Time Blocking</h2>
          <TaskCalendar
            tasks={calendarTasks}
            provider={provider as any}
            onTasksChanged={refreshCalendarTasks}
          />
        </div>
      )}
    </div>
  );
}

export default App;


