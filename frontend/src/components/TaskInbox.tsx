// src/components/TaskInbox.tsx
import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import TaskManagerABI from "../abis/TaskManager.json";

const TASK_MANAGER_ADDRESS = import.meta.env.VITE_TASK_MANAGER_ADDR as string;
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

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
  isMeeting?: boolean;
  lastStart?: number;
  lastEnd?: number;
};

type Suggestion = {
  label: string;
  action: "postpone" | "do_now" | "ignore";
};

interface Props {
  provider: any; // ethers v6 BrowserProvider (or compatible)
  account: string | null;
  onTasksChanged?: () => Promise<void> | void;
}

const TaskInbox: React.FC<Props> = ({ provider, account, onTasksChanged }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [txPendingId, setTxPendingId] = useState<number | null>(null);

  // ------------------ Create (Task / Meeting) ------------------
  const [createKind, setCreateKind] = useState<"task" | "meeting">("task");
  const [newTitle, setNewTitle] = useState("");
  const [newPriority, setNewPriority] = useState<number>(3);

  // task
  const [newDueAt, setNewDueAt] = useState(""); // datetime-local

  // meeting
  const [newStartAt, setNewStartAt] = useState(""); // datetime-local
  const [newEndAt, setNewEndAt] = useState(""); // datetime-local
  const [newAttendees, setNewAttendees] = useState(""); // comma separated
  const [newNotes, setNewNotes] = useState("");

  // 过滤 & 排序
  const [filterStatus, setFilterStatus] = useState<"all" | Status>("all");
  const [filterPriority, setFilterPriority] = useState<"all" | number>("all");
  const [filterHasDue, setFilterHasDue] = useState<"all" | "hasDue" | "noDue">(
    "all"
  );
  const [sortBy, setSortBy] = useState<"due" | "priority">("due");

  // AI 建议缓存
  const [suggestions, setSuggestions] = useState<Record<number, Suggestion | null>>(
    {}
  );

  async function loadTasks() {
    if (!provider || !account) return;

    setLoading(true);
    try {
      const signer = await provider.getSigner();
      const abi = (TaskManagerABI as any).abi ?? TaskManagerABI;
      const tm = new ethers.Contract(TASK_MANAGER_ADDRESS, abi, signer);

      const rawTasks: any[] = await tm.getTasksByOwner(account);

      const mapped: Task[] = rawTasks.map((t: any) => {
        const statusNum = Number(t.status);
        const status: Status =
          statusNum === 0 ? "Active" : statusNum === 1 ? "Completed" : "Cancelled";

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
          isMeeting: Boolean(t.isMeeting ?? false),
          lastStart: Number(t.lastStart ?? 0),
          lastEnd: Number(t.lastEnd ?? 0),
        };
      });

      // 不显示 Cancelled
      setTasks(mapped.filter((t) => t.status !== "Cancelled"));
    } catch (err) {
      console.error("load tasks error", err);
    } finally {
      setLoading(false);
    }
  }

  // ------------------ 1. 从合约拉任务 ------------------
  useEffect(() => {
    loadTasks().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, account]);

  // ------------------ 2. 本地过滤 + 排序 ------------------
  const visibleTasks = useMemo(() => {
    let list = [...tasks];

    if (filterStatus !== "all") list = list.filter((t) => t.status === filterStatus);
    if (filterPriority !== "all") list = list.filter((t) => t.priority === filterPriority);

    if (filterHasDue === "hasDue") list = list.filter((t) => t.dueAt !== null);
    else if (filterHasDue === "noDue") list = list.filter((t) => t.dueAt === null);

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

  // ------------------ Create helpers ------------------
  function toUnixSecondsFromDatetimeLocal(v: string): number {
    if (!v) return 0;
    const d = new Date(v);
    if (isNaN(d.getTime())) return 0;
    return Math.floor(d.getTime() / 1000);
  }

  async function handleCreate() {
    if (!provider || !account) {
      alert("Please connect wallet first.");
      return;
    }
    if (!newTitle.trim()) {
      alert("Title is required.");
      return;
    }

    try {
      const signer = await provider.getSigner();
      const abi = (TaskManagerABI as any).abi ?? TaskManagerABI;
      const tm = new ethers.Contract(TASK_MANAGER_ADDRESS, abi, signer);

      // Prevent double submit UX
      setTxPendingId(-1);

      if (createKind === "task") {
        const dueTs = toUnixSecondsFromDatetimeLocal(newDueAt);
        const ipfsHash = "manual";
        const tx = await tm.createTask(newTitle.trim(), ipfsHash, dueTs, newPriority);
        await tx.wait();
      } else {
        const startTs = toUnixSecondsFromDatetimeLocal(newStartAt);
        const endTs = toUnixSecondsFromDatetimeLocal(newEndAt);
        if (!startTs || !endTs || endTs < startTs) {
          alert("Meeting start/end time invalid.");
          setTxPendingId(null);
          return;
        }

        // store meeting payload (dummy backend recap pipeline)
        let meetingCid = "bafyfakecid-meeting-dev";
        try {
          const attendees = newAttendees
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

          const resp = await fetch(`${BACKEND_URL}/api/meeting/store`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: newTitle.trim(),
              attendees,
              notes: newNotes,
              startAt: new Date(newStartAt).toISOString(),
              endAt: new Date(newEndAt).toISOString(),
            }),
          });
          if (resp.ok) {
            const data = await resp.json();
            meetingCid = data.cid || meetingCid;
          }
        } catch (e) {
          console.warn("meeting/store failed, continue with fake cid", e);
        }

        const tx = await tm.createMeeting(
          newTitle.trim(),
          meetingCid,
          startTs,
          endTs,
          newPriority
        );
        await tx.wait();
      }

      // reset form
      setNewTitle("");
      setNewPriority(3);
      setNewDueAt("");
      setNewStartAt("");
      setNewEndAt("");
      setNewAttendees("");
      setNewNotes("");

      await loadTasks();
      if (onTasksChanged) await onTasksChanged();
    } catch (e) {
      console.error("create error", e);
      alert("Create failed. Check console for details.");
    } finally {
      setTxPendingId(null);
    }
  }

  // ------------------ 3. 合约操作封装 ------------------
  async function updateStatus(id: number, newStatus: number) {
    if (!provider) return;
    setTxPendingId(id);
    try {
      const signer = await provider.getSigner();
      const abi = (TaskManagerABI as any).abi ?? TaskManagerABI;
      const tm = new ethers.Contract(TASK_MANAGER_ADDRESS, abi, signer);
      const tx = await tm.setStatus(id, newStatus);
      await tx.wait();

      if (onTasksChanged) await onTasksChanged();

      setTasks((prev) => {
        if (newStatus === 2) {
          return prev.filter((t) => t.id !== id);
        }
        const newStatusStr: Status =
          newStatus === 0 ? "Active" : newStatus === 1 ? "Completed" : "Cancelled";
        return prev.map((t) => (t.id === id ? { ...t, status: newStatusStr } : t));
      });
    } catch (e) {
      console.error("updateStatus error", e);
    } finally {
      setTxPendingId(null);
    }
  }

  async function handleComplete(id: number) {
    await updateStatus(id, 1);
  }

  async function handleDelete(id: number) {
    await updateStatus(id, 2);
  }

  async function handleReschedule(id: number, newDate: Date) {
    if (!provider) return;
    setTxPendingId(id);
    try {
      const signer = await provider.getSigner();
      const abi = (TaskManagerABI as any).abi ?? TaskManagerABI;
      const tm = new ethers.Contract(TASK_MANAGER_ADDRESS, abi, signer);
      const newTs = Math.floor(newDate.getTime() / 1000);
      const tx = await tm.rescheduleTask(id, newTs);
      await tx.wait();

      if (onTasksChanged) await onTasksChanged();

      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, dueAt: newDate } : t)));
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

      {/* ✅ Create box (Task / Meeting) */}
      <div className="border rounded-lg px-3 py-3 space-y-2">
        <div className="flex flex-wrap gap-3 items-center">
          <label className="text-sm">
            Type:{" "}
            <select
              value={createKind}
              onChange={(e) => setCreateKind(e.target.value as any)}
            >
              <option value="task">Task</option>
              <option value="meeting">Meeting</option>
            </select>
          </label>

          <label className="text-sm">
            Priority:{" "}
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder={createKind === "meeting" ? "Meeting title" : "Task title"}
            className="border rounded px-2 py-1"
          />

          {createKind === "task" ? (
            <label className="text-sm">
              Due (optional):{" "}
              <input
                type="datetime-local"
                value={newDueAt}
                onChange={(e) => setNewDueAt(e.target.value)}
              />
            </label>
          ) : (
            <>
              <label className="text-sm">
                Start:{" "}
                <input
                  type="datetime-local"
                  value={newStartAt}
                  onChange={(e) => setNewStartAt(e.target.value)}
                />
              </label>
              <label className="text-sm">
                End:{" "}
                <input
                  type="datetime-local"
                  value={newEndAt}
                  onChange={(e) => setNewEndAt(e.target.value)}
                />
              </label>
              <input
                value={newAttendees}
                onChange={(e) => setNewAttendees(e.target.value)}
                placeholder="Attendees (comma separated, optional)"
                className="border rounded px-2 py-1"
              />
              <textarea
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                placeholder="Meeting notes / transcript (optional)"
                className="border rounded px-2 py-1"
                rows={3}
              />
            </>
          )}

          <button
            className="border rounded px-3 py-2"
            disabled={txPendingId === -1}
            onClick={handleCreate}
          >
            {txPendingId === -1 ? "Creating..." : "Create"}
          </button>
        </div>

        <div className="text-xs text-gray-500">
          Meeting will be shown on your calendar using on-chain lastStart/lastEnd.
        </div>
      </div>

      {/* Filter bar（去掉 Deleted 选项） */}
      <div className="flex flex-wrap gap-3 items-center text-sm">
        <label>
          Status:{" "}
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as any)}>
            <option value="all">All</option>
            <option value="Active">Active</option>
            <option value="Completed">Completed</option>
          </select>
        </label>

        <label>
          Priority:{" "}
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value === "all" ? "all" : Number(e.target.value))}
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
          <select value={filterHasDue} onChange={(e) => setFilterHasDue(e.target.value as any)}>
            <option value="all">All</option>
            <option value="hasDue">Has due date</option>
            <option value="noDue">No due date</option>
          </select>
        </label>

        <label>
          Sort by:{" "}
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}>
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
                  {t.isMeeting ? "📅 " : ""}
                  {t.title || `Task #${t.id}`}
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <span className="px-2 py-0.5 rounded-full border">{t.status}</span>
                  <span>·</span>
                  <span>
                    Priority: <b>{t.priority}</b>
                  </span>
                  <span>·</span>
                  <span className="opacity-70">
                    {t.source === "gpt" ? "🤖 GPT" : t.source === "calendar" ? "📅 Cal" : "✍️ Manual"}
                  </span>
                </div>

                <div className="text-xs">
                  Due: {t.dueAt ? t.dueAt.toLocaleString() : "no deadline"}
                </div>

                {t.isMeeting && t.lastStart && t.lastEnd ? (
                  <div className="text-xs">
                    Meeting: {new Date(t.lastStart * 1000).toLocaleString()} →{" "}
                    {new Date(t.lastEnd * 1000).toLocaleString()}
                  </div>
                ) : null}

                <div className="text-xs text-gray-400">
                  Created: {t.createdAt.toLocaleString()}
                </div>

                <div className="text-xs">
                  IPFS: {t.ipfsHash ? t.ipfsHash.slice(0, 18) + "..." : "(none)"}
                </div>

                {/* AI Suggest */}
                <div className="text-xs mt-1">
                  {!sugg ? (
                    <button className="underline" onClick={() => fetchSuggestion(t.id)}>
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
                            const newDate = new Date(base.getTime() + 24 * 3600 * 1000);
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
                <button disabled={isPending || t.status !== "Active"} onClick={() => handleComplete(t.id)}>
                  {isPending ? "Pending..." : "Complete"}
                </button>
                <button
                  disabled={isPending}
                  onClick={() => {
                    const newDateStr = prompt("New due date (YYYY-MM-DD HH:mm, local time)?");
                    if (!newDateStr) return;
                    const newDate = new Date(newDateStr);
                    if (isNaN(newDate.getTime())) alert("Invalid date");
                    else handleReschedule(t.id, newDate);
                  }}
                >
                  Reschedule
                </button>
                <button
                  disabled={isPending}
                  onClick={() => {
                    if (confirm("Soft delete this task?")) handleDelete(t.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}

        {!loading && visibleTasks.length === 0 && <div>No tasks for this account yet.</div>}
      </div>
    </div>
  );
};

export default TaskInbox;
