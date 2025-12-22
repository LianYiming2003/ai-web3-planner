// src/components/MeetingRecaps.tsx
import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import TaskManagerABIJson from "../abis/TaskManager.json";

const TASK_MANAGER_ADDRESS = import.meta.env.VITE_TASK_MANAGER_ADDR as string;
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

type MeetingTask = {
  id: number;
  title: string;
  ipfsHash: string; // meeting CID (directory)
  lastStart: number;
  lastEnd: number;
  status: number; // 0/1/2
};

type OnChainRecap = {
  meetingTaskId: number;
  creator: string;
  recapCid: string;
  createdAt: number;
};

type Props = {
  provider: any; // ethers v6 BrowserProvider (or compatible)
  account: string;
  onTasksChanged?: () => Promise<void> | void;
};

// Use Web3.Storage gateway by default (works well if you uploaded via web3.storage).
function ipfsUrl(cid: string, filename: string) {
  // directory CID, e.g. https://<cid>.ipfs.w3s.link/recap.md
  return `https://${cid}.ipfs.w3s.link/${filename}`;
}

async function fetchJson(url: string) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

async function fetchText(url: string) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}

export default function MeetingRecaps({ provider, account, onTasksChanged }: Props) {
  const [meetings, setMeetings] = useState<MeetingTask[]>([]);
  const [recaps, setRecaps] = useState<OnChainRecap[]>([]);
  const [loading, setLoading] = useState(false);
  const [generatingId, setGeneratingId] = useState<number | null>(null);

  // recapMd cache: recapCid -> md content
  const [mdCache, setMdCache] = useState<Record<string, string>>({});

  const abi = useMemo(() => (TaskManagerABIJson as any).abi ?? TaskManagerABIJson, []);

  async function loadData() {
    if (!provider || !account) return;
    setLoading(true);
    try {
      const signer = await provider.getSigner();
      const tm = new ethers.Contract(TASK_MANAGER_ADDRESS, abi, signer);

      const rawTasks: any[] = await tm.getTasksByOwner(account);
      const meetingTasks: MeetingTask[] = rawTasks
        .filter((t: any) => Boolean(t.isMeeting))
        .map((t: any) => ({
          id: Number(t.id),
          title: t.title,
          ipfsHash: t.ipfsHash,
          lastStart: Number(t.lastStart ?? 0),
          lastEnd: Number(t.lastEnd ?? 0),
          status: Number(t.status ?? 0),
        }));

      const rawRecaps: any[] = await tm.getMeetingRecapsByOwner(account);
      const recapList: OnChainRecap[] = rawRecaps.map((r: any) => ({
        meetingTaskId: Number(r.meetingTaskId),
        creator: r.creator,
        recapCid: r.recapCid,
        createdAt: Number(r.createdAt),
      }));

      setMeetings(meetingTasks);
      setRecaps(recapList);
    } catch (e) {
      console.error("MeetingRecaps load error", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, account]);

  const recapByMeetingId = useMemo(() => {
    const m = new Map<number, OnChainRecap>();
    for (const r of recaps) m.set(r.meetingTaskId, r);
    return m;
  }, [recaps]);

  const endedMeetings = useMemo(() => {
    const nowTs = Math.floor(Date.now() / 1000);
    return meetings.filter((m) => m.status !== 2 && m.lastEnd > 0 && m.lastEnd < nowTs);
  }, [meetings]);

  const missingRecapMeetings = useMemo(() => {
    return endedMeetings.filter((m) => !recapByMeetingId.has(m.id));
  }, [endedMeetings, recapByMeetingId]);

  async function generateRecapForMeeting(m: MeetingTask) {
    if (!provider || !account) return;
    setGeneratingId(m.id);

    try {
      // 1) read meeting payload from IPFS (meeting.json)
      let meetingPayload: any = {
        title: m.title,
        attendees: [],
        notes: "",
        startAt: new Date(m.lastStart * 1000).toISOString(),
        endAt: new Date(m.lastEnd * 1000).toISOString(),
      };

      try {
        meetingPayload = await fetchJson(ipfsUrl(m.ipfsHash, "meeting.json"));
      } catch (e) {
        console.warn("Failed to fetch meeting.json from IPFS, fallback to minimal payload", e);
      }

      // 2) call backend dummy recap (no OpenAI)
      const recapResp = await fetch(`${BACKEND_URL}/api/meeting/recap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meeting: meetingPayload }),
      });
      if (!recapResp.ok) {
        const txt = await recapResp.text();
        throw new Error(`backend recap failed: ${txt}`);
      }
      const recapData = await recapResp.json();
      const recapCid = recapData.recapCid as string;
      const actionItems = Array.isArray(recapData.actionItems) ? recapData.actionItems : [];

      // 3) store recap pointer on-chain
      const signer = await provider.getSigner();
      const tm = new ethers.Contract(TASK_MANAGER_ADDRESS, abi, signer);

      const tx1 = await tm.storeMeetingRecap(m.id, recapCid);
      await tx1.wait();

      // 4) auto-create tasks from action items (best-effort)
      for (const ai of actionItems) {
        const title = String(ai.title || "Action item").slice(0, 120);
        const pr = Number(ai.priority ?? 3);
        let dueAt = 0;

        if (ai.due) {
          const d = new Date(String(ai.due) + "T23:59:00");
          if (!isNaN(d.getTime())) dueAt = Math.floor(d.getTime() / 1000);
        }

        try {
          const tx = await tm.createTask(title, recapCid, dueAt, pr);
          await tx.wait();
        } catch (e) {
          console.warn("createTask from action item failed (continue)", e);
        }
      }

      // 5) refresh
      await loadData();
      if (onTasksChanged) await onTasksChanged();
    } catch (e) {
      console.error("generateRecapForMeeting failed", e);
      alert("Generate recap failed. Check console.");
    } finally {
      setGeneratingId(null);
    }
  }

  async function loadRecapMd(recapCid: string) {
    try {
      const md = await fetchText(ipfsUrl(recapCid, "recap.md"));
      setMdCache((prev) => ({ ...prev, [recapCid]: md }));
    } catch (e) {
      console.error("load recap.md failed", e);
      alert("Failed to load recap.md from IPFS.");
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-bold">Meeting Recaps</h2>

      {loading && <div>Loading meetings/recaps...</div>}

      {/* Missing recaps */}
      <div className="border rounded-lg px-3 py-3">
        <div className="font-semibold">Ended meetings (missing recap)</div>
        <div className="text-xs text-gray-500" style={{ marginTop: 6 }}>
          Note: “Auto recap” still requires a wallet signature, so you click once and it will generate.
        </div>

        {missingRecapMeetings.length === 0 ? (
          <div className="text-sm" style={{ marginTop: 8 }}>
            No missing recaps 🎉
          </div>
        ) : (
          <div className="space-y-2" style={{ marginTop: 10 }}>
            {missingRecapMeetings.map((m) => (
              <div key={m.id} className="flex items-center justify-between border rounded px-3 py-2">
                <div>
                  <div className="font-semibold">#{m.id} — {m.title}</div>
                  <div className="text-xs text-gray-500">
                    {new Date(m.lastStart * 1000).toLocaleString()} → {new Date(m.lastEnd * 1000).toLocaleString()}
                  </div>
                </div>
                <button
                  className="border rounded px-3 py-1 text-sm"
                  disabled={generatingId === m.id}
                  onClick={() => generateRecapForMeeting(m)}
                >
                  {generatingId === m.id ? "Generating..." : "Generate recap"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stored recaps */}
      <div className="border rounded-lg px-3 py-3">
        <div className="font-semibold">Stored recaps (on-chain pointers)</div>
        {recaps.length === 0 ? (
          <div className="text-sm" style={{ marginTop: 8 }}>
            No recaps stored yet.
          </div>
        ) : (
          <div className="space-y-2" style={{ marginTop: 10 }}>
            {recaps
              .slice()
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((r) => {
                const md = mdCache[r.recapCid];
                return (
                  <div key={r.meetingTaskId} className="border rounded px-3 py-2">
                    <div className="font-semibold">
                      Meeting #{r.meetingTaskId} — Recap CID: {r.recapCid.slice(0, 12)}...
                    </div>
                    <div className="text-xs text-gray-500" style={{ marginTop: 4 }}>
                      Stored at: {new Date(r.createdAt * 1000).toLocaleString()}
                    </div>

                    {!md ? (
                      <button
                        className="underline text-sm"
                        style={{ marginTop: 6 }}
                        onClick={() => loadRecapMd(r.recapCid)}
                      >
                        Load recap content
                      </button>
                    ) : (
                      <pre
                        style={{
                          whiteSpace: "pre-wrap",
                          background: "#f7f7f7",
                          padding: 12,
                          borderRadius: 10,
                          marginTop: 10,
                          fontSize: 12,
                        }}
                      >
                        {md}
                      </pre>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
