import assert from "node:assert/strict";
import test from "node:test";
import { applyHostEvent, fromSnapshot } from "./projection";
import { fixtureSnapshot } from "./timeline-fixture-data";
import { buildTimeline } from "./timeline-model";
import type { DurableEvent, HostEvent } from "./types";

function envelope(event: DurableEvent): HostEvent {
  return { hostSeq: event.seq, type: "event", version: 1, durable: true,
    event_id: event.id, seq: event.seq, at: event.at, event: event.type, data: event.data };
}

test("snapshot IDs are unique and ordered; event indexes remain immutable across branches", () => {
  const snapshot = fixtureSnapshot(1);
  const first = snapshot.events[0];
  const initial = fromSnapshot({ ...snapshot, events: [snapshot.events[3], first, first] });
  assert.deepEqual(initial.events.map((event) => event.id), [first.id, snapshot.events[3].id]);
  const a = { ...first, id: "branch-a", seq: 20 };
  const b = { ...first, id: "branch-b", seq: 21 };
  const next = applyHostEvent(initial, envelope(a));
  assert.equal(initial.eventIds.has(a.id), false);
  assert.equal(next.eventIds.has(a.id), true);
  assert.equal(applyHostEvent(next, envelope(a)), next);
  const other = applyHostEvent(initial, envelope(b));
  assert.equal(other.eventIds.has(a.id), false);
  assert.equal(other.eventIds.has(b.id), true);
  assert.equal(next.events.length, initial.events.length + 1);
});

test("ordered append and late insert keep stable sequence order without sorting existing history", () => {
  const snapshot = fixtureSnapshot(2);
  const initial = fromSnapshot(snapshot);
  const originalSort = Array.prototype.sort;
  let late = initial;
  Array.prototype.sort = () => { throw new Error("full sort forbidden"); };
  initial.events.some = () => { throw new Error("linear duplicate lookup forbidden"); };
  try {
    const last = initial.events.at(-1)!;
    const appended = applyHostEvent(initial, envelope({ ...last, id: "append", seq: last.seq + 1 }));
    late = applyHostEvent(appended, envelope({ ...last, id: "late", seq: 2 }));
  } finally {
    Array.prototype.sort = originalSort;
    Reflect.deleteProperty(initial.events, "some");
  }
  assert.deepEqual(late.events.slice(0, 4).map((event) => event.seq), [1, 2, 2, 3]);
  assert.equal(late.events[2].id, "late");
  assert.equal(applyHostEvent(late, envelope(late.events[2])), late);
  assert.deepEqual(late.timeline, buildTimeline(late.events));
});

test("incremental timeline matches a snapshot for tool results, multiple steps and clearing", () => {
  const snapshot = fixtureSnapshot(8);
  let projection = fromSnapshot({ ...snapshot, events: [] });
  for (const event of snapshot.events) projection = applyHostEvent(projection, envelope(event));
  assert.deepEqual(projection.timeline, fromSnapshot(snapshot).timeline);
  assert.deepEqual(projection.summary, { turns: 8, steps: 8, calls: 16, durationMs: 192 });
  const firstBatch = projection.timeline.rows.find((row) => row.kind === "tools");
  assert.equal(firstBatch?.kind === "tools" && firstBatch.batch.calls.length, 2);
  const clear = { ...snapshot.events[0], id: "clear", seq: 100, type: "session/clear", data: {} };
  projection = applyHostEvent(projection, envelope(clear));
  assert.equal(projection.timeline.rows.length, 0);
  assert.equal(projection.timeline.results.size, 0);
  const visible = { ...snapshot.events[0], id: "after-clear", seq: 101 };
  projection = applyHostEvent(projection, envelope(visible));
  assert.deepEqual(projection.timeline.rows.map((row) => row.id), ["after-clear"]);
});

test("partial updates reuse event, timeline and summary projections", () => {
  const initial = fromSnapshot(fixtureSnapshot(2));
  const next = applyHostEvent(initial, { hostSeq: 1, version: 1, type: "event", event: "agent/state",
    data: { phase: "model", "partial-assistant": "new token" } });
  assert.equal(next.timeline, initial.timeline);
  assert.equal(next.events, initial.events);
  assert.equal(next.summary, initial.summary);
});

test("screenshot outputs survive both snapshot reload and streamed tool results", () => {
  const snapshot = fixtureSnapshot(1);
  const images = [{ type: "image", url: "data:image/png;base64,AAAA", detail: "auto" }];
  const result: DurableEvent = { id: "screen-result", seq: 99, at: "2026-10-03T00:00:00Z",
    type: "tool/result", data: { "call-id": "screen", content: "Screenshot captured", images } };
  const restored = fromSnapshot({ ...snapshot, events: [...snapshot.events, result] });
  const streamed = applyHostEvent(fromSnapshot(snapshot), envelope(result));
  assert.deepEqual(restored.timeline.results.get("screen")?.data.images, images);
  assert.deepEqual(streamed.timeline.results.get("screen")?.data.images, images);
  assert.equal(streamed.timeline.results.get("screen")?.data.content, "Screenshot captured");
});

test("snapshot revision watermarks reject late state and interaction notifications", () => {
  const snapshot = fixtureSnapshot(1);
  let projection = fromSnapshot({ ...snapshot, state: { phase: "idle", revision: 10 }, interactions_revision: 20 });
  const transient = (event: string, data: Record<string, unknown>): HostEvent => ({ hostSeq: 1, version: 1, type: "event", event, data });
  assert.equal(applyHostEvent(projection, transient("agent/state", { phase: "model", revision: 9 })), projection);
  assert.equal(applyHostEvent(projection, transient("interaction/request", { id: "stale", revision: 20 })), projection);
  projection = applyHostEvent(projection, transient("agent/state", { phase: "tool", revision: 12 }));
  assert.equal(applyHostEvent(projection, transient("agent/state", { phase: "model", revision: 11 })), projection);
  projection = applyHostEvent(projection, transient("interaction/resolved", { id: "resolved", revision: 22 }));
  projection = applyHostEvent(projection, transient("interaction/request", { id: "other", revision: 21 }));
  assert.deepEqual(projection.interactions.map((entry) => entry.id), ["other"]);
  assert.equal(applyHostEvent(projection, transient("interaction/request", { id: "resolved", revision: 21 })), projection);
});
