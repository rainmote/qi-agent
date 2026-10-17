import { appendTimeline, buildTimeline, type TimelineModel } from "./timeline-model";
import type { AgentState, DurableEvent, HostEvent, Interaction, SessionSnapshot } from "./types";

// Sharding keeps immutable updates from copying a full session-sized Set on each event.
const INDEX_BUCKETS = 128;
function bucketFor(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) % INDEX_BUCKETS;
}
export class EventIdIndex {
  private constructor(private readonly buckets: readonly ReadonlySet<string>[]) {}
  static from(events: readonly DurableEvent[]): EventIdIndex {
    const buckets = Array.from({ length: INDEX_BUCKETS }, () => new Set<string>());
    for (const event of events) buckets[bucketFor(event.id)].add(event.id);
    return new EventIdIndex(buckets);
  }
  has(id: string): boolean { return this.buckets[bucketFor(id)].has(id); }
  add(id: string): EventIdIndex {
    const slot = bucketFor(id);
    const buckets = [...this.buckets];
    buckets[slot] = new Set(buckets[slot]).add(id);
    return new EventIdIndex(buckets);
  }
}

export interface RunSummary { turns: number; steps: number; calls: number; durationMs: number }
function addSummary(summary: RunSummary, event: DurableEvent): RunSummary {
  const next = { ...summary };
  if (event.type === "message" && (event.data.message as { role?: string } | undefined)?.role === "user") next.turns++;
  if (event.type === "step/start") next.steps++;
  if (event.type === "tool/call") next.calls++;
  if (event.type === "tool/result") {
    const duration = event.data["duration-ms"] ?? event.data.duration_ms;
    if (typeof duration === "number" && Number.isFinite(duration)) next.durationMs += duration;
  }
  return next;
}

export interface Projection {
  events: DurableEvent[];
  eventIds: EventIdIndex;
  timeline: TimelineModel;
  summary: RunSummary;
  state: AgentState;
  interactions: Interaction[];
  liveTools: Record<string, Record<string, unknown>>;
  lastRunError: string | null;
  stateRevision: number | null;
  snapshotInteractionRevision: number | null;
  interactionRevisions: ReadonlyMap<string, number>;
}

function revision(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function fromSnapshot(snapshot: SessionSnapshot): Projection {
  const seen = new Set<string>();
  const events = snapshot.events.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  }).sort((a, b) => a.seq - b.seq);
  return {
    events,
    eventIds: EventIdIndex.from(events),
    timeline: buildTimeline(events),
    summary: events.reduce(addSummary, { turns: 0, steps: 0, calls: 0, durationMs: 0 }),
    state: snapshot.state,
    interactions: snapshot.interactions || [],
    liveTools: {},
    lastRunError: null,
    stateRevision: revision(snapshot.state.revision),
    snapshotInteractionRevision: revision(snapshot.interactions_revision),
    interactionRevisions: new Map(),
  };
}

export function applyHostEvent(projection: Projection, envelope: HostEvent): Projection {
  if (envelope.durable && envelope.event_id && typeof envelope.seq === "number" && Number.isFinite(envelope.seq)) {
    if (projection.eventIds.has(envelope.event_id)) return projection;
    const event: DurableEvent = {
      id: envelope.event_id,
      seq: envelope.seq,
      at: envelope.at || new Date().toISOString(),
      type: envelope.event || "unknown",
      data: envelope.data || {},
    };
    const events = [...projection.events];
    const appending = !events.length || events[events.length - 1].seq <= event.seq;
    if (appending) events.push(event);
    else {
      // Insert after existing equal sequence values, preserving snapshot sort stability.
      let low = 0;
      let high = events.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (events[middle].seq <= event.seq) low = middle + 1;
        else high = middle;
      }
      events.splice(low, 0, event);
    }
    return { ...projection, events, eventIds: projection.eventIds.add(event.id),
      timeline: appending ? appendTimeline(projection.timeline, event) : buildTimeline(events),
      summary: addSummary(projection.summary, event) };
  }
  if (envelope.event === "agent/state") {
    const incomingRevision = revision(envelope.data?.revision);
    if (incomingRevision !== null && projection.stateRevision !== null && incomingRevision <= projection.stateRevision) return projection;
    return { ...projection, state: { phase: "idle", ...envelope.data } as unknown as AgentState,
      stateRevision: incomingRevision ?? projection.stateRevision };
  }
  if (envelope.event === "interaction/request" || envelope.event === "interaction/resolved") {
    const incomingRevision = revision(envelope.data?.revision);
    const id = String(envelope.data?.id || "");
    const knownRevision = projection.interactionRevisions.get(id) ?? projection.snapshotInteractionRevision;
    if (incomingRevision !== null && knownRevision !== null && incomingRevision <= knownRevision) return projection;
    if (incomingRevision !== null) projection = { ...projection,
      interactionRevisions: new Map(projection.interactionRevisions).set(id, incomingRevision) };
  }
  if (envelope.event === "interaction/request") {
    const interaction = envelope.data as unknown as Interaction;
    return projection.interactions.some((entry) => entry.id === interaction.id)
      ? projection
      : { ...projection, interactions: [...projection.interactions, interaction] };
  }
  if (envelope.event === "interaction/resolved") {
    return {
      ...projection,
      interactions: projection.interactions.filter((entry) => entry.id !== envelope.data?.id),
    };
  }
  if (envelope.event === "tool.execution/update") {
    const callId = String(envelope.data?.["call-id"] || envelope.data?.call_id || "");
    return callId ? {
      ...projection,
      liveTools: { ...projection.liveTools, [callId]: envelope.data || {} },
    } : projection;
  }
  if (envelope.event === "remote/run-result" && envelope.data?.ok === false) {
    const error = envelope.data.error as { message?: string } | undefined;
    return { ...projection, lastRunError: error?.message || "Agent run failed" };
  }
  return projection;
}

export function visibleEvents(events: DurableEvent[]): DurableEvent[] {
  let start = 0;
  events.forEach((event, index) => {
    if (event.type === "session/clear") start = index + 1;
  });
  return events.slice(start).filter((event) => !event.type.startsWith("session/"));
}
