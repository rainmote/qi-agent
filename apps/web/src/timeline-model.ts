import type { DurableEvent } from "./types";

export interface ToolBatch { id: string; calls: DurableEvent[] }
export type TimelineRow =
  | { id: string; kind: "message" | "decision" | "error"; event: DurableEvent }
  | { id: string; kind: "tools"; batch: ToolBatch };
export interface TimelineModel {
  rows: TimelineRow[];
  results: ReadonlyMap<string, DurableEvent>;
  activeToolRow: number | null;
}

export function toolCallId(event: DurableEvent): string {
  return String(event.data["call-id"] || event.data.call_id || "");
}

export function emptyTimeline(): TimelineModel {
  return { rows: [], results: new Map(), activeToolRow: null };
}

/** Append one ordered event. Snapshot construction can safely reuse its private builder. */
export function appendTimeline(model: TimelineModel, event: DurableEvent, building = false): TimelineModel {
  if (event.type === "session/clear") return emptyTimeline();
  if (event.type === "step/start" || event.type === "step/end") {
    return model.activeToolRow === null ? model : { ...model, activeToolRow: null };
  }
  if (event.type === "tool/result") {
    const results = building ? model.results as Map<string, DurableEvent> : new Map(model.results);
    results.set(toolCallId(event), event);
    return { ...model, results };
  }
  let row: TimelineRow;
  if (event.type === "tool/call") {
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
    if (!message || message.role === "tool" || (!message.content &&
      !(Array.isArray(message.tool_calls) && message.tool_calls.length))) return model;
    row = { id: event.id, kind: "message", event };
  } else if (event.type === "approval/decision") {
    row = { id: event.id, kind: "decision", event };
  } else if (event.type === "agent/error") {
    row = { id: event.id, kind: "error", event };
  } else return model;
  const rows = building ? model.rows : [...model.rows];
  rows.push(row);
  return { ...model, rows, activeToolRow: row.kind === "tools" ? rows.length - 1 : model.activeToolRow };
}

export function buildTimeline(events: readonly DurableEvent[]): TimelineModel {
  return events.reduce((model, event) => appendTimeline(model, event, true), emptyTimeline());
}
