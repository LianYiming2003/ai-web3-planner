// src/components/TaskCalendar.tsx
import React, { useEffect, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { EventDropArg } from "@fullcalendar/core";
import type { OnChainTask } from "../App";

import { ethers } from "ethers";
import TaskManagerABIJson from "../abis/TaskManager.json";

type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  extendedProps?: {
    taskId?: number;
    calendarEventId?: string;
  };
};

const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

const TASK_MANAGER_ADDRESS = import.meta.env
  .VITE_TASK_MANAGER_ADDR as string;
const TASK_MANAGER_ABI =
  (TaskManagerABIJson as any).abi ?? TaskManagerABIJson;

interface TaskCalendarProps {
  tasks: OnChainTask[];
  provider: ethers.providers.Web3Provider | null;
  // App 传进来，用来在链上状态变化后重新拉任务
  onTasksChanged?: () => Promise<void> | void;
}

const TaskCalendar: React.FC<TaskCalendarProps> = ({
  tasks,
  provider,
  onTasksChanged,
}) => {
  const [events, setEvents] = useState<CalendarEvent[]>([]);

  // 拉 Google Calendar + 把链上任务变成事件一起显示
  useEffect(() => {
    const loadEvents = async () => {
      let googleEvents: CalendarEvent[] = [];

      // ---------- 1) Google 事件（失败就当空，不崩前端） ----------
      try {
        const now = new Date();
        const weekLater = new Date(now.getTime() + 7 * 24 * 3600 * 1000);

        const res = await fetch(
          `${BACKEND_URL}/api/calendar/events?timeMin=${now.toISOString()}&timeMax=${weekLater.toISOString()}`
        );

        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            googleEvents = data.map((ev: any) => ({
              id: ev.id,
              title: ev.summary || "(no title)",
              start: ev.start.dateTime || ev.start.date,
              end: ev.end.dateTime || ev.end.date,
              extendedProps: {
                calendarEventId: ev.id,
                taskId: ev.extendedProperties?.private?.taskId
                  ? Number(ev.extendedProperties.private.taskId)
                  : undefined,
              },
            }));
          } else {
            console.warn("Calendar events response is not array:", data);
          }
        } else {
          console.warn(
            "Calendar events API failed with status",
            res.status
          );
        }
      } catch (e) {
        console.warn("Failed to load Google events, fallback to []", e);
      }

      // ---------- 2) 把链上的任务画成事件 ----------
      // 过滤 Cancelled (status == 2)，优先 lastStart/lastEnd，没有就用 dueAt - 1h ~ dueAt
      const taskEvents: CalendarEvent[] = tasks
        .map((t) => {
          const status = Number((t as any).status ?? 0);
          if (status === 2) {
            // Cancelled/Deleted 的任务不画在日历上
            return null;
          }

          const lastStart = Number((t as any).lastStart ?? 0);
          const lastEnd = Number((t as any).lastEnd ?? 0);
          const dueAt = Number(t.dueAt ?? 0);

          let startTs: number | null = null;
          let endTs: number | null = null;

          if (lastStart !== 0 && lastEnd !== 0) {
            startTs = lastStart;
            endTs = lastEnd;
          } else if (dueAt !== 0) {
            endTs = dueAt;
            startTs = dueAt - 3600; // 默认 1 小时时间块
          } else {
            return null; // 没任何时间信息就不画
          }

          return {
            id: `task-${Number(t.id)}`,
            title: t.title || `Task #${String(t.id)}`,
            start: new Date(startTs * 1000).toISOString(),
            end: new Date(endTs * 1000).toISOString(),
            extendedProps: {
              taskId: Number(t.id),
            },
          } as CalendarEvent;
        })
        .filter((ev): ev is CalendarEvent => ev !== null);

      setEvents([...googleEvents, ...taskEvents]);
    };

    loadEvents();
  }, [tasks]);

  // 拖拽事件 → 尝试 PATCH Google → 再调链上 logScheduleChange + rescheduleTask
  const handleEventDrop = async (arg: EventDropArg) => {
    const ev = arg.event;
    const ext = ev.extendedProps as any;

    const taskId = ext.taskId;
    if (!taskId) {
      // 没挂 taskId 的纯 Google 事件，先不改链上
      return;
    }

    const calendarEventId = ext.calendarEventId || ev.id;
    const newStartDate = ev.start!;
    const newEndDate =
      ev.end || new Date(newStartDate.getTime() + 3600 * 1000);

    const newStart = newStartDate.toISOString();
    const newEnd = newEndDate.toISOString();

    const ipfsCidOfChange = "ipfs://fake-cid-dev";

    // 1) 先尽力 PATCH Google（失败也不影响链上）
    try {
      await fetch(`${BACKEND_URL}/api/calendar/events/${calendarEventId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          start: newStart,
          end: newEnd,
          ipfsCidOfChange,
        }),
      });
    } catch (e) {
      console.warn("Failed to patch Google event, continue on-chain", e);
    }

    // 2) 调合约：logScheduleChange + rescheduleTask
    if (!provider) {
      console.error("No provider in TaskCalendar");
      arg.revert();
      return;
    }

    try {
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(
        TASK_MANAGER_ADDRESS,
        TASK_MANAGER_ABI,
        signer
      );

      const newStartTs = Math.floor(newStartDate.getTime() / 1000);
      const newEndTs = Math.floor(newEndDate.getTime() / 1000);

      // a) 记录排期变更（写 lastStart/lastEnd + emit 事件）
      const tx1 = await contract.logScheduleChange(
        taskId,
        newStartTs,
        newEndTs,
        ipfsCidOfChange
      );
      await tx1.wait();

      // b) 更新 dueAt（用结束时间当新的截止）
      const tx2 = await contract.rescheduleTask(taskId, newEndTs);
      await tx2.wait();

      // c) 通知 App 重新从链上拉 tasks
      if (onTasksChanged) {
        await onTasksChanged();
      }
    } catch (e) {
      console.error("On-chain schedule update failed", e);
      arg.revert();
    }
  };

  return (
    <div
      style={{
        marginTop: "16px",
        padding: "16px",
        borderRadius: "16px",
        background: "#ffffff",
        boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
      }}
    >
      <FullCalendar
        plugins={[timeGridPlugin, interactionPlugin]}
        initialView="timeGridWeek"
        editable={true}
        selectable={true}
        events={events}
        eventDrop={handleEventDrop}
        height="auto"
      />
    </div>
  );
};

export default TaskCalendar;


