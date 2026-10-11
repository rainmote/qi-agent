import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Icon } from "./icons";
import { MarkdownContent } from "./MarkdownContent";
import { ToolResultImages } from "./ToolResultImages";
import { PluginSlots, type PluginSlot } from "./PluginSlots";
import type { Projection } from "./projection";
import { type ToolBatch, type TimelineRow } from "./timeline-model";
import { captureAnchor, restoreAnchor, timelineLayout, visibleRange, type RowMeasurement, type ScrollAnchor } from "./virtual-timeline";
import type { DurableEvent } from "./types";

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
    target = oneLine(args.name || args.id || args.agent_id || args.query || args.command ||
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
};

export function toolBatchLabel(batch: ToolBatch): string {
  if (batch.calls.length === 1) return String(batch.calls[0].data.name || "tool");
  const counts = new Map<string, number>();
  for (const call of batch.calls) {
    const name = String(call.data.name || "tool"), label = toolCategories[name] || name;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const categories = [...counts].slice(0, 3).map(([name, count]) => `${name} ×${count}`);
  return `${categories.join(" · ")}${counts.size > 3 ? ` · 等 ${batch.calls.length} 项` : ""}`;
}

function ToolDetails({ call, result, pluginSlots }: {
  call: DurableEvent; result?: DurableEvent; pluginSlots: PluginSlot[];
}) {
  return <div className="tool-details">
    <div><span>参数</span><pre>{text(call.data.arguments) || "{}"}</pre></div>
    {result && <div><span>结果</span>
      <pre>{text(result.data.content || result.data.error)}</pre>
      <ToolResultImages images={result.data.images} />
      {result.data.ok !== false && <PluginSlots slots={pluginSlots} slot="tool-result"
        toolName={String(call.data.name || "tool")} data={pluginResultData(result)} />}</div>}
  </div>;
}

function ToolBatchCard({ batch, results, active, open, onToggle, expanded, onToolToggle, pluginSlots }: {
  batch: ToolBatch;
  results: ReadonlyMap<string, DurableEvent>;
  active: boolean;
  open: boolean;
  onToggle: () => void;
  expanded: ReadonlySet<string>;
  onToolToggle: (id: string, open: boolean) => void;
  pluginSlots: PluginSlot[];
}) {
  const { completed, failed, missing, running } = toolBatchStatus(batch, results, active);
  const current = running ? batch.calls.find(call => !results.has(callId(call))) : undefined;
  const failedCall = batch.calls.find(call => results.get(callId(call))?.data.ok === false);
  const failure = failedCall && results.get(callId(failedCall));
  const label = toolBatchLabel(batch);
  const single = batch.calls.length === 1;
  return <article className={`tool-card tool-batch ${failed ? "is-error" : running ? "is-running" : missing ? "is-unconfirmed" : "is-success"}`}>
    <button className="tool-summary" type="button" onClick={onToggle}
      aria-expanded={open}>
      <span className="tool-icon"><Icon name="terminal" /></span>
      <span className="tool-summary-copy"><span className="tool-name">{label}</span>
        {single && <span className="tool-summary-target" title={operationTarget(batch.calls[0], 10_000)}>{operationTarget(batch.calls[0])}</span>}</span>
      <span className="tool-status">{failed ? `${failed} 失败${missing ? ` · ${missing} ${running ? "等待" : "未确认"}` : ""}`
        : running ? `${completed}/${batch.calls.length} 完成`
        : missing ? `${missing} 项结果未确认` : `${completed} 项完成`}</span>
      <Icon name="chevron" className={open ? "rotate" : ""} />
    </button>
    {!open && current && !single && <p className="tool-activity">正在调用 {String(current.data.name || "tool")} · {operationTarget(current)}</p>}
    {!open && failure && <p className="tool-failure">{String(failedCall!.data.name || "tool")} · {truncated(oneLine(failure.data.error || failure.data.content) || "调用失败，展开查看参数", 140)}</p>}
    {open && single && <ToolDetails call={batch.calls[0]} result={results.get(callId(batch.calls[0]))} pluginSlots={pluginSlots} />}
    {open && !single && <div className="tool-batch-items">
      {batch.calls.map((call) => {
        const result = results.get(callId(call));
        const detailId = `call:${call.id}`, detailOpen = expanded.has(detailId);
        return <section key={call.id}>
          <button type="button" className="tool-batch-row" aria-expanded={detailOpen}
            onClick={() => onToolToggle(detailId, !detailOpen)}>
          <span className="tool-batch-name">{String(call.data.name || "tool")}</span>
          <span className="tool-target" title={operationTarget(call, 10_000)}>{operationTarget(call)}</span>
          <span className={`tool-item-status ${result?.data.ok === false ? "failed" : result ? "completed" : ""}`}>
            {result ? (result.data.ok === false ? "失败" : "完成") : active ? "等待" : "未确认"}
          </span>
          {result?.data["duration-ms"] != null
            ? <span className="tool-duration">{String(result.data["duration-ms"])} ms</span>
            : <span className="tool-duration" />}
          <Icon name="chevron" className={detailOpen ? "rotate" : ""} />
          </button>
          {detailOpen && <ToolDetails call={call} result={result} pluginSlots={pluginSlots} />}
        </section>;
      })}
    </div>}
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
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return text(content);
  return content.filter((item) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string).join("\n");
}
export function UserMessageAttachments({ content }: { content: unknown }) {
  if (!Array.isArray(content)) return null;
  const candidates = content.filter((item) => item && typeof item === "object" && item.type === "attachment");
  if (!candidates.length) return null;
  return <div className="message-attachments" aria-label="消息附件" style={{ display: "grid", gap: 10, maxWidth: "100%" }}>
    {candidates.slice(0, 8).map((item, index) => {
      if (!validAttachment(item)) return <p key={index}>附件引用不可用。</p>;
      const path = `/api/workspaces/${encodeURIComponent(item.workspaceId)}/attachments/${encodeURIComponent(item.id)}`;
      return <figure key={`${item.id}-${index}`} style={{ margin: 0, minWidth: 0 }}>
        {/^(image\/(png|jpeg|gif|webp))$/.test(item.mime) && <img src={`${path}?download=0`} alt={item.name}
          loading="lazy" style={{ display: "block", maxWidth: "100%", maxHeight: 240, objectFit: "contain", borderRadius: 8 }} />}
        <figcaption style={{ display: "flex", gap: 8, flexWrap: "wrap", overflowWrap: "anywhere" }}>
          <a href={`${path}?download=1`} download={item.name}>{item.name}</a><small>{Math.ceil(item.size / 1024)} KiB</small>
        </figcaption>
      </figure>;
    })}
    {candidates.length > 8 && <p>{candidates.length - 8} 个附件未显示。</p>}
  </div>;
}

function Message({ event, reasoningOpen, onReasoningToggle }: {
  event: DurableEvent; reasoningOpen: boolean; onReasoningToggle: (open: boolean) => void;
}) {
  const message = event.data.message as Record<string, unknown> | undefined;
  if (!message || message.role === "tool") return null;
  const role = String(message.role || "assistant");
  const content = messageText(message.content);
  const hasAttachments = Array.isArray(message.content) && message.content.some((item) => item?.type === "attachment");
  const reasoning = text(message.reasoning_content || message.reasoning);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
  if (!content && !calls && !hasAttachments) return null;
  return <article className={`message message-${role}`}>
    <div className="message-body">
      {role === "assistant" && reasoning && <details className="reasoning-row" open={reasoningOpen}
        onToggle={(event) => onReasoningToggle(event.currentTarget.open)}><summary><Icon name="sparkles" />思考过程</summary>
        <div>{reasoning}</div></details>}
      {content && (role === "assistant"
        ? <MarkdownContent content={content} />
        : <div className="message-content">{content}</div>)}
      {role === "user" && <UserMessageAttachments content={message.content} />}
      {!content && calls > 0 && <div className="message-muted">准备调用 {calls} 个工具</div>}
      {content && <div className="message-actions"><button type="button" aria-label="复制"
        onClick={() => void navigator.clipboard.writeText(content)}><Icon name="copy" /></button>
        <time>{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>}
    </div>
  </article>;
}

type DisplayRow = TimelineRow | { id: string; kind: "stream" | "run-error" };

function estimateRow(row: DisplayRow, width: number): number {
  if (row.kind === "tools") return 52;
  if (row.kind === "decision" || row.kind === "error" || row.kind === "run-error") return 56;
  if (!("event" in row)) return 100;
  const message = row.event.data.message as Record<string, unknown>;
  const content = text(message.content);
  const lines = content.split("\n").reduce((total, line) =>
    total + Math.max(1, Math.ceil(line.length / Math.max(20, width / 10))), 0);
  return Math.min(2_000, 62 + lines * 23);
}

export function Timeline({ projection, scrollRef, pluginSlots = [] }: {
  projection: Projection; scrollRef: RefObject<HTMLDivElement | null>; pluginSlots?: PluginSlot[];
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const setExpandedRow = useCallback((id: string, open: boolean) => setExpanded((current) => {
    if (current.has(id) === open) return current;
    const next = new Set(current);
    if (open) next.add(id); else next.delete(id);
    return next;
  }), []);
  const partialAssistant = String(projection.state["partial-assistant"] || projection.state.partialAssistant || "");
  const partialReasoning = String(projection.state["partial-reasoning"] || projection.state.partialReasoning || "");
  const streaming = projection.state.phase !== "idle" && Boolean(partialAssistant || partialReasoning);
  const rows = useMemo<DisplayRow[]>(() => [
    ...projection.timeline.rows,
    ...(streaming ? [{ id: "__live-stream__", kind: "stream" as const }] : []),
    ...(projection.lastRunError ? [{ id: "__run-error__", kind: "run-error" as const }] : []),
  ], [projection.timeline.rows, streaming, Boolean(projection.lastRunError)]);
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

  return <div className="timeline-inner virtualized-timeline" ref={inner} data-total-rows={rows.length}
    data-window-start={range.start} data-window-end={range.end} data-scroll-top={Math.round(viewport.top)}>
    {!rows.length && projection.state.phase === "idle" &&
      <div className="empty-conversation">描述任务，开始这段会话。</div>}
    <div ref={rowContainer} className="timeline-rows">
      <div className="timeline-spacer" aria-hidden="true" style={{ height: layout.offsets[range.start] || 0 }} />
      {rows.slice(range.start, range.end).map((row) => <div className="timeline-row" key={row.id}
        data-row-id={row.id} ref={(element) => {
          if (element) nodes.current.set(row.id, element); else nodes.current.delete(row.id);
        }}>
        {row.kind === "message" && <Message event={row.event} reasoningOpen={expanded.has(row.id)}
          onReasoningToggle={(open) => setExpandedRow(row.id, open)} />}
        {row.kind === "tools" && <ToolBatchCard batch={row.batch} results={projection.timeline.results}
          active={projection.timeline.activeToolRow !== null && projection.timeline.rows[projection.timeline.activeToolRow]?.id === row.id
            && (projection.state.phase !== "idle" || projection.interactions.length > 0)}
          expanded={expanded} onToolToggle={setExpandedRow} pluginSlots={pluginSlots}
          open={expanded.has(row.id)} onToggle={() => setExpandedRow(row.id, !expanded.has(row.id))} />}
        {row.kind === "decision" && <div className={`decision-row ${row.event.data.decision === "allow" ? "allowed" : "denied"}`}>
          <Icon name="shield" /><span>{String(row.event.data.tool || "工具")} {row.event.data.decision === "allow" ? "已获批准" : "被拒绝"}</span>
        </div>}
        {row.kind === "error" && <div className="inline-error">{String(row.event.data.message || "运行失败")}</div>}
        {row.kind === "run-error" && <div className="inline-error">{projection.lastRunError}</div>}
        {row.kind === "stream" && <article className="message message-assistant is-streaming">
          <div className="message-body">
            {partialReasoning && <details className="reasoning-row" open><summary><Icon name="sparkles" />正在思考</summary>
              <div>{partialReasoning}</div></details>}
            <MarkdownContent content={partialAssistant} />
          </div>
        </article>}
      </div>)}
      <div className="timeline-spacer" aria-hidden="true" style={{ height: layout.total - (layout.offsets[range.end] || 0) }} />
    </div>
    {!following && <div className="timeline-jump"><button type="button" onClick={jumpToLatest}>回到最新</button></div>}
  </div>;
}
