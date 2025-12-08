// src/components/TaskInbox.tsx
import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import TaskManagerABI from "../abis/TaskManager.json";

const TASK_MANAGER_ADDRESS = import.meta.env
  .VITE_TASK_MANAGER_ADDR as string;

type Status = "Active" | "Completed" | "Cancelled";

type Task = {
  id: number;
  owner: string;
  title: string;
  ipfsHash: string;
  dueAt: Date | null;
  priority: number;
  status: Status;
  createdAt: Date;
  source: "gpt" | "calendar" | "manual";
};

type Suggestion = {
  label: string;
  action: "postpone" | "do_now" | "ignore";
};

interface Props {
  provider: ethers.providers.Web3Provider | null;
  account: string | null;
  // ✅ 新增：TaskInbox 外面（App）可以传进来的回调，用来刷新 calendarTasks
  onTasksChanged?: () => Promise<void> | void;
}

const TaskInbox: React.FC<Props> = ({ provider, account, onTasksChanged }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [txPendingId, setTxPendingId] = useState<number | null>(null);

  // 过滤 & 排序
  const [filterStatus, setFilterStatus] = useState<"all" | Status>("all");
  const [filterPriority, setFilterPriority] = useState<"all" | number>("all");
  const [filterHasDue, setFilterHasDue] = useState<
    "all" | "hasDue" | "noDue"
  >("all");
  const [sortBy, setSortBy] = useState<"due" | "priority">("due");

  // AI 建议缓存
  const [suggestions, setSuggestions] = useState<
    Record<number, Suggestion | null>
  >({});

  // ------------------ 1. 从合约拉任务 ------------------
  useEffect(() => {
    if (!provider || !account) return;

    (async () => {
      setLoading(true);
      try {
        const signer = provider.getSigner();
        const abi = (TaskManagerABI as any).abi ?? TaskManagerABI;
        const tm = new ethers.Contract(TASK_MANAGER_ADDRESS, abi, signer);

        const rawTasks: any[] = await tm.getTasksByOwner(account);

        const mapped: Task[] = rawTasks.map((t: any) => {
          const statusNum = Number(t.status);
          const status: Status =
            statusNum === 0
              ? "Active"
              : statusNum === 1
              ? "Completed"
              : "Cancelled";

          const dueAtNum = Number(t.dueAt);
          const createdAtNum = Number(t.createdAt);

          let source: Task["source"] = "manual";
          if (typeof t.ipfsHash === "string") {
            if (t.ipfsHash.startsWith("gpt")) source = "gpt";
            else if (t.ipfsHash.startsWith("cal")) source = "calendar";
          }

          return {
            id: Number(t.id),
            owner: t.owner,
            title: t.title,
            ipfsHash: t.ipfsHash,
            dueAt: dueAtNum > 0 ? new Date(dueAtNum * 1000) : null,
            priority: Number(t.priority),
            status,
            createdAt: new Date(createdAtNum * 1000),
            source,
          };
        });

        // 不显示 Cancelled
        setTasks(mapped.filter((t) => t.status !== "Cancelled"));
      } catch (err) {
        console.error("load tasks error", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [provider, account]);

  // ------------------ 2. 本地过滤 + 排序 ------------------
  const visibleTasks = useMemo(() => {
    let list = [...tasks];

    if (filterStatus !== "all") {
      list = list.filter((t) => t.status === filterStatus);
    }
    if (filterPriority !== "all") {
      list = list.filter((t) => t.priority === filterPriority);
    }
    if (filterHasDue === "hasDue") {
      list = list.filter((t) => t.dueAt !== null);
    } else if (filterHasDue === "noDue") {
      list = list.filter((t) => t.dueAt === null);
    }

    list.sort((a, b) => {
      if (sortBy === "due") {
        const aTs = a.dueAt ? a.dueAt.getTime() : Number.MAX_SAFE_INTEGER;
        const bTs = b.dueAt ? b.dueAt.getTime() : Number.MAX_SAFE_INTEGER;
        return aTs - bTs;
      }
      return b.priority - a.priority;
    });

    return list;
  }, [tasks, filterStatus, filterPriority, filterHasDue, sortBy]);

  // ------------------ 3. 合约操作封装 ------------------
  async function updateStatus(id: number, newStatus: number) {
    if (!provider) return;
    setTxPendingId(id);
    try {
      const signer = provider.getSigner();
      const abi = (TaskManagerABI as any).abi ?? TaskManagerABI;
      const tm = new ethers.Contract(TASK_MANAGER_ADDRESS, abi, signer);
      const tx = await tm.setStatus(id, newStatus);
      await tx.wait();

      // ✅ 通知外层（App）重新从链上拉任务，更新 Calendar
      if (onTasksChanged) {
        await onTasksChanged();
      }

      setTasks((prev) => {
        // 2 = Cancelled: 直接从列表移除（软删）
        if (newStatus === 2) {
          return prev.filter((t) => t.id !== id);
        }
        const newStatusStr: Status =
          newStatus === 0
            ? "Active"
            : newStatus === 1
            ? "Completed"
            : "Cancelled";
        return prev.map((t) =>
          t.id === id ? { ...t, status: newStatusStr } : t
        );
      });
    } catch (e) {
      console.error("updateStatus error", e);
    } finally {
      setTxPendingId(null);
    }
  }

  async function handleComplete(id: number) {
    await updateStatus(id, 1); // Completed
  }

  async function handleDelete(id: number) {
    await updateStatus(id, 2); // Cancelled -> 从 UI 移除
  }

  async function handleReschedule(id: number, newDate: Date) {
    if (!provider) return;
    setTxPendingId(id);
    try {
      const signer = provider.getSigner();
      const abi = (TaskManagerABI as any).abi ?? TaskManagerABI;
      const tm = new ethers.Contract(TASK_MANAGER_ADDRESS, abi, signer);
      const newTs = Math.floor(newDate.getTime() / 1000);
      const tx = await tm.rescheduleTask(id, newTs);
      await tx.wait();

      // ✅ 通知外层刷新 Calendar 任务
      if (onTasksChanged) {
        await onTasksChanged();
      }

      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, dueAt: newDate } : t))
      );
    } catch (e) {
      console.error("reschedule error", e);
    } finally {
      setTxPendingId(null);
    }
  }

  // ------------------ 4. AI Suggest（保持原来的兜底实现） ------------------
  async function fetchSuggestion(taskId: number) {
    try {
      const resp = await fetch(`/api/gpt/suggest?taskId=${taskId}`);
      if (!resp.ok) throw new Error("suggest api error");
      const data = (await resp.json()) as Suggestion;
      setSuggestions((prev) => ({ ...prev, [taskId]: data }));
    } catch (e) {
      console.error("suggestion error", e);
      setSuggestions((prev) => ({
        ...prev,
        [taskId]: {
          label: "No AI suggestion available right now.",
          action: "ignore",
        },
      }));
    }
  }

  // ------------------ 5. 渲染 ------------------
  return (
    <div className="space-y-3 mt-6">
      <h2 className="text-xl font-bold">Task Inbox</h2>

      {/* Filter bar（去掉 Deleted 选项） */}
      <div className="flex flex-wrap gap-3 items-center text-sm">
        <label>
          Status:{" "}
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as any)}
          >
            <option value="all">All</option>
            <option value="Active">Active</option>
            <option value="Completed">Completed</option>
          </select>
        </label>

        <label>
          Priority:{" "}
          <select
            value={filterPriority}
            onChange={(e) =>
              setFilterPriority(
                e.target.value === "all" ? "all" : Number(e.target.value)
              )
            }
          >
            <option value="all">All</option>
            {[1, 2, 3, 4, 5].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <label>
          Date:{" "}
          <select
            value={filterHasDue}
            onChange={(e) =>
              setFilterHasDue(e.target.value as "all" | "hasDue" | "noDue")
            }
          >
            <option value="all">All</option>
            <option value="hasDue">Has due date</option>
            <option value="noDue">No due date</option>
          </select>
        </label>

        <label>
          Sort by:{" "}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as "due" | "priority")}
          >
            <option value="due">Due date</option>
            <option value="priority">Priority</option>
          </select>
        </label>
      </div>

      {loading && <div>Loading tasks...</div>}

      <div className="space-y-2">
        {visibleTasks.map((t) => {
          const isPending = txPendingId === t.id;
          const sugg = suggestions[t.id] ?? null;

          return (
            <div
              key={t.id}
              className="border rounded-lg px-3 py-2 flex justify-between items-center"
            >
              {/* 左边：标题 + 详情 */}
              <div className="space-y-1">
                <div className="text-base font-semibold">
                  {t.title || `Task #${t.id}`}
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <span className="px-2 py-0.5 rounded-full border">
                    {t.status}
                  </span>
                  <span>·</span>
                  <span>
                    Priority: <b>{t.priority}</b>
                  </span>
                  <span>·</span>
                  <span className="opacity-70">
                    {t.source === "gpt"
                      ? "🤖 GPT"
                      : t.source === "calendar"
                      ? "📅 Cal"
                      : "✍️ Manual"}
                  </span>
                </div>

                <div className="text-xs">
                  Due: {t.dueAt ? t.dueAt.toLocaleString() : "no deadline"}
                </div>
                <div className="text-xs text-gray-400">
                  Created: {t.createdAt.toLocaleString()}
                </div>

                <div className="text-xs">
                  IPFS:{" "}
                  {t.ipfsHash ? t.ipfsHash.slice(0, 18) + "..." : "(none)"}
                </div>

                {/* AI Suggest */}
                <div className="text-xs mt-1">
                  {!sugg ? (
                    <button
                      className="underline"
                      onClick={() => fetchSuggestion(t.id)}
                    >
                      Ask AI: what to do?
                    </button>
                  ) : (
                    <div className="flex gap-2 items-center">
                      <span>{sugg.label}</span>
                      {sugg.action === "postpone" && (
                        <button
                          className="px-2 py-1 border rounded text-xs"
                          disabled={isPending}
                          onClick={() => {
                            const base = t.dueAt || new Date();
                            const newDate = new Date(
                              base.getTime() + 24 * 3600 * 1000
                            );
                            handleReschedule(t.id, newDate);
                          }}
                        >
                          Postpone 1 day
                        </button>
                      )}
                      {sugg.action === "do_now" && (
                        <button
                          className="px-2 py-1 border rounded text-xs"
                          disabled={isPending}
                          onClick={() => handleComplete(t.id)}
                        >
                          Do now ✅
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* 右边：动作按钮 */}
              <div className="flex flex-col gap-1 text-xs items-end">
                <button
                  disabled={isPending || t.status !== "Active"}
                  onClick={() => handleComplete(t.id)}
                >
                  {isPending ? "Pending..." : "Complete"}
                </button>
                <button
                  disabled={isPending}
                  onClick={() => {
                    const newDateStr = prompt(
                      "New due date (YYYY-MM-DD HH:mm, local time)?"
                    );
                    if (!newDateStr) return;
                    const newDate = new Date(newDateStr);
                    if (isNaN(newDate.getTime())) {
                      alert("Invalid date");
                    } else {
                      handleReschedule(t.id, newDate);
                    }
                  }}
                >
                  Reschedule
                </button>
                <button
                  disabled={isPending}
                  onClick={() => {
                    if (confirm("Soft delete this task?")) {
                      handleDelete(t.id);
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}

        {!loading && visibleTasks.length === 0 && (
          <div>No tasks for this account yet.</div>
        )}
      </div>
    </div>
  );
};

export default TaskInbox;
