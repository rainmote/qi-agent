import type { DurableEvent } from "./types";
import { effectiveOutcome, runOutcome } from "./run-outcome";

export interface ToolBatch { id: string; calls: DurableEvent[] }
export type QueuedState = "pending" | "discarded" | "uncertain";
export type TimelineRow =
  | { id: string; kind: "message" | "decision" | "error" | "outcome"; event: DurableEvent }
  | { id: string; kind: "queued"; event: DurableEvent; state: QueuedState; runId: string | null }
  | { id: string; kind: "tools"; batch: ToolBatch };
export interface TimelineModel {
  rows: TimelineRow[];
  results: ReadonlyMap<string, DurableEvent>;
  activeToolRow: number | null;
  queueStates: ReadonlyMap<string, QueuedState | "consumed" | "cleared">;
  activeRunId: string | null;
}

export function toolCallId(event: DurableEvent): string {
  return String(event.data["call-id"] || event.data.call_id || "");
}

export function emptyTimeline(): TimelineModel {
  return { rows: [], results: new Map(), activeToolRow: null, queueStates: new Map(), activeRunId: null };
}

/** Append one ordered event. Snapshot construction can safely reuse its private builder. */
export function appendTimeline(model: TimelineModel, event: DurableEvent, building = false): TimelineModel {
  if (event.type === "session/clear") return { ...emptyTimeline(),
    queueStates: new Map([...model.queueStates.keys()].map(id => [id, "cleared" as const])) };
  if (event.type === "agent/run/start") {
    const id = event.data["run-id"] ?? event.data.run_id;
    if (typeof id !== "string" || !id) return model;
    // Runtime opens admission just before persisting the run envelope.
    const rows = model.rows.map(row => row.kind === "queued" && row.runId === null && row.state === "pending"
      ? { ...row, runId: id } : row);
    return { ...model, rows, activeRunId: id };
  }
  if (["queue/added", "queue/consumed", "queue/discarded"].includes(event.type)) {
    const queueId = event.data.id;
    if (typeof queueId !== "string" || !queueId.trim()) return model;
    const previous = model.queueStates.get(queueId);
    // A late/replayed admission must not revive an item already delivered or retired.
    if (previous === "cleared" || previous === "consumed"
      || (event.type === "queue/added" && previous)) return model;
    const queueStates = new Map(model.queueStates);
    const id = `queue:${queueId}`;
    const index = model.rows.findIndex(row => row.id === id);
    if (event.type === "queue/consumed") {
      queueStates.set(queueId, "consumed");
      // Runtime persists the real user message before its consumed marker.
      const activeId = model.activeToolRow === null ? undefined : model.rows[model.activeToolRow]?.id;
      const rows = model.rows.filter(row => row.id !== id);
      const activeIndex = activeId === undefined ? -1 : rows.findIndex(row => row.id === activeId);
      return { ...model, rows, queueStates, activeToolRow: activeIndex < 0 ? null : activeIndex };
    }
    const state = event.type === "queue/discarded" ? "discarded" : "pending";
    queueStates.set(queueId, state);
    const rows = [...model.rows];
    const existing = rows[index];
    const row: TimelineRow = { id, kind: "queued", event, state,
      runId: existing?.kind === "queued" ? existing.runId : model.activeRunId };
    if (index < 0) rows.push(row); else rows[index] = row;
    return { ...model, rows, queueStates };
  }
  if (event.type === "step/start" || event.type === "step/end") {
    return model.activeToolRow === null ? model : { ...model, activeToolRow: null };
  }
  if (event.type === "tool/result") {
    const results = building ? model.results as Map<string, DurableEvent> : new Map(model.results);
    results.set(toolCallId(event), event);
    return { ...model, results };
  }
  let row: TimelineRow;
  if (event.type === "agent/run/end" || event.type === "agent.run/end") {
    const outcome = runOutcome(event.data);
    if (!outcome) return model;
    const runId = outcome["run-id"];
    if (model.rows.some(row => row.kind === "queued" && row.runId === runId && row.state === "pending")) {
      const queueStates = new Map(model.queueStates);
      const rows = model.rows.map(row => {
        if (row.kind !== "queued" || row.runId !== runId || row.state !== "pending") return row;
        queueStates.set(String(row.event.data.id), "uncertain");
        // A crash may occur between the user message and its consumed marker.
        // Preserve the content for reconciliation without claiming non-delivery.
        return { ...row, state: "uncertain" as const };
      });
      model = { ...model, rows, queueStates };
    }
    if (model.activeRunId === runId) model = { ...model, activeRunId: null };
    const id = `outcome:${outcome["run-id"]}`;
    const index = model.rows.findIndex(row => row.id === id);
    if (index !== -1) {
      const previous = model.rows[index];
      if (previous.kind !== "outcome"
        || effectiveOutcome(runOutcome(previous.event.data), outcome) !== outcome) return model;
      const rows = [...model.rows];
      rows[index] = { id, kind: "outcome", event: { ...event, data: { ...outcome } } };
      return { ...model, rows };
    }
    const rows = model.rows.filter(row => !(row.kind === "error" &&
      (row.event.data["run-id"] ?? row.event.data.run_id) === outcome["run-id"]));
    rows.push({ id, kind: "outcome", event: { ...event, data: { ...outcome } } });
    return { ...model, rows, activeToolRow: null };
  } else if (event.type === "tool/call") {
    const previous = model.activeToolRow === null ? undefined : model.rows[model.activeToolRow];
    if (previous?.kind === "tools") {
      const rows = building ? model.rows : [...model.rows];
      rows[model.activeToolRow!] = {
        ...previous, batch: { ...previous.batch, calls: [...previous.batch.calls, event] },
      };
      return { ...model, rows };
    }
    row = { id: event.id, kind: "tools", batch: { id: event.id, calls: [event] } };
  } else if (event.type === "message") {
    const message = event.data.message as Record<string, unknown> | undefined;
    if (!message || message.role === "tool" || (!message.content && !message.reasoning_content && !message.reasoning &&
      !(Array.isArray(message.tool_calls) && message.tool_calls.length))) return model;
    row = { id: event.id, kind: "message", event };
  } else if (event.type === "approval/decision") {
    row = { id: event.id, kind: "decision", event };
  } else if (event.type === "agent/error") {
    const runId = event.data["run-id"] ?? event.data.run_id;
    if (runId && model.rows.some(row => row.id === `outcome:${runId}`)) return model;
    row = { id: event.id, kind: "error", event };
  } else return model;
  const rows = building ? model.rows : [...model.rows];
  rows.push(row);
  return { ...model, rows, activeToolRow: row.kind === "tools" ? rows.length - 1 : model.activeToolRow };
}

export function buildTimeline(events: readonly DurableEvent[]): TimelineModel {
  return events.reduce((model, event) => appendTimeline(model, event, true), emptyTimeline());
}
