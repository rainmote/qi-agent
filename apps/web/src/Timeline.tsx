import { useMemo, useState } from "react";
import { Icon } from "./icons";
import { MarkdownContent } from "./MarkdownContent";
import { visibleEvents, type Projection } from "./projection";
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

export interface ToolBatch {
  id: string;
  calls: DurableEvent[];
}

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

function ToolBatchCard({ batch, results }: {
  batch: ToolBatch;
  results: ReadonlyMap<string, DurableEvent>;
}) {
  const [open, setOpen] = useState(false);
  const completed = batch.calls.filter((call) => results.has(callId(call))).length;
  const failed = batch.calls.filter((call) => results.get(callId(call))?.data.ok === false).length;
  const running = completed < batch.calls.length;
  const label = batch.calls.length === 1
    ? String(batch.calls[0].data.name || "tool")
    : `${batch.calls.length} 个工具调用`;
  return <article className={`tool-card tool-batch ${failed ? "is-error" : running ? "is-running" : "is-success"}`}>
    <button className="tool-summary" type="button" onClick={() => setOpen((value) => !value)}
      aria-expanded={open}>
      <span className="tool-icon"><Icon name="terminal" /></span>
      <span className="tool-name">{label}</span>
      <span className="tool-status">{failed
        ? `${failed} 失败`
        : running ? `${completed}/${batch.calls.length} 完成` : "全部完成"}</span>
      <Icon name="chevron" className={open ? "rotate" : ""} />
    </button>
    <div className="tool-batch-items">
      {batch.calls.map((call) => {
        const result = results.get(callId(call));
        const target = operationTarget(call);
        const fullTarget = operationTarget(call, 10_000);
        return <div className="tool-batch-row" key={call.id}>
          <span className="tool-batch-name">{String(call.data.name || "tool")}</span>
          <span className="tool-target" title={fullTarget}>{target}</span>
          <span className={`tool-item-status ${result?.data.ok === false ? "failed" : ""}`}>
            {result ? (result.data.ok === false ? "失败" : "完成") : "等待"}
          </span>
          {result?.data["duration-ms"] != null
            ? <span className="tool-duration">{String(result.data["duration-ms"])} ms</span>
            : <span className="tool-duration" />}
        </div>;
      })}
    </div>
    {open && <div className="tool-details tool-batch-details">
      {batch.calls.map((call) => {
        const result = results.get(callId(call));
        return <section key={call.id}>
          <strong>{String(call.data.name || "tool")}</strong>
          <div><span>参数</span><pre>{text(call.data.arguments) || "{}"}</pre></div>
          {result && <div><span>结果</span>
            <pre>{text(result.data.content || result.data.error)}</pre></div>}
        </section>;
      })}
    </div>}
  </article>;
}

function Message({ event }: { event: DurableEvent }) {
  const message = event.data.message as Record<string, unknown> | undefined;
  if (!message || message.role === "tool") return null;
  const role = String(message.role || "assistant");
  const content = text(message.content);
  const reasoning = text(message.reasoning_content || message.reasoning);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
  if (!content && !calls) return null;
  return <article className={`message message-${role}`}>
    <div className="message-body">
      {role === "assistant" && reasoning && <details className="reasoning-row"><summary><Icon name="sparkles" />思考过程</summary>
        <div>{reasoning}</div></details>}
      {content && (role === "assistant"
        ? <MarkdownContent content={content} />
        : <div className="message-content">{content}</div>)}
      {!content && calls > 0 && <div className="message-muted">准备调用 {calls} 个工具</div>}
      {content && <div className="message-actions"><button type="button" aria-label="复制"
        onClick={() => void navigator.clipboard.writeText(content)}><Icon name="copy" /></button>
        <time>{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>}
    </div>
  </article>;
}

export function Timeline({ projection }: { projection: Projection }) {
  const events = useMemo(() => visibleEvents(projection.events), [projection.events]);
  const results = useMemo(() => new Map(events
    .filter((event) => event.type === "tool/result")
    .map((event) => [callId(event), event])), [events]);
  const { batches, groupedCallIds } = useMemo(() => buildToolBatches(events), [events]);
  if (!events.length && projection.state.phase === "idle") {
    return <div className="timeline-inner"><div className="empty-conversation">描述任务，开始这段会话。</div></div>;
  }
  return <div className="timeline-inner">
    {events.map((event) => {
      if (event.type === "message") return <Message key={event.id} event={event} />;
      if (event.type === "tool/call") {
        if (groupedCallIds.has(event.id)) return null;
        const batch = batches.get(event.id) || { id: event.id, calls: [event] };
        return <ToolBatchCard key={batch.id} batch={batch} results={results} />;
      }
      if (event.type === "approval/decision") {
        const allowed = event.data.decision === "allow";
        return <div className={`decision-row ${allowed ? "allowed" : "denied"}`} key={event.id}>
          <Icon name="shield" />
          <span>{String(event.data.tool || "工具")} {allowed ? "已获批准" : "被拒绝"}</span>
        </div>;
      }
      if (event.type === "agent/error") {
        return <div className="inline-error" key={event.id}>{String(event.data.message || "运行失败")}</div>;
      }
      return null;
    })}
    {projection.state.phase !== "idle" && (projection.state["partial-assistant"] ||
      projection.state.partialAssistant || projection.state["partial-reasoning"] ||
      projection.state.partialReasoning) &&
      <article className="message message-assistant is-streaming">
        <div className="message-body">
          {(projection.state["partial-reasoning"] || projection.state.partialReasoning) &&
            <details className="reasoning-row" open><summary><Icon name="sparkles" />正在思考</summary>
              <div>{String(projection.state["partial-reasoning"] || projection.state.partialReasoning)}</div></details>}
          <MarkdownContent content={String(projection.state["partial-assistant"] ||
            projection.state.partialAssistant || "")} />
        </div>
      </article>}
    {projection.lastRunError && <div className="inline-error">{projection.lastRunError}</div>}
  </div>;
}
