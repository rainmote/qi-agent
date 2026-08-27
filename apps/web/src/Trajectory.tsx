import { Fragment, useMemo, useRef, useState, type PointerEvent } from "react";
import { Icon } from "./icons";
import type { DurableEvent } from "./types";

export type TrajectoryKind = "system" | "user" | "context" | "assistant" | "tool" | "error";

export interface TrajectoryRecord {
  id: string;
  index: number;
  seq: number;
  turn: number;
  request: number | null;
  kind: TrajectoryKind;
  label: string;
  text: string;
  detail: string;
  startedAt: number;
  durationMs: number | null;
}

interface ToolResult { data: Record<string, unknown>; }

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function compactText(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map((part) => {
    const block = objectValue(part);
    return compactText(block.text ?? block.content ?? part);
  }).filter(Boolean).join(" ");
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function clipped(value: string, maximum = 1_200): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function responseItemText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const texts: string[] = [];
  for (const item of value) {
    const record = objectValue(item);
    if (typeof record.text === "string") texts.push(record.text);
    if (!Array.isArray(record.content)) continue;
    for (const part of record.content) {
      const block = objectValue(part);
      if (typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

function responseCallCount(message: Record<string, unknown>): number {
  if (Array.isArray(message.tool_calls)) return message.tool_calls.length;
  if (!Array.isArray(message.response_items)) return 0;
  return message.response_items.filter((item) => objectValue(item).type === "function_call").length;
}

function detailJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function resultSummary(data: Record<string, unknown>): string {
  const error = compactText(data.error);
  if (error) return error;
  const content = compactText(data.content);
  if (content) return content;
  if (data.cancelled === true) return "Cancelled";
  if (data.ok === false || data["is-error"] === true) return "Failed";
  return data.ok === true ? "Completed" : "";
}

function eventTime(event: DurableEvent): number {
  const parsed = Date.parse(event.at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function duration(data: Record<string, unknown>): number | null {
  const value = data["duration-ms"] ?? data.duration_ms;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function eventLabel(type: string): string {
  return type.replaceAll("/", " ").replaceAll("-", " ");
}

/** Turn-aware, semantic projection used by the DeepSeek-style trajectory ledger. */
export function buildTrajectoryRecords(events: readonly DurableEvent[]): TrajectoryRecord[] {
  const sorted = [...events].sort((left, right) => left.seq - right.seq);
  const results = new Map<string, ToolResult>();
  for (const event of sorted) {
    if (event.type !== "tool/result") continue;
    const callId = String(event.data["call-id"] ?? event.data.call_id ?? "");
    if (callId) results.set(callId, { data: event.data });
  }

  let turn = 0;
  let request = 0;
  let activeRequest: number | null = null;
  const records: Omit<TrajectoryRecord, "index">[] = [];
  const push = (record: Omit<TrajectoryRecord, "index">) => records.push(record);

  for (const event of sorted) {
    const data = event.data;
    const startedAt = eventTime(event);

    if (event.type === "step/start") {
      request += 1;
      activeRequest = request;
      continue;
    }
    if (event.type === "step/end") continue;

    if (event.type === "session/start") {
      push({
        id: event.id, seq: event.seq, turn: 0, request: null, kind: "system", label: "SYSTEM",
        text: "Initial System Prompt", detail: detailJson(data), startedAt, durationMs: null,
      });
      continue;
    }

    if (event.type === "message") {
      const message = objectValue(data.message);
      const role = String(message.role ?? "");
      const content = clipped(compactText(message.content) || responseItemText(message.response_items));
      if (role === "user") {
        turn += 1;
        activeRequest = null;
        push({
          id: event.id, seq: event.seq, turn, request: null, kind: "user", label: "USER",
          text: content || "User message", detail: detailJson(data), startedAt, durationMs: null,
        });
      } else if (role === "assistant") {
        const calls = responseCallCount(message);
        push({
          id: event.id, seq: event.seq, turn, request: activeRequest, kind: "assistant", label: "ASSISTANT",
          text: content || (calls ? `Preparing to call ${calls} tools` : "Assistant response"),
          detail: detailJson(data), startedAt, durationMs: null,
        });
      }
      // Tool-role messages mirror tool/result and would duplicate the ledger row.
      continue;
    }

    if (event.type === "tool/call") {
      const callId = String(data["call-id"] ?? data.call_id ?? "");
      const name = String(data.name ?? "tool");
      const args = compactText(data.arguments);
      const paired = results.get(callId);
      const output = paired ? resultSummary(paired.data) : "";
      push({
        id: event.id,
        seq: event.seq,
        turn,
        request: activeRequest,
        kind: paired && (paired.data.ok === false || paired.data["is-error"] === true) ? "error" : "tool",
        label: "TOOL",
        text: clipped(`${name}${args ? ` ${args}` : ""}${output ? ` → ${output}` : ""}`),
        detail: detailJson({ call: data, result: paired?.data }),
        startedAt,
        durationMs: paired ? duration(paired.data) : null,
      });
      continue;
    }
    if (event.type === "tool/result") continue;

    if (event.type === "context/snapshot") {
      push({
        id: event.id, seq: event.seq, turn, request: activeRequest, kind: "context", label: "CONTEXT",
        text: clipped(compactText(data.content) || "Runtime context"),
        detail: detailJson(data), startedAt, durationMs: null,
      });
      continue;
    }

    if (event.type === "agent/error" || event.type === "agent/aborted") {
      push({
        id: event.id, seq: event.seq, turn, request: activeRequest, kind: "error", label: "ERROR",
        text: clipped(compactText(data.message ?? data.error) || eventLabel(event.type)),
        detail: detailJson(data), startedAt, durationMs: null,
      });
      continue;
    }

    push({
      id: event.id, seq: event.seq, turn, request: activeRequest, kind: "context", label: "CONTEXT",
      text: clipped(`${eventLabel(event.type)}${Object.keys(data).length ? ` ${compactText(data)}` : ""}`),
      detail: detailJson(data), startedAt, durationMs: duration(data),
    });
  }

  return records.map((record, index) => ({ ...record, index: index + 1 }));
}

function laneFor(kind: TrajectoryKind): "input" | "model" | "tools" {
  if (kind === "assistant" || kind === "error") return "model";
  if (kind === "tool") return "tools";
  return "input";
}

function timelineGeometry(records: readonly TrajectoryRecord[], actualDuration: boolean) {
  const weights = records.map((record) => actualDuration
    ? Math.max(80, record.durationMs ?? 240)
    : 1);
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = 0;
  return records.map((record, index) => {
    const left = cursor / total;
    const width = weights[index] / total;
    cursor += weights[index];
    return { record, left, width };
  });
}

function recordMatches(record: TrajectoryRecord, query: string): boolean {
  if (!query) return true;
  const haystack = `${record.label} ${record.text} ${record.detail}`.toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
}

export function Trajectory({ events }: { events: readonly DurableEvent[] }) {
  const records = useMemo(() => buildTrajectoryRecords(events), [events]);
  const [actualDuration, setActualDuration] = useState(false);
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set());
  const [callsCollapsed, setCallsCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const dragStart = useRef<number | null>(null);
  const turns = useMemo(() => [...new Set(records.map((record) => record.turn).filter(Boolean))], [records]);
  const geometry = useMemo(() => timelineGeometry(records, actualDuration), [records, actualDuration]);
  const allTurnsCollapsed = turns.length > 0 && turns.every((turn) => collapsedTurns.has(turn));

  const toggleAllTurns = () => setCollapsedTurns(allTurnsCollapsed ? new Set() : new Set(turns));
  const toggleTurn = (turn: number) => setCollapsedTurns((current) => {
    const next = new Set(current);
    if (next.has(turn)) next.delete(turn); else next.add(turn);
    return next;
  });
  const inRange = (index: number) => {
    if (!range || records.length < 2) return true;
    const position = index / (records.length - 1);
    return position >= range.start && position <= range.end;
  };
  const visibleRecords = records.filter((record) => {
    if (callsCollapsed && record.kind === "tool") return false;
    if (record.turn > 0 && collapsedTurns.has(record.turn) && record.kind !== "user") return false;
    return true;
  });
  const fraction = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragStart.current = fraction(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setRange({ start: dragStart.current, end: dragStart.current });
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragStart.current === null) return;
    const current = fraction(event);
    setRange({ start: Math.min(dragStart.current, current), end: Math.max(dragStart.current, current) });
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (dragStart.current === null) return;
    const current = fraction(event);
    if (Math.abs(current - dragStart.current) < .008 && records.length) {
      const target = records[Math.min(records.length - 1, Math.round(current * (records.length - 1)))];
      document.getElementById(`trajectory-${target.id}`)?.scrollIntoView({ block: "center" });
      setSelected(target.id);
      setRange(null);
    }
    dragStart.current = null;
  };

  return <div className="trajectory-view">
    <div className="trajectory-toolbar" role="toolbar" aria-label="轨迹工具栏">
      <div className="trajectory-toolbar-actions">
        <button type="button" aria-label={actualDuration ? "Use equal width" : "Use actual duration"}
          aria-pressed={actualDuration} onClick={() => setActualDuration((value) => !value)}>
          <Icon name="clock" />Duration
        </button>
        <button type="button" aria-label={allTurnsCollapsed ? "Expand turns" : "Collapse turns"}
          aria-pressed={allTurnsCollapsed} onClick={toggleAllTurns}>
          <Icon name={allTurnsCollapsed ? "squarePlus" : "squareMinus"} />Turns
        </button>
        <button type="button" aria-label={callsCollapsed ? "Expand calls" : "Collapse calls"}
          aria-pressed={callsCollapsed} onClick={() => setCallsCollapsed((value) => !value)}>
          <Icon name={callsCollapsed ? "squarePlus" : "squareMinus"} />Calls
        </button>
      </div>
      <label className="trajectory-search"><Icon name="search" />
        <input type="search" aria-label="搜索轨迹" placeholder="搜索" value={query}
          onChange={(event) => setQuery(event.currentTarget.value)} />
      </label>
    </div>

    <div className="trajectory-overview" aria-label="Trajectory timeline">
      <div className="trajectory-lane-labels"><span>Input</span><span>Model</span><span>Tools</span></div>
      <div className="trajectory-lanes" role="slider" aria-label="Timeline overview; drag horizontally to focus events"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={range ? Math.round(range.end * 100) : 100}
        tabIndex={0} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        {geometry.map(({ record, left, width }) => <button type="button" key={record.id}
          className={`trajectory-span lane-${laneFor(record.kind)} kind-${record.kind}`}
          style={{ left: `${left * 100}%`, width: `${width * 100}%` }}
          data-match={recordMatches(record, query) || undefined}
          aria-label={`${record.label}: ${record.text}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            document.getElementById(`trajectory-${record.id}`)?.scrollIntoView({ block: "center" });
            setSelected(record.id);
          }} />)}
        {range && <span className="trajectory-range" style={{ left: `${range.start * 100}%`, width: `${Math.max(.2, (range.end - range.start) * 100)}%` }} />}
      </div>
    </div>

    <div className="trajectory-table-pane">
      {visibleRecords.length ? <table className="trajectory-table">
        <colgroup><col className="trajectory-event-column" /><col /></colgroup>
        <tbody>{visibleRecords.map((record, visibleIndex) => {
          const firstInTurn = record.turn > 0 && visibleRecords.findIndex((item) => item.turn === record.turn) === visibleIndex;
          const isSelected = selected === record.id;
          const dimmed = !recordMatches(record, query) || !inRange(record.index - 1);
          return <Fragment key={record.id}>
            <tr id={`trajectory-${record.id}`} className={isSelected ? "selected" : ""}
              data-turn-start={firstInTurn || undefined} data-dimmed={dimmed || undefined}
              onClick={() => setSelected((current) => current === record.id ? null : record.id)}>
              <td className="trajectory-event-cell">
                {firstInTurn && <button type="button" className="trajectory-turn"
                  aria-label={`${collapsedTurns.has(record.turn) ? "Expand" : "Collapse"} turn ${record.turn}`}
                  onClick={(event) => { event.stopPropagation(); toggleTurn(record.turn); }}>Turn {record.turn}</button>}
                {record.request && record.kind === "assistant" && <span className="trajectory-request-dot" title={`Request #${record.request}`} />}
                <span className={`trajectory-tag kind-${record.kind}`}>{record.label}</span>
              </td>
              <td className="trajectory-content" title={record.text}>{record.text}</td>
            </tr>
            {isSelected && <tr className="trajectory-detail-row"><td colSpan={2}><pre>{record.detail}</pre></td></tr>}
          </Fragment>;
        })}</tbody>
      </table> : <div className="trajectory-empty">暂无轨迹记录</div>}
    </div>
  </div>;
}
