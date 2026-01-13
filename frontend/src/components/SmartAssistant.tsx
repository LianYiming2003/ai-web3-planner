import React, { useMemo, useState } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

type ChatMsg = {
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
};

type Props = {
  provider: any;
  account: string;
};

type CalEvent = {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

function isoFromEventTime(t?: { dateTime?: string; date?: string }): string | null {
  if (!t) return null;
  if (t.dateTime) return new Date(t.dateTime).toISOString();
  if (t.date) return new Date(t.date + "T00:00:00").toISOString();
  return null;
}

function shiftIsoByDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export default function SmartAssistant({ provider, account }: Props) {
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    {
      role: "system",
      text:
        "Week 8 Smart Assistant (stub+actions). Try: 'Show today’s plan', 'Move team sync to next week', 'Summarize this week'.\nIf you run 'Move team sync…', I’ll list calendar events; then type: pick <n>.",
      ts: Date.now(),
    },
  ]);
  const [busy, setBusy] = useState(false);

  // Pending state for multi-step command: reschedule -> list events -> pick one
  const [pendingReschedule, setPendingReschedule] = useState<{
    wantTitle: string;
    daysToShift: number;
    // For on-chain logScheduleChange via backend patch route:
    // backend PATCH requires { taskId, start, end, ipfsCidOfChange }
    taskId: number; // placeholder if you don't have mapping yet
    ipfsCidOfChange: string;
  } | null>(null);

  const [lastEvents, setLastEvents] = useState<CalEvent[]>([]);

  function push(role: ChatMsg["role"], text: string) {
    setMsgs((m) => [...m, { role, text, ts: Date.now() }]);
  }

  async function listEventsForPicking() {
    // default: backend returns next 7 days
    const r = await fetch(`${BACKEND_URL}/api/calendar/events`);
    if (!r.ok) throw new Error(await r.text());
    const items = (await r.json()) as CalEvent[];

    // Keep items that have id + start/end
    const normalized = items
      .filter((e) => e.id)
      .map((e) => e);

    setLastEvents(normalized);

    if (normalized.length === 0) {
      push("assistant", "No calendar events returned from backend.");
      return;
    }

    const lines = normalized.slice(0, 12).map((e, idx) => {
      const s = isoFromEventTime(e.start);
      const summary = e.summary || "(no title)";
      const when = s ? new Date(s).toLocaleString() : "(no start)";
      return `${idx + 1}) ${summary} — ${when}`;
    });

    push(
      "assistant",
      `I found ${normalized.length} events (showing up to 12):\n${lines.join(
        "\n"
      )}\n\nType: pick <number>  (e.g., "pick 2")`
    );
  }

  async function executePick(n: number) {
    if (!pendingReschedule) {
      push("assistant", 'No pending reschedule. Try "Move team sync to next week" first.');
      return;
    }
    if (n < 1 || n > lastEvents.length) {
      push("assistant", `pick number out of range. Valid: 1..${lastEvents.length}`);
      return;
    }

    const ev = lastEvents[n - 1];
    const startIso = isoFromEventTime(ev.start);
    const endIso = isoFromEventTime(ev.end);

    if (!startIso || !endIso) {
      push("assistant", "Selected event has no start/end dateTime. Can't reschedule.");
      return;
    }

    const newStart = shiftIsoByDays(startIso, pendingReschedule.daysToShift);
    const newEnd = shiftIsoByDays(endIso, pendingReschedule.daysToShift);

    push(
      "assistant",
      `Selected: "${ev.summary || "(no title)"}"\nOld: ${new Date(startIso).toLocaleString()} → ${new Date(
        endIso
      ).toLocaleString()}\nNew: ${new Date(newStart).toLocaleString()} → ${new Date(newEnd).toLocaleString()}\n\nSending calendar update + on-chain audit...`
    );

    // Call backend patch route (it will update Google Calendar + call logScheduleChange on-chain)
    const resp = await fetch(`${BACKEND_URL}/api/calendar/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: pendingReschedule.taskId, // placeholder (0 ok if your contract allows; if not, set a real one)
        start: newStart,
        end: newEnd,
        ipfsCidOfChange: pendingReschedule.ipfsCidOfChange,
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`PATCH calendar failed: ${txt}`);
    }

    const data = await resp.json();
    push("assistant", `✅ Done. Calendar updated.\nOn-chain tx: ${data.txHash || "(no tx hash)"}`);

    // clear pending
    setPendingReschedule(null);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    push("user", trimmed);
    setInput("");
    setBusy(true);

    try {
      // If user typed "pick N", handle locally (multi-step command)
      const m = trimmed.match(/^pick\s+(\d+)$/i);
      if (m) {
        await executePick(Number(m[1]));
        return;
      }

      // 1) backend parse-command (stub)
      const resp = await fetch(`${BACKEND_URL}/api/parse-command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed, address: account }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const parse = await resp.json();

      push("assistant", parse.message || "OK.");
      const action = parse.action;

      // 2) execute actions
      if (action?.type === "show_plan") {
        const mode = action.mode === "week" ? "week" : "today";
        const r = await fetch(`${BACKEND_URL}/api/planner`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: account, mode }),
        });
        if (!r.ok) throw new Error(await r.text());
        const data = await r.json();
        const plan = data.plan;

        push(
          "assistant",
          `Plan (${mode}) template:\nRange: ${plan?.rangeStart ?? "?"} → ${plan?.rangeEnd ?? "?"}\nBlocks: ${
            plan?.blocks?.length ?? 0
          }\nCID: ${data.cid}`
        );
      }

      if (action?.type === "summarize_week") {
        push("assistant", "Summary template: Top priorities, due dates, and 3 focus blocks per day.");
      }

      if (action?.type === "reschedule") {
        // Start multi-step: list events then wait for "pick N"
        // NOTE: right now action.taskId is placeholder; update later when you map events to task IDs.
        setPendingReschedule({
          wantTitle: action.title || "Team Sync",
          daysToShift: 7,
          taskId: Number(action.taskId || 0),
          ipfsCidOfChange: String(action.ipfsHash || "bafyfakecid-change-log"),
        });

        push(
          "assistant",
          `Reschedule mode: I’ll list your calendar events. Pick the correct one to move +7 days.\n(If you later map it to a real taskId, the on-chain log will be perfectly linked.)`
        );

        await listEventsForPicking();
      }
    } catch (e: any) {
      console.error(e);
      push("assistant", `Error: ${String(e?.message || e)}`);
      // do not clear pending automatically (helps debugging)
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 32 }} className="border rounded-lg px-4 py-4">
      <h2 className="text-xl font-bold">Week 8 — Smart Assistant</h2>

      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="border rounded px-3 py-2" disabled={busy} onClick={() => send("Show today’s plan")}>
          Show today’s plan
        </button>
        <button className="border rounded px-3 py-2" disabled={busy} onClick={() => send("Move team sync to next week")}>
          Move team sync
        </button>
        <button className="border rounded px-3 py-2" disabled={busy} onClick={() => send("Summarize this week")}>
          Summarize this week
        </button>
      </div>

      <div
        style={{
          marginTop: 14,
          maxHeight: 320,
          overflow: "auto",
          background: "#111",
          color: "#eee",
          padding: 12,
          borderRadius: 10,
          fontSize: 13,
          lineHeight: 1.4,
          whiteSpace: "pre-wrap",
        }}
      >
        {msgs.map((m, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <b style={{ color: m.role === "user" ? "#9ad" : m.role === "assistant" ? "#9f9" : "#ccc" }}>
              {m.role}:
            </b>{" "}
            {m.text}
          </div>
        ))}
        {busy && <div style={{ opacity: 0.7 }}>(working...)</div>}
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        <input
          style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
          placeholder='Type a command... (try: "pick 1")'
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send(input);
          }}
          disabled={busy}
        />
        <button className="border rounded px-4 py-2" disabled={busy} onClick={() => send(input)}>
          Send
        </button>
      </div>

      <div style={{ marginTop: 8, fontSize: 12, color: "gray" }}>
        Stub mode: no OpenAI. For "Move team sync", assistant lists events; you type <b>pick N</b> to execute calendar patch +
        on-chain audit (via backend route).
      </div>
    </div>
  );
}
