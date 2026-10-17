import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyHostEvent, fromSnapshot } from "./projection";
import { Timeline } from "./Timeline";
import { fixtureSnapshot } from "./timeline-fixture-data";
import type { Projection } from "./projection";
import type { RunOutcome } from "./types";
const render = (p: Projection) => renderToStaticMarkup(createElement(Timeline, { projection: p, scrollRef: createRef<HTMLDivElement>() }));
const raw = (status: RunOutcome["status"], seq = 2) => ({ id: `end-${status}`, seq, at: "2026-10-15T14:26:19Z", type: "agent/run/end",
  data: { "run-id": `run-${status}`, status, reason: status === "uncertain" ? "restored" : status, verification: "not-run",
          ...(status === "failed" ? { error: "offline provider failure" } : {}) } });
const live = (event: any, durable = false) => ({ hostSeq: event.seq, version: 1, type: "event" as const,
  event: durable ? event.type : "agent.run/end", data: event.data,
  ...(durable ? { durable: true, seq: event.seq, event_id: event.id } : {}) });

for (const [status, label] of [["completed", "运行完成"], ["failed", "运行失败"], ["cancelled", "运行已取消"], ["uncertain", "结果未确认"]] as const) {
  test(`${status} is visible once after snapshot, live notification, durable replay and refresh`, () => {
    const end = raw(status);
    const error = { ...end, id: "old-error", seq: 1, type: "agent/error", data: { "run-id": end.data["run-id"], message: "offline provider failure" } };
    const events = status === "failed" ? [error, end] : [end];
    const base = { ...fixtureSnapshot(0), events: [] };
    const restored = fromSnapshot({ ...base, events });
    assert.equal(restored.timeline.rows.length, 1);
    assert.equal(restored.timeline.rows[0].kind, "outcome");
    assert.match(render(restored), new RegExp(label));
    assert.match(render(restored), /尚未验收/);
    if (status === "uncertain") assert.match(render(restored), /需要核对/);
    let streamed = applyHostEvent(fromSnapshot(base), live(end));
    streamed = applyHostEvent(streamed, live(end, true));
    streamed = applyHostEvent(streamed, live(end));
    assert.equal(streamed.timeline.rows.length, 1);
    assert.equal((streamed.state as any)["last-outcome"]?.status, status);
    assert.match(render(streamed), new RegExp(label));
    const refreshed = fromSnapshot({ ...base, events, state: { phase: "idle", "last-outcome": end.data } });
    assert.equal(refreshed.timeline.rows.length, 1);
    assert.match(render(refreshed), new RegExp(label));
  });
}

test("last-outcome is retained in a coherent snapshot without a duplicate durable row", () => {
  const snapshot = { ...fixtureSnapshot(0), events: [], state: { phase: "idle", "last-outcome": raw("uncertain").data } };
  assert.match(render(fromSnapshot(snapshot)), /结果未确认.*需要核对/);
});

test("a completed execution with failed verification cannot look accepted", () => {
  const end = raw("completed");
  end.data.verification = "failed";
  const p = fromSnapshot({ ...fixtureSnapshot(0), events: [end] });
  assert.match(render(p), /验收失败/);
  assert.doesNotMatch(render(p), /验收通过/);
});

test("late conflicting outcomes cannot downgrade a known uncertain result", () => {
  const end = raw("uncertain");
  let p = applyHostEvent(fromSnapshot({ ...fixtureSnapshot(0), events: [] }), live(end));
  p = applyHostEvent(p, live({ ...end, data: { ...end.data, status: "completed" } }));
  assert.equal(p.state["last-outcome"]?.status, "uncertain");
  assert.match(render(p), /结果未确认/);
  const late = { ...end, id: "older-message", seq: 1, type: "message", data: { message: { role: "user", content: "earlier" } } };
  p = applyHostEvent(p, live(end, true));
  p = applyHostEvent(p, live(late, true));
  assert.equal(p.timeline.rows.filter(row => row.kind === "outcome").length, 1);
  assert.match(render(p), /结果未确认/);
});

test("refreshing a cleared conversation cannot resurrect the old outcome", () => {
  const end = raw("completed");
  const clear = { ...end, id: "clear", seq: 3, type: "session/clear", data: {} };
  const p = fromSnapshot({ ...fixtureSnapshot(0), events: [end, clear], state: { phase: "idle", "last-outcome": end.data } });
  assert.equal(p.timeline.rows.length, 0);
  assert.doesNotMatch(render(p), /运行完成/);
});
