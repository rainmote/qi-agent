import type { TimelineModel, TimelineRow } from "./timeline-model";

// Presentation preferences never change model requests or permission policy.
export type TranscriptView = "compact" | "standard" | "detailed" | "verbose";
export const transcriptViews: Array<{ id: TranscriptView; label: string }> = [
  { id: "compact", label: "简洁" }, { id: "standard", label: "标准" },
  { id: "detailed", label: "详细" }, { id: "verbose", label: "完全展开" },
];
export function transcriptView(value: string | null): TranscriptView {
  return transcriptViews.find(view => view.id === value)?.id || "standard";
}
export type CollapseTiming = "completion" | "next-input";
export const collapseTimings: Array<{ id: CollapseTiming; label: string }> = [
  { id: "completion", label: "回答结束后" }, { id: "next-input", label: "下次有新消息时" },
];
export function collapseTiming(value: string | null): CollapseTiming {
  return value === "next-input" ? value : "completion";
}
export type TurnControl = {
  id: string; kind: "turn-control"; open: boolean; label: string; caption: string; members: string[];
};

/** Fold only settled, uninterrupted turns; retain answers, decisions and failure outcomes. */
export function displayTranscript(model: TimelineModel, mode: TranscriptView,
  choices: ReadonlyMap<string, boolean>, focusedRow: string | null = null, timing: CollapseTiming = "completion"): {
    rows: Array<TimelineRow | TurnControl>; hiddenReasoning: ReadonlySet<string>; activeRows: ReadonlySet<string>;
  } {
  const rows: Array<TimelineRow | TurnControl> = [];
  const hiddenReasoning = new Set<string>();
  const activeRows = new Set<string>();
  const lastUserInputIndex = model.rows.reduce((last, row, index) => row.kind === "message"
    && (row.event.data.message as Record<string, unknown>).role === "user" ? index : last, -1);
  let segment: TimelineRow[] = [];
  const flush = (settled: boolean, outcomeIndex = -1) => {
    const process = new Set<string>();
    let finalId: string | undefined, started = false, interrupted = false;
    for (const row of segment) {
      if (row.kind === "message") {
        const message = row.event.data.message as Record<string, unknown>;
        if (message.role === "user") { if (started) interrupted = true; }
        else if (message.role === "assistant") {
          started = true;
          if (message.content && !(Array.isArray(message.tool_calls) && message.tool_calls.length)) finalId = row.id;
          else finalId = undefined;
          process.add(row.id);
        }
      } else if (row.kind === "tools") { started = true; finalId = undefined; process.add(row.id); }
    }
    if (finalId) process.delete(finalId);
    const final = segment.find(row => row.id === finalId);
    const finalMessage = final?.kind === "message" ? final.event.data.message as Record<string, unknown> : undefined;
    const finalReasoning = Boolean(finalMessage?.reasoning_content || finalMessage?.reasoning);
    const count = process.size + (finalReasoning ? 1 : 0);
    if (!settled || interrupted || !count || mode === "verbose") { rows.push(...segment); segment = []; return; }
    const outcome = segment.at(-1)!;
    const id = `process:${outcome.id}`;
    const hasLaterUserInput = lastUserInputIndex > outcomeIndex;
    const open = choices.get(id) ?? ((timing === "next-input" && !hasLaterUserInput)
      || (focusedRow !== null && (process.has(focusedRow) || (focusedRow === finalId && finalReasoning))));
    let failed = 0, missing = 0;
    for (const row of segment) if (row.kind === "tools") for (const call of row.batch.calls) {
      const result = model.results.get(String(call.data["call-id"] || call.data.call_id || ""));
      if (!result) missing++; else if (result.data.ok === false) failed++;
    }
    const summary = [failed ? `${failed} 失败` : "", missing ? `${missing} 项结果未确认` : ""].filter(Boolean);
    const startedAt = segment.find(row => "event" in row)?.event.at;
    const endedAt = "event" in outcome ? outcome.event.at : undefined;
    const elapsed = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : NaN;
    const duration = Number.isFinite(elapsed) ? `，用时 ${Math.max(1, Math.round(elapsed / 1000))}秒` : "";
    let inserted = false;
    for (const row of segment) {
      if (!inserted && (process.has(row.id) || row.id === finalId)) {
        rows.push({ id, kind: "turn-control", open,
          caption: `已完成${duration}${summary.length ? ` · ${summary.join(" · ")}` : ""}`,
          members: segment.flatMap(member => [member.id, ...(member.kind === "tools" ? member.batch.calls.map(call => `call:${call.id}`) : [])]),
          label: `工作步骤 · ${count} 项${summary.length ? ` · ${summary.join(" · ")}` : ""}` });
        inserted = true;
      }
      if (open || !process.has(row.id)) rows.push(row);
    }
    if (!open && finalId) hiddenReasoning.add(finalId);
    segment = [];
  };
  for (const [index, row] of model.rows.entries()) {
    segment.push(row);
    if (row.kind === "outcome") flush(row.event.data.status === "completed", index);
  }
  for (const row of segment) activeRows.add(row.id);
  flush(false);
  return { rows, hiddenReasoning, activeRows };
}
