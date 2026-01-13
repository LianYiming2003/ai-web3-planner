// src/components/Planner.tsx
import React, { useMemo, useState } from "react";
import { ethers } from "ethers";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";
const PLAN_MANAGER_ADDRESS = import.meta.env.VITE_PLAN_MANAGER_ADDR as string;

// Minimal ABI (no need to keep json in sync during iteration)
const PLAN_MANAGER_ABI = [
  "function createPlan(string ipfsHash, uint256 startTs) external",
  "function getPlansByOwner(address user) view returns (tuple(uint256 id,address owner,string ipfsHash,uint256 startTs,uint256 createdAt)[])",
];

type PlanBlock = {
  title: string;
  start: string; // ISO
  end: string; // ISO
  taskId?: number;
};

type PlanJson = {
  mode: "today" | "week";
  owner: string;
  generatedAt: string;
  blocks: PlanBlock[];
  notes?: string;

  // ✅ NEW: range fields from backend
  rangeStart?: string; // ISO
  rangeEnd?: string; // ISO
  rangeStartTs?: number;
  rangeEndTs?: number;
};

type OnChainPlan = {
  id: number;
  owner: string;
  ipfsHash: string;
  startTs: number;
  createdAt: number;
};

type Props = {
  provider: any; // ethers v6 BrowserProvider (or compatible)
  account: string;
};

function toNum(bn: any): number {
  try {
    return Number(bn);
  } catch {
    return 0;
  }
}

// If you upload via Web3.Storage (wrapWithDirectory),
// this gateway works: https://<cid>.ipfs.w3s.link/plan.json
function ipfsFileUrl(cid: string, filename: string) {
  return `https://${cid}.ipfs.w3s.link/${filename}`;
}

export default function Planner({ provider, account }: Props) {
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<PlanJson | null>(null);
  const [planCid, setPlanCid] = useState<string>("");
  const [saved, setSaved] = useState<OnChainPlan[]>([]);
  const [err, setErr] = useState<string>("");

  const planManagerRead = useMemo(() => {
    if (!provider || !PLAN_MANAGER_ADDRESS) return null;
    return new ethers.Contract(PLAN_MANAGER_ADDRESS, PLAN_MANAGER_ABI, provider);
  }, [provider]);

  async function refreshSaved() {
    if (!planManagerRead) return;
    const raw = await planManagerRead.getPlansByOwner(account);
    const mapped: OnChainPlan[] = (raw as any[]).map((p: any) => ({
      id: toNum(p.id),
      owner: p.owner,
      ipfsHash: p.ipfsHash,
      startTs: toNum(p.startTs),
      createdAt: toNum(p.createdAt),
    }));
    mapped.sort((a, b) => b.createdAt - a.createdAt);
    setSaved(mapped);
  }

  async function generate(mode: "today" | "week") {
    setErr("");
    setLoading(true);
    try {
      // 1) backend generates plan + uploads to IPFS (or returns fake CID if no token)
      const resp = await fetch(`${BACKEND_URL}/api/planner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account, mode }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();

      const cid = data.cid as string;
      const startTs = Number(data.startTs || 0);
      const planJson = data.plan as PlanJson;

      setPlan(planJson);
      setPlanCid(cid);

      // 2) store compact reference on-chain (this tx must be signed by user)
      const signer = await provider.getSigner();
      const pm = new ethers.Contract(PLAN_MANAGER_ADDRESS, PLAN_MANAGER_ABI, signer);
      const tx = await pm.createPlan(cid, startTs);
      await tx.wait();

      await refreshSaved();
    } catch (e: any) {
      console.error(e);
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function viewFromIpfs(cid: string) {
    setErr("");
    setLoading(true);
    try {
      const url = ipfsFileUrl(cid, "plan.json");
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Failed to load plan.json from IPFS (HTTP ${r.status})`);
      const pj = (await r.json()) as PlanJson;
      setPlan(pj);
      setPlanCid(cid);
    } catch (e: any) {
      console.error(e);
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-bold">Week 7 — Daily & Weekly Planner</h2>

      <div className="flex gap-2 flex-wrap">
        <button className="border rounded px-3 py-2" disabled={loading} onClick={() => generate("today")}>
          {loading ? "Working..." : "Plan for today"}
        </button>
        <button className="border rounded px-3 py-2" disabled={loading} onClick={() => generate("week")}>
          {loading ? "Working..." : "Plan for this week"}
        </button>
        <button className="border rounded px-3 py-2" disabled={loading} onClick={() => refreshSaved()}>
          Refresh saved plans
        </button>
      </div>

      {err && <div style={{ color: "crimson", fontSize: 12 }}>{err}</div>}

      {plan && (
        <div className="border rounded-lg px-3 py-3">
          <div className="font-semibold">
            Current plan {planCid ? `(CID: ${planCid.slice(0, 12)}...)` : ""}
          </div>

          <div className="text-xs text-gray-500" style={{ marginTop: 6 }}>
            Mode: {plan.mode} · Generated: {new Date(plan.generatedAt).toLocaleString()}
          </div>

          {/* ✅ NEW: range display */}
          {plan.rangeStart && plan.rangeEnd && (
            <div className="text-xs text-gray-500" style={{ marginTop: 6 }}>
              Range: {new Date(plan.rangeStart).toLocaleString()} → {new Date(plan.rangeEnd).toLocaleString()}
            </div>
          )}

          <div className="space-y-2" style={{ marginTop: 12 }}>
            {plan.blocks.map((b, i) => (
              <div key={i} className="border rounded px-3 py-2">
                <div className="font-semibold">{b.title}</div>
                <div className="text-xs text-gray-500">
                  {new Date(b.start).toLocaleString()} → {new Date(b.end).toLocaleString()}
                  {typeof b.taskId === "number" ? ` · task #${b.taskId}` : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border rounded-lg px-3 py-3">
        <div className="font-semibold">Saved plans (on-chain pointers)</div>
        {saved.length === 0 ? (
          <div className="text-sm" style={{ marginTop: 8 }}>
            No saved plans yet.
          </div>
        ) : (
          <div className="space-y-2" style={{ marginTop: 10 }}>
            {saved.map((p) => (
              <div key={p.id} className="flex items-center justify-between border rounded px-3 py-2">
                <div>
                  <div className="font-semibold">
                    Plan #{p.id} · CID: {p.ipfsHash.slice(0, 12)}...
                  </div>
                  <div className="text-xs text-gray-500">
                    Start: {p.startTs ? new Date(p.startTs * 1000).toLocaleString() : "-"} · Saved:{" "}
                    {new Date(p.createdAt * 1000).toLocaleString()}
                  </div>
                </div>
                <button
                  className="border rounded px-3 py-1 text-sm"
                  disabled={loading}
                  onClick={() => viewFromIpfs(p.ipfsHash)}
                >
                  View
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-xs text-gray-500">
        Framework only (no OpenAI). Backend uses a simple heuristic planner. Later you can swap with GPT.
      </div>
    </div>
  );
}
