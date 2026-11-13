import { toolFailed } from "./tool-status";
import { uiText as t } from "./i18n";
import type { TimelineModel, TimelineRow, ToolBatch } from "./timeline-model";
import { outcomeText, runOutcome } from "./run-outcome";
import { hasMessageContent, messageText } from "./message-content";

// Presentation preferences never change model requests or permission policy.
export type TranscriptView = "compact" | "standard" | "detailed" | "verbose";
export const transcriptViews: Array<{ id: TranscriptView; label: string }> = [
  { id: "compact", label: "简洁" }, { id: "standard", label: "标准" },
  { id: "detailed", label: "详细" }, { id: "verbose", label: "完全展开" },
];
export function transcriptView(value: string | null): TranscriptView {
  return transcriptViews.find(view => view.id === value)?.id || "detailed";
}
export type CollapseTiming = "completion" | "next-input";
export const collapseTimings: Array<{ id: CollapseTiming; label: string }> = [
  { id: "completion", label: "回答结束后" }, { id: "next-input", label: "下次有新消息时" },
];
export function collapseTiming(value: string | null): CollapseTiming {
  return value === "next-input" ? value : "completion";
}
export type FoldedReplies = "all" | "final";
export function foldedReplies(value: string | null): FoldedReplies { return value === "final" ? "final" : "all"; }
export type TurnControl = {
  id: string; kind: "turn-control"; open: boolean; label: string; caption: string; members: string[];
};
export type StepControl = {
  id: string; kind: "step-control"; open: boolean; members: string[]; batch: ToolBatch; reasoningCount: number; content: TimelineRow[]; closed: boolean;
};
export type TranscriptRow = TimelineRow | TurnControl | StepControl;

function memberIds(rows: TimelineRow[]): string[] {
  return rows.flatMap(row => [row.id, `${row.id}:reasoning`, `steps:${row.id}`, `steps:${row.id}:reasoning`,
    ...(row.kind === "tools" ? row.batch.calls.map(call => `call:${call.id}`) : [])]);
}

/** Group adjacent process records across model steps, with replies and inputs as boundaries.
 * Follows Harness conversation-nodes: all modes share membership; only disclosure differs. */
function processGroups(rows: Array<TimelineRow | TurnControl>, mode: TranscriptView,
  choices: ReadonlyMap<string, boolean>, focusedRow: string | null,
  hiddenReasoning: ReadonlySet<string>, flatRows: ReadonlySet<string>, activeRows: ReadonlySet<string>, focusedFlatRow: string | null): TranscriptRow[] {
  const result: TranscriptRow[] = [];
  let members: TimelineRow[] = [];
  const flush = (closed = true) => {
    if (!members.length) return;
    const content = members.filter(row => row.kind !== "message" ||
      Boolean((row.event.data.message as Record<string, unknown>).reasoning_content ||
        (row.event.data.message as Record<string, unknown>).reasoning));
    if (!content.length) { members = []; return; }
    if (mode === "verbose" || (mode === "detailed" && (content.every(row => flatRows.has(row.id.replace(/:reasoning$/, "")))
      || content.some(row => row.id === focusedFlatRow)))) {
      result.push(...content); members = []; return;
    }
    const id = `steps:${members[0].id}`, ids = memberIds(members);
    const open = choices.get(id) ?? (focusedRow !== null && focusedRow !== id && ids.includes(focusedRow));
    const seen = new Set<string>();
    const calls = members.flatMap(row => row.kind === "tools" ? row.batch.calls : []).filter(call => {
      const key = String(call.data["call-id"] || call.data.call_id || call.id);
      if (seen.has(key)) return false; seen.add(key); return true;
    });
    const reasoningCount = content.filter(row => row.kind === "message").length;
    result.push({ id, kind: "step-control", open, members: ids, batch: { id, calls }, reasoningCount, content, closed });
    if (open) result.push(...content);
    members = [];
  };
  for (const row of rows) {
    const message = row.kind === "message" ? row.event.data.message as Record<string, unknown> : undefined;
    if (row.kind === "message" && message?.role === "assistant" && hasMessageContent(message.content) &&
      (message.reasoning_content || message.reasoning) && !hiddenReasoning.has(row.id)) {
      const { reasoning_content, reasoning, ...response } = message;
      members.push({ ...row, id: `${row.id}:reasoning`, event: { ...row.event,
        data: { ...row.event.data, message: { role: "assistant", reasoning_content, reasoning } } } });
      flush();
      result.push({ ...row, event: { ...row.event, data: { ...row.event.data, message: response } } });
      continue;
    }
    if (row.kind === "tools" || row.kind === "context" || (row.kind === "decision" && row.event.data.decision === "allow") ||
      (message?.role === "assistant" && !hasMessageContent(message.content))) members.push(row as TimelineRow);
    else { flush(); result.push(row); }
  }
  flush(!members.some(row => activeRows.has(row.id.replace(/:reasoning$/, ""))));
  return result;
}

/** Fold only settled, uninterrupted turns; retain answers, decisions and failure outcomes. */
export function displayTranscript(model: TimelineModel, mode: TranscriptView,
  choices: ReadonlyMap<string, boolean>, focusedRow: string | null = null, timing: CollapseTiming = "completion", replies: FoldedReplies = "all", focusedFlatRow: string | null = null): {
    rows: TranscriptRow[]; hiddenReasoning: ReadonlySet<string>; activeRows: ReadonlySet<string>;
  } {
  const rows: Array<TimelineRow | TurnControl> = [];
  const hiddenReasoning = new Set<string>();
  const activeRows = new Set<string>();
  const flatRows = new Set<string>();
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
          if (Array.isArray(message.tool_calls) && message.tool_calls.length) finalId = undefined;
          else if (messageText(message.content)) finalId = row.id;
          if (replies === "final" || !hasMessageContent(message.content)) process.add(row.id);
          else if (message.reasoning_content || message.reasoning) process.add(`${row.id}:reasoning`);
        }
      } else if (row.kind === "tools") { started = true; finalId = undefined; process.add(row.id); }
      else if (row.kind === "context") process.add(row.id);
      else if (row.kind === "decision" && row.event.data.decision === "allow") process.add(row.id);
    }
    if (finalId) { process.delete(finalId); process.delete(`${finalId}:reasoning`); }
    const final = segment.find(row => row.id === finalId);
    const finalMessage = final?.kind === "message" ? final.event.data.message as Record<string, unknown> : undefined;
    const finalReasoning = Boolean(finalMessage?.reasoning_content || finalMessage?.reasoning);
    const count = segment.reduce((sum, row) => {
      if (!process.has(row.id) && !process.has(`${row.id}:reasoning`)) return sum;
      if (row.kind === "tools") return sum + row.batch.calls.length;
      if (row.kind === "context") return sum + 1;
      if (row.kind !== "message") return sum;
      const message = row.event.data.message as Record<string, unknown>;
      return sum + Number(Boolean(messageText(message.content) || message.reasoning_content || message.reasoning));
    }, finalReasoning ? 1 : 0);
    if (!settled || interrupted || !count || mode === "verbose") { rows.push(...segment); segment = []; return; }
    if (timing === "next-input" && lastUserInputIndex <= outcomeIndex) segment.forEach(row => flatRows.add(row.id));
    const outcome = segment.at(-1)!;
    const id = `process:${outcome.id}`;
    const hasLaterUserInput = lastUserInputIndex > outcomeIndex;
    const focusedOwner = focusedRow?.replace(/^steps:/, "").replace(/:reasoning$/, "");
    const open = choices.get(id) ?? ((timing === "next-input" && !hasLaterUserInput)
      || (focusedOwner != null && (process.has(focusedOwner) || (focusedOwner === finalId && finalReasoning))));
    let failed = 0, missing = 0;
    for (const row of segment) if (row.kind === "tools") for (const call of row.batch.calls) {
      const result = model.results.get(String(call.data["call-id"] || call.data.call_id || ""));
      if (!result) missing++; else if (toolFailed(result)) failed++;
    }
    const summary = [failed ? t("{0} 失败", failed) : "", missing ? t("{0} 项结果未确认", missing) : ""].filter(Boolean);
    const startedAt = segment.find(row => "event" in row)?.event.at;
    const endedAt = "event" in outcome ? outcome.event.at : undefined;
    const elapsed = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : NaN;
    const duration = Number.isFinite(elapsed) ? t("，用时 {0}秒", Math.max(1, Math.round(elapsed / 1000))) : "";
    const terminal = outcome.kind === "outcome" ? runOutcome(outcome.event.data) : null;
    // In compact view the outer summary carries the truthful outcome once.
    if (mode === "compact" && terminal) process.add(outcome.id);
    let inserted = false;
    for (const row of segment) {
      if (!inserted && (process.has(row.id) || process.has(`${row.id}:reasoning`) || row.id === finalId)) {
        rows.push({ id, kind: "turn-control", open,
          caption: terminal ? `${outcomeText(terminal)}${duration}${summary.length ? ` · ${summary.join(" · ")}` : ""}`
            : t("已完成{0}{1}", duration, summary.length ? ` · ${summary.join(" · ")}` : ""),
          members: memberIds(segment),
          label: t("工作步骤 · {0} 项{1}", count, summary.length ? ` · ${summary.join(" · ")}` : "") });
        inserted = true;
      }
      if (!open && process.has(`${row.id}:reasoning`)) hiddenReasoning.add(row.id);
      if (open || !process.has(row.id)) rows.push(row);
    }
    if (!open && finalId) hiddenReasoning.add(finalId);
    segment = [];
  };
  for (const [index, row] of model.rows.entries()) {
    segment.push(row);
    if (row.kind === "outcome") flush(row.event.data.status === "completed", index);
  }
  for (const row of segment) { activeRows.add(row.id); flatRows.add(row.id); }
  flush(false);
  return { rows: processGroups(rows, mode, choices, focusedRow, hiddenReasoning, flatRows, activeRows, focusedFlatRow), hiddenReasoning, activeRows };
}
