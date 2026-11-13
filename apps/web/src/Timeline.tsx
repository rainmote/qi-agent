import { uiText as t } from "./i18n";
import { useWebPreferences } from "./web-preferences";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject, type ReactNode } from "react";
import { Icon } from "./icons";
import { MarkdownContent } from "./MarkdownContent";
import { ToolResultImages } from "./ToolResultImages";
import { PluginSlots, type PluginSlot } from "./PluginSlots";
import type { Projection } from "./projection";
import { type ToolBatch, type QueuedState } from "./timeline-model";
import { captureAnchor, restoreAnchor, timelineLayout, visibleRange, type RowMeasurement, type ScrollAnchor } from "./virtual-timeline";
import type { DurableEvent } from "./types";
import { outcomeText, runOutcome } from "./run-outcome";
import { messageText } from "./message-content";
import { continuableRun } from "./run-continuation";
import { displayTranscript, type CollapseTiming, type TranscriptView, type TranscriptRow, type StepControl, type FoldedReplies } from "./transcript-display";

import { processCategory, processDetail, processSummary } from "./process-summary";

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value, null, 2);
}

function callId(event: DurableEvent): string {
  return String(event.data["call-id"] || event.data.call_id || "");
}

function oneLine(value: unknown): string {
  return text(value).replace(/\s+/g, " ").trim();
}

function truncated(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function operationTarget(call: DurableEvent, maxLength = 96): string {
  const name = String(call.data.name || "tool");
  const args = call.data.arguments && typeof call.data.arguments === "object" &&
    !Array.isArray(call.data.arguments)
    ? call.data.arguments as Record<string, unknown>
    : {};
  const path = oneLine(args.path || args.file || args.url);
  const cwd = oneLine(args.cwd || ".");
  let target = path;
  if (name === "bash") target = [cwd, oneLine(args.command)].filter(Boolean).join(" · ");
  else if (name === "bb_repl") target = oneLine(args.code);
  else if (name === "grep") target = [path || ".", oneLine(args.query)].filter(Boolean).join(" · ");
  else if (name === "find") target = [path || ".", oneLine(args.pattern)].filter(Boolean).join(" · ");
  else if (name === "lsp_query") {
    target = [path || ".", oneLine(args.action), oneLine(args.symbol)].filter(Boolean).join(" · ");
  } else if (name === "delegate_task" || name === "fork_agent") {
    target = oneLine(args.label || args.prompt || args.task);
  } else if (!target) {
    target = oneLine(args.title || args.name || args.id || args.agent_id || args.query || args.command ||
      args.code || args.prompt || args);
  }
  return truncated(target || "—", maxLength);
}

export type { ToolBatch } from "./timeline-model";

export function buildToolBatches(events: DurableEvent[]): {
  batches: Map<string, ToolBatch>;
  groupedCallIds: Set<string>;
} {
  const batches = new Map<string, ToolBatch>();
  const groupedCallIds = new Set<string>();
  let calls: DurableEvent[] = [];
  const flush = () => {
    if (!calls.length) return;
    const [first, ...rest] = calls;
    batches.set(first.id, { id: first.id, calls });
    rest.forEach((call) => groupedCallIds.add(call.id));
    calls = [];
  };
  for (const event of events) {
    if (event.type === "step/start") flush();
    if (event.type === "tool/call") calls.push(event);
    if (event.type === "step/end") flush();
  }
  flush();
  return { batches, groupedCallIds };
}

export function pluginResultData(result: DurableEvent): unknown {
  if (result.data.value !== undefined) return result.data.value;
  const content = result.data.content;
  if (typeof content !== "string" || content.length > 524288) return null;
  try { return JSON.parse(content) as unknown; } catch { return null; }
}

export function toolBatchStatus(batch: ToolBatch, results: ReadonlyMap<string, DurableEvent>, active: boolean) {
  const completed = batch.calls.filter(call => results.has(callId(call))).length;
  const failed = batch.calls.filter(call => results.get(callId(call))?.data.ok === false).length;
  const missing = batch.calls.length - completed;
  return { completed, failed, missing, running: active && missing > 0 };
}

const toolCategories: Record<string, string> = {
  read: "读取", read_file: "读取", write: "写入", write_file: "写入", edit: "编辑", edit_file: "编辑",
  grep: "搜索", find: "搜索", lsp_query: "代码查询", bash: "命令", bb_repl: "代码执行",
  delegate_task: "子任务", fork_agent: "子任务", web_search: "网页搜索", web_fetch: "网页读取",
  computer_js: "电脑操作", computer_js_reset: "电脑操作", terminal: "命令",
};

export function toolBatchLabel(batch: ToolBatch): string {
  if (batch.calls.length === 1) return String(batch.calls[0].data.name || "tool");
  const counts = new Map<string, number>();
  for (const call of batch.calls) {
    const name = String(call.data.name || "tool"), label = toolCategories[name] ? t(toolCategories[name]) : name;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const categories = [...counts].slice(0, 3).map(([name, count]) => `${name} ×${count}`);
  return `${categories.join(" · ")}${counts.size > 3 ? t(" · 等 {0} 项", batch.calls.length) : ""}`;
}

function ProcessGroup({ row, results, activeCalls, mode, reasoning, onToggle, children }: {
  row: StepControl; results: ReadonlyMap<string, DurableEvent>; activeCalls: ReadonlySet<string>;
  mode: TranscriptView; reasoning: string; onToggle: () => void; children: ReactNode;
}) {
  const { failed, missing } = toolBatchStatus(row.batch, results, false);
  const runningCalls = row.batch.calls.filter(call => activeCalls.has(call.id) && !results.has(callId(call)));
  const current = runningCalls.reduce<DurableEvent | undefined>((latest, call) =>
    !latest || Date.parse(call.at) >= Date.parse(latest.at) ? call : latest, undefined);
  const category = current ? processCategory(String(current.data.name || "")) : {label:"正在思考", icon:"think" as const};
  const summary = processSummary(row.batch.calls, row.content.some(item => item.kind === "context"));
  const detail = current ? processDetail(current.data.arguments) : reasoning.trim().split(/\n\s*\n/).at(-1)?.replace(/\s+/g, " ") || "";
  const nextTitle = row.closed ? summary.label : `${t(category.label)}${mode === "standard" && detail ? ` · ${detail}` : ""}`;
  const [title, setTitle] = useState(nextTitle);
  const shownAt = useRef(0);
  useEffect(() => {
    const apply = () => { setTitle(nextTitle); shownAt.current = performance.now(); };
    if (row.closed) { apply(); return; }
    const timer = setTimeout(apply, Math.max(0, 150 - (performance.now() - shownAt.current)));
    return () => clearTimeout(timer);
  }, [nextTitle, row.closed]);
  const body = useRef<HTMLDivElement>(null);
  const [fades, setFades] = useState("");
  const updateFades = useCallback(() => {
    const el = body.current;
    setFades(el ? `${el.scrollTop > 1 ? "fade-top" : ""} ${el.scrollHeight - el.clientHeight - el.scrollTop > 1 ? "fade-bottom" : ""}` : "");
  }, []);
  useLayoutEffect(() => {
    if (row.open && body.current) body.current.scrollTop = row.closed ? 0 : body.current.scrollHeight;
    updateFades();
  }, [row.open]);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const observer = new ResizeObserver(updateFades); observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    updateFades(); return () => observer.disconnect();
  }, [row.open, updateFades]);
  const warnings = [failed ? t("{0} 失败", failed) : "",
    missing > runningCalls.length ? t("{0} 项结果未确认", missing - runningCalls.length) : ""].filter(Boolean).join(" · ");
  const failure = row.batch.calls.map(call => results.get(callId(call))).find(result => result?.data.ok === false);
  return <section className={`compact-step-group process-group ${failed ? "is-error" : !row.closed ? "is-running" : ""}`}>
    <button type="button" className="compact-step-toggle" aria-expanded={row.open} aria-controls={`${row.id}:body`} onClick={onToggle}>
      <span className="process-leading"><Icon name={row.closed ? summary.icon : category.icon} /><Icon name="chevronDown" /></span>
      <span className="process-label" title={nextTitle}>{row.closed ? nextTitle : title}</span>
      {warnings && <span className="process-warning">{warnings}</span>}
    </button>
    {!row.open && failure && <p className="tool-failure">{truncated(oneLine(failure.data.error || failure.data.content) || t("调用失败，展开查看参数"), 140)}</p>}
    {row.open && <div id={`${row.id}:body`} className={`process-body ${fades}`} ref={body} onScroll={updateFades}>
      <div className="process-content">{children}</div>
    </div>}
  </section>;
}

function ToolDetails({ call, result, pluginSlots }: {
  call: DurableEvent; result?: DurableEvent; pluginSlots: PluginSlot[];
}) {
  return <div className="tool-details">
    <div><span>{t("参数")}</span><pre>{text(call.data.arguments) || "{}"}</pre></div>
    {result && <div><span>{t("结果")}</span>
      <pre>{text(result.data.content || result.data.error)}</pre>
      <ToolResultImages images={result.data.images} />
      {result.data.ok !== false && <PluginSlots slots={pluginSlots} slot="tool-result"
        toolName={String(call.data.name || "tool")} data={pluginResultData(result)} />}</div>}
  </div>;
}

function ToolRows({ batch, results, active, expanded, onToolToggle, pluginSlots }: {
  batch: ToolBatch; results: ReadonlyMap<string, DurableEvent>; active: boolean;
  expanded: ReadonlySet<string>; onToolToggle: (id: string, open: boolean) => void; pluginSlots: PluginSlot[];
}) {
  const { failed, missing, running } = toolBatchStatus(batch, results, active);
  return <article data-ungrouped="true" data-tool={batch.calls.length === 1 ? String(batch.calls[0].data.name) : undefined}
    className={`tool-card tool-batch ${failed ? "is-error" : running ? "is-running" : missing ? "is-unconfirmed" : "is-success"}`}>
    <div className="tool-batch-items">
      {batch.calls.map((call) => {
        const result = results.get(callId(call));
        const detailId = `call:${call.id}`, detailOpen = expanded.has(detailId);
        return <section key={call.id} data-tool-call={String(call.data.name || "tool")}>
          <button type="button" className="tool-batch-row" aria-expanded={detailOpen}
            onClick={() => onToolToggle(detailId, !detailOpen)}>
          <span className="tool-batch-name"><Icon name={processCategory(String(call.data.name || "")).icon} />{t(processCategory(String(call.data.name || "")).label)}</span>
          <span className="tool-target" title={operationTarget(call, 10_000)}>{call.data.name === "bash" && call.data.arguments && typeof call.data.arguments === "object" && "description" in call.data.arguments ? String(call.data.arguments.description) : operationTarget(call)}</span>
          <span className={`tool-item-status ${result?.data.ok === false ? "failed" : result ? "completed" : ""}`}>
            {result ? (result.data.ok === false ? t("失败") : t("完成")) : active ? t("等待") : t("未确认")}
          </span>
          {result?.data["duration-ms"] != null
            ? <span className="tool-duration">{String(result.data["duration-ms"])} ms</span>
            : <span className="tool-duration" />}
          <Icon name="chevron" className={detailOpen ? "rotate" : ""} />
          </button>
          {result?.data.ok === false && !detailOpen && <p className="tool-failure">{truncated(oneLine(result.data.error || result.data.content), 140)}</p>}
          {detailOpen && <ToolDetails call={call} result={result} pluginSlots={pluginSlots} />}
        </section>;
      })}
    </div>
  </article>;
}

type MessageAttachment = { type: "attachment"; id: string; workspaceId: string; name: string; mime: string; size: number };
function validAttachment(value: unknown): value is MessageAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.type === "attachment" && typeof item.id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(item.id)
    && typeof item.workspaceId === "string" && /^[a-f0-9]{16}$/.test(item.workspaceId)
    && typeof item.name === "string" && item.name.length > 0 && item.name.length <= 255
    && typeof item.mime === "string" && item.mime.length <= 120
    && typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 1 && item.size <= 8 * 1024 * 1024;
}
export function UserMessageAttachments({ content }: { content: unknown }) {
  if (!Array.isArray(content)) return null;
  const candidates = content.filter((item) => item && typeof item === "object" && item.type === "attachment");
  if (!candidates.length) return null;
  return <div className="message-attachments" aria-label={t("消息附件")} style={{ display: "grid", gap: 10, maxWidth: "100%" }}>
    {candidates.slice(0, 8).map((item, index) => {
      if (!validAttachment(item)) return <p key={index}>{t("附件引用不可用。")}</p>;
      const path = `/api/workspaces/${encodeURIComponent(item.workspaceId)}/attachments/${encodeURIComponent(item.id)}`;
      return <figure key={`${item.id}-${index}`} style={{ margin: 0, minWidth: 0 }}>
        {/^(image\/(png|jpeg|gif|webp))$/.test(item.mime) && <img src={`${path}?download=0`} alt={item.name}
          loading="lazy" style={{ display: "block", maxWidth: "100%", maxHeight: 240, objectFit: "contain", borderRadius: 8 }} />}
        <figcaption style={{ display: "flex", gap: 8, flexWrap: "wrap", overflowWrap: "anywhere" }}>
          <a href={`${path}?download=1`} download={item.name}>{item.name}</a><small>{Math.ceil(item.size / 1024)} KiB</small>
        </figcaption>
      </figure>;
    })}
    {candidates.length > 8 && <p>{candidates.length - 8}{" " + t("个附件未显示。")}</p>}
  </div>;
}

function QueuedMessage({ event, state }: { event: DurableEvent; state: QueuedState }) {
  const content = messageText(event.data.message);
  const reasons: Record<string, string> = {
    aborted: "运行已取消", error: "运行失败", "tool-terminated": "工具已结束本轮运行",
  };
  const reason = reasons[String(event.data.reason)];
  const status = state === "uncertain" ? t("发送状态未确认")
    : state === "discarded" ? `${t("未发送")}${reason ? ` · ${t(reason)}` : ""}`
    : event.data.kind === "steer" ? t("等待插话") : t("等待发送");
  return <article className="message message-user message-queued">
    <div className="message-body">
      <div className="queue-status" role="status">{status}</div>
      {content && <div className="message-content">{content}</div>}
      <UserMessageAttachments content={event.data.message} />
      {content && <div className="message-actions"><button type="button" aria-label={t("复制")}
        onClick={() => void navigator.clipboard.writeText(content)}><Icon name="copy" /></button></div>}
    </div>
  </article>;
}

function Message({ event, reasoningOpen, onReasoningToggle, hideReasoning = false, compact = false, showActions = true }: {
  event: DurableEvent; reasoningOpen: boolean; onReasoningToggle: (open: boolean) => void;
  hideReasoning?: boolean; compact?: boolean; showActions?: boolean;
}) {
  const message = event.data.message as Record<string, unknown> | undefined;
  if (!message || message.role === "tool") return null;
  const role = String(message.role || "assistant");
  const content = messageText(message.content);
  const hasAttachments = Array.isArray(message.content) && message.content.some((item) => item?.type === "attachment");
  const reasoning = text(message.reasoning_content || message.reasoning);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
  if (!content && !calls && !hasAttachments && !reasoning) return null;
  return <article className={`message message-${role}${!content && reasoning ? " message-process" : ""}`}>
    <div className="message-body">
      {role === "assistant" && reasoning && !hideReasoning && <details className="reasoning-row" open={reasoningOpen}
        onToggle={event => { if (event.target === event.currentTarget) onReasoningToggle(event.currentTarget.open); }}>
        <summary><Icon name="think" /><span>{t("思考")}</span>
          {!compact && !reasoningOpen && <span className="reasoning-first-line">{reasoning.split(/\r?\n/, 1)[0].replaceAll("**", "")}</span>}
          <Icon name="chevron" /></summary>
        <div><MarkdownContent content={reasoning} /></div></details>}
      {content && (role === "assistant"
        ? <MarkdownContent content={content} />
        : <div className="message-content">{content}</div>)}
      {role === "user" && <UserMessageAttachments content={message.content} />}
      {!compact && !content && calls > 0 && <div className="message-muted">{t("准备调用") + " "}{calls}{" " + t("个工具")}</div>}
      {content && (role !== "assistant" || showActions) && <div className="message-actions"><button type="button" aria-label={t("复制")}
        onClick={() => void navigator.clipboard.writeText(content)}><Icon name="copy" /></button>
        <time>{t("{0}月{1}日 {2}", new Date(event.at).getMonth() + 1, new Date(event.at).getDate(), new Date(event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }))}</time></div>}
    </div>
  </article>;
}

type DisplayRow = TranscriptRow | { id: string; kind: "stream" | "run-error" };

function estimateRow(row: DisplayRow, width: number): number {
  if (row.kind === "context" || row.kind === "continuation") return 64;
  if (row.kind === "tools") return 52;
  if (row.kind === "decision" || row.kind === "error" || row.kind === "run-error" || row.kind === "outcome") return 64;
  if (!("event" in row)) return 100;
  const content = row.kind === "queued" ? messageText(row.event.data.message)
    : text((row.event.data.message as Record<string, unknown>).content);
  const lines = content.split("\n").reduce((total, line) =>
    total + Math.max(1, Math.ceil(line.length / Math.max(20, width / 10))), 0);
  return Math.min(2_000, (row.kind === "queued" ? 90 : 62) + lines * 23);
}

export function Timeline({ projection, scrollRef, pluginSlots = [], view = "standard", collapseTiming = "completion", foldedReplies = "all", onContinue, continueDisabled = false }: {
  projection: Projection; scrollRef: RefObject<HTMLDivElement | null>; pluginSlots?: PluginSlot[];
  view?: TranscriptView; collapseTiming?: CollapseTiming; foldedReplies?: FoldedReplies;
  onContinue?: (runId: string) => void; continueDisabled?: boolean;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const rowContainer = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const [measurements, setMeasurements] = useState<ReadonlyMap<string, RowMeasurement>>(new Map());
  const [viewport, setViewport] = useState({ top: Number.MAX_SAFE_INTEGER, height: 800, width: 760 });
  const [following, setFollowing] = useState(true);
  const follow = useRef(true);
  const anchor = useRef<ScrollAnchor | null>(null);
  const ignoredScrollTop = useRef<number | null>(null);
  const [choices, setExpanded] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const [focusedUngroupedRow, setFocusedUngroupedRow] = useState<string | null>(null);
  const { locale } = useWebPreferences();
  const continueRunId = onContinue ? continuableRun(projection) : null;
  const expanded = useMemo(() => new Set([...choices].filter(([,open]) => open).map(([id]) => id)), [choices]);
  const setExpandedRow = useCallback((id: string, open: boolean) => setExpanded((current) => {
    if (current.get(id) === open) return current;
    const next = new Map(current);
    next.set(id, open);
    return next;
  }), []);
  const partialAssistant = String(projection.state["partial-assistant"] || projection.state.partialAssistant || "");
  const partialReasoning = String(projection.state["partial-reasoning"] || projection.state.partialReasoning || "");
  const streaming = projection.state.phase === "model" && Boolean(partialAssistant || partialReasoning);
  const presentationModel = useMemo(() => streaming ? { ...projection.timeline, rows: [...projection.timeline.rows, {
    id: "__live-stream__", kind: "message" as const, event: { id: "__live-stream__", seq: 0, type: "message", at: "",
      data: { message: { role: "assistant", content: partialAssistant, reasoning_content: partialReasoning } } },
  }] } : projection.timeline, [projection.timeline, streaming, partialAssistant, partialReasoning]);
  const transcript = useMemo(() => displayTranscript(presentationModel, view, choices, focusedRow, collapseTiming, foldedReplies, focusedUngroupedRow),
    [presentationModel, view, choices, focusedRow, collapseTiming, foldedReplies, focusedUngroupedRow, locale]);
  const activeCalls = new Set(projection.state.phase !== "idle" || projection.interactions.length > 0
    ? projection.timeline.rows.flatMap(row => row.kind === "tools" && transcript.activeRows.has(row.id) ? row.batch.calls.map(call => call.id) : []) : []);
  const rememberFocusedProcess = () => {
    const retained = transcript.rows.filter(row => (row.kind === "turn-control" || row.kind === "step-control") && row.open
      && focusedRow !== null && row.members.includes(focusedRow));
    if (!retained.length) return;
    setExpanded(current => {
      if (retained.every(row => current.has(row.id))) return current;
      const next = new Map(current);
      retained.forEach(row => { if (!next.has(row.id)) next.set(row.id, true); });
      return next;
    });
  };
  const rows = useMemo<DisplayRow[]>(() => {
    const nested = new Set(transcript.rows.flatMap(row => row.kind === "step-control" && row.open ? row.content.map(item => item.id) : []));
    return [...transcript.rows.filter(row => !nested.has(row.id)),
      ...(projection.lastRunError ? [{ id: "__run-error__", kind: "run-error" as const }] : [])];
  }, [transcript.rows, Boolean(projection.lastRunError)]);
  const layout = useMemo(() => timelineLayout(rows.map((row) => ({
    id: row.id, estimate: estimateRow(row, viewport.width),
  })), measurements, viewport.width), [rows, measurements, viewport.width]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const origin = useRef(38);
  const range = visibleRange(layout, Math.min(viewport.top - origin.current,
    Math.max(0, layout.total - viewport.height)), viewport.height);

  const updateViewport = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !rowContainer.current) return;
    origin.current = rowContainer.current.getBoundingClientRect().top -
      element.getBoundingClientRect().top + element.scrollTop;
    const next = { top: element.scrollTop, height: element.clientHeight, width: rowContainer.current.clientWidth };
    setViewport((current) => current.top === next.top && current.height === next.height && current.width === next.width
      ? current : next);
  }, [scrollRef]);

  const measure = useCallback(() => {
    const width = rowContainer.current?.clientWidth || 0;
    if (!width) return;
    const values = Array.from(nodes.current, ([id, element]) => [id, element.getBoundingClientRect().height] as const);
    setMeasurements((current) => {
      let next: Map<string, RowMeasurement> | undefined;
      for (const [id, height] of values) {
        const previous = current.get(id);
        if (height > 0 && (!previous || Math.abs(previous.height - height) >= 0.5 || previous.width !== width)) {
          next ||= new Map(current);
          next.set(id, { height, width });
        }
      }
      return next || current;
    });
  }, []);

  // Only the mounted window is observed. Tool disclosure, Markdown images and streaming
  // all change height after rendering; keeping the anchor by event ID avoids jumps.
  useLayoutEffect(() => { measure(); });
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    for (const element of nodes.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [range.start, range.end, rows, measure]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const restored = restoreAnchor(layout, anchor.current);
    const top = follow.current ? element.scrollHeight - element.clientHeight
      : restored === null ? element.scrollTop : restored + origin.current;
    if (Math.abs(element.scrollTop - Math.max(0, top)) >= 0.5) {
      element.scrollTop = Math.max(0, top);
      ignoredScrollTop.current = element.scrollTop;
    }
    anchor.current = captureAnchor(layout, element.scrollTop - origin.current);
    updateViewport();
  }, [layout, partialAssistant, partialReasoning, projection.lastRunError, viewport.height, scrollRef, updateViewport]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      if (ignoredScrollTop.current !== null && Math.abs(element.scrollTop - ignoredScrollTop.current) < 1) {
        ignoredScrollTop.current = null;
        updateViewport();
        return;
      }
      ignoredScrollTop.current = null;
      follow.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 64;
      setFollowing(follow.current);
      anchor.current = captureAnchor(layoutRef.current, element.scrollTop - origin.current);
      updateViewport();
    };
    const onResize = () => updateViewport();
    const observer = new ResizeObserver(onResize);
    observer.observe(element);
    if (inner.current) observer.observe(inner.current);
    element.addEventListener("scroll", onScroll, { passive: true });
    updateViewport();
    return () => { observer.disconnect(); element.removeEventListener("scroll", onScroll); };
  }, [scrollRef, updateViewport]);

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (!element) return;
    follow.current = true;
    setFollowing(true);
    element.scrollTop = element.scrollHeight;
    ignoredScrollTop.current = element.scrollTop;
    updateViewport();
  };

  const finalAssistantIds = new Set<string>();
  let finalAssistantId: string | null = null;
  for (const row of projection.timeline.rows) {
    if (row.kind === "tools") finalAssistantId = null;
    if (row.kind === "message") {
      const message = row.event.data.message as Record<string, unknown>;
      if (message.role === "assistant") {
        if (Array.isArray(message.tool_calls) && message.tool_calls.length) finalAssistantId = null;
        else if (messageText(message.content)) finalAssistantId = row.id;
      }
    }
    if (row.kind === "outcome") { if (finalAssistantId) finalAssistantIds.add(finalAssistantId); finalAssistantId = null; }
  }
  if (finalAssistantId) finalAssistantIds.add(finalAssistantId);
  const holdCompactPosition = () => {
    const element = scrollRef.current;
    if (!element) return;
    // A disclosure can grow the timeline between pointer-down and click.
    // Keep the user's anchor instead of moving the target to follow the tail.
    follow.current = false;
    setFollowing(element.scrollHeight - element.clientHeight - element.scrollTop <= 64);
    ignoredScrollTop.current = null;
    anchor.current = captureAnchor(layoutRef.current, element.scrollTop - origin.current);
  };
  const renderRow = (row: DisplayRow): ReactNode => <>
        {row.kind === "turn-control" && <button type="button" aria-label={view === "compact" ? `${row.label} · ${row.caption}` : row.label} className="turn-process-toggle" aria-expanded={row.open}
          onClick={() => {
            if (!row.open) setExpandedRow(row.id, true);
            else setExpanded(current => {
              const next = new Map(current);
              row.members.forEach(id => next.delete(id));
              next.set(row.id, false);
              return next;
            });
          }}><span>{row.caption}</span><Icon name="chevron" /></button>}
        {row.kind === "step-control" && <ProcessGroup row={projection.state.phase === "idle" ? {...row, closed: true} : row} results={projection.timeline.results}
          activeCalls={activeCalls} mode={view} reasoning={row.closed ? "" : partialReasoning}
          onToggle={() => setExpandedRow(row.id, !row.open)}>
          {row.content.map(child => <div className="process-row" key={child.id} data-row-id={child.id}>{renderRow(child)}</div>)}
        </ProcessGroup>}
        {row.kind === "message" && <Message event={row.event} reasoningOpen={expanded.has(row.id)}
          hideReasoning={transcript.hiddenReasoning.has(row.id)} compact={view === "compact"} showActions={finalAssistantIds.has(row.id)}
          onReasoningToggle={(open) => setExpandedRow(row.id, open)} />}
        {row.kind === "queued" && <QueuedMessage event={row.event} state={row.state} />}
        {row.kind === "context" && <details className="context-snapshot" open={choices.get(row.id) ?? false}
          onToggle={event => setExpandedRow(row.id, event.currentTarget.open)}>
          <summary>{t("本轮指令")}</summary>
          <p>{t("此轮开始时提供给模型的指令；后续变化以新的记录为准。")}</p>
          {(choices.get(row.id) ?? false) && <pre>{String(row.event.data.content).slice(0, 100_000)}</pre>}
          {String(row.event.data.content).length > 100_000 && <p>{t("指令较长，此处显示前 100000 个字符。")}</p>}
        </details>}
        {row.kind === "continuation" && <div className="continuation-receipt" role="status">{t("已请求继续生成")}</div>}
        {row.kind === "tools" && <ToolRows batch={row.batch} results={projection.timeline.results}
          active={projection.timeline.activeToolRow !== null && projection.timeline.rows[projection.timeline.activeToolRow]?.id === row.id
            && (projection.state.phase !== "idle" || projection.interactions.length > 0)}
          expanded={expanded} onToolToggle={setExpandedRow} pluginSlots={pluginSlots}
          />}
        {row.kind === "decision" && <div className={`decision-row ${row.event.data.decision === "allow" ? "allowed" : "denied"}`}>
          <Icon name="shield" /><span>{String(row.event.data.tool || t("工具"))} {row.event.data.decision === "allow" ? t("已获批准") : t("被拒绝")}</span>
        </div>}
        {row.kind === "error" && <div className="inline-error">{String(row.event.data.message || t("运行失败"))}</div>}
        {row.kind === "outcome" && <div className={`run-outcome ${row.event.data.status}`}>
          {outcomeText(runOutcome(row.event.data)!)}
          {continueRunId === runOutcome(row.event.data)?.["run-id"] && <button type="button" className="button ghost"
            aria-label={t("继续生成")} disabled={continueDisabled} title={t("继续原请求，保留当前草稿。")}
            onClick={() => onContinue?.(continueRunId!)}>{t("继续生成")}</button>}
        </div>}
        {row.kind === "run-error" && <div className="inline-error">{projection.lastRunError}</div>}
        {row.kind === "stream" && <article className="message message-assistant is-streaming">
          <div className="message-body">
            {partialReasoning && <details className="reasoning-row" open={choices.get("__reasoning__") ?? false}
              onToggle={event => setExpandedRow("__reasoning__", event.currentTarget.open)}><summary>{partialAssistant ? t("已完成分析") : t("正在思考")}<Icon name="chevron" /></summary>
              <div><MarkdownContent content={partialReasoning} /></div></details>}
            <MarkdownContent content={partialAssistant} />
          </div>
        </article>}
  </>;
  return <div className="timeline-inner virtualized-timeline" ref={inner} data-total-rows={rows.length} data-transcript-view={view}
    onPointerDownCapture={event => {
      if ((event.target as HTMLElement).closest("button, summary")) holdCompactPosition();
    }}
    onFocusCapture={event => {
      holdCompactPosition();
      rememberFocusedProcess();
      const target = event.target as HTMLElement;
      const row = target.closest<HTMLElement>("[data-row-id]")?.dataset.rowId || null;
      setFocusedRow(row);
      // Preserve the layout already holding focus; focusing a historical group
      // header must never replace that header with individual tool controls.
      setFocusedUngroupedRow(target.closest('.tool-batch[data-ungrouped="true"]') && !target.closest('.process-group') ? row : null);
    }}
    onBlurCapture={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
        rememberFocusedProcess(); setFocusedRow(null); setFocusedUngroupedRow(null);
      }
    }}
    data-window-start={range.start} data-window-end={range.end} data-scroll-top={Math.round(viewport.top)}>
    {!rows.length && projection.state.phase === "idle" &&
      <div className="empty-conversation">{t("描述任务，开始这段会话。")}</div>}
    <div ref={rowContainer} className="timeline-rows">
      <div className="timeline-spacer" aria-hidden="true" style={{ height: layout.offsets[range.start] || 0 }} />
      {rows.slice(range.start, range.end).map((row) => <div className="timeline-row" key={row.id}
        data-row-id={row.id} ref={(element) => {
          if (element) nodes.current.set(row.id, element); else nodes.current.delete(row.id);
        }}>
        {renderRow(row)}
      </div>)}
      <div className="timeline-spacer" aria-hidden="true" style={{ height: layout.total - (layout.offsets[range.end] || 0) }} />
    </div>
    {!following && <div className="timeline-jump"><button type="button" onClick={jumpToLatest}>{t("回到最新")}</button></div>}
  </div>;
}
