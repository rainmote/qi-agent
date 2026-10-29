import assert from "node:assert/strict";
import test from "node:test";
import { applyHostEvent, fromSnapshot } from "./projection";
import { fixtureSnapshot } from "./timeline-fixture-data";
import { displayTranscript } from "./transcript-display";
import { outcomeText, runOutcome } from "./run-outcome";
import type { DurableEvent, HostEvent } from "./types";

const event = (id: string, seq: number, type: string, data: Record<string, unknown>): DurableEvent =>
  ({ id, seq, type, data, at: "2026-10-29T06:00:00Z" });
const end = event("end", 5, "agent/run/end", { "run-id": "r1", status: "completed", verification: "not-run" });
const prefix = [event("user", 1, "message", { message: { role: "user", content: "检查文件" } }),
  event("call", 2, "tool/call", { "call-id": "read1", name: "read", arguments: { path: "hello.txt" } }),
  event("result", 3, "tool/result", { "call-id": "read1", ok: true }),
  event("answer", 4, "message", { message: { role: "assistant", content: "已检查" } })];
const correction = (key = "host-arbitrated") => event("host-correction", 6, "agent/run/end",
  { "run-id": "r1", status: "uncertain", reason: "hard-wall-timeout", verification: "not-run", [key]: true });
const live = (e: DurableEvent, durable = true): HostEvent => ({ hostSeq: e.seq, version: 1, type: "event",
  event: durable ? e.type : "agent.run/end", data: e.data,
  ...(durable ? { durable: true, seq: e.seq, event_id: e.id, at: e.at } : {}) });
const snapshot = (events: DurableEvent[]) => ({ ...fixtureSnapshot(0), events });
const stateEvent = (data: Record<string, unknown>): HostEvent =>
  ({ hostSeq: 20, version: 1, type: "event", event: "agent/state", data });

for (const key of ["host-arbitrated", "host_arbitrated"]) {
  test(`${key} correction replaces completed in snapshots and keeps the process inspectable`, () => {
    const p = fromSnapshot({ ...snapshot([...prefix, end, correction(key)]), state: { phase: "idle", "last-outcome": runOutcome(end.data)! } });
    const rows = p.timeline.rows.filter(row => row.kind === "outcome");
    assert.equal(rows.length, 1);
    assert(rows[0].kind === "outcome");
    assert.equal(rows[0].event.data.status, "uncertain");
    assert.equal(p.state["last-outcome"]?.status, "uncertain");
    assert.equal(p.events.filter(e => e.type === "agent/run/end").length, 2, "retain both durable facts");
    assert.match(outcomeText(p.state["last-outcome"]!), /结果未确认.*需要核对/);
    assert.equal(displayTranscript(p.timeline, "compact", new Map()).rows.some(row => row.kind === "turn-control"), false);
  });
  test(`${key} correction survives live delivery, duplicate notifications, state and late history`, () => {
    let p = fromSnapshot(snapshot([...prefix, end]));
    p = applyHostEvent(p, live(correction(key), false));
    p = applyHostEvent(p, live(correction(key)));
    p = applyHostEvent(p, live(end, false));
    p = applyHostEvent(p, stateEvent({ phase: "idle", revision: 20, "last-outcome": runOutcome(end.data)! }));
    p = applyHostEvent(p, live(event("late", 2, "step/start", {})));
    assert.equal(p.timeline.rows.filter(row => row.kind === "outcome").length, 1);
    assert.equal(p.state["last-outcome"]?.status, "uncertain");
    const row = p.timeline.rows.find(row => row.kind === "outcome");
    assert(row?.kind === "outcome");
    assert.equal(row.event.data.status, "uncertain");
  });
}

test("a late durable host correction updates state without interrupting a different active run", () => {
  const later = event("later", 10, "step/start", {});
  let p = fromSnapshot(snapshot([...prefix, end, later]));
  p = applyHostEvent(p, live(correction()));
  assert.equal(p.state["last-outcome"]?.status, "uncertain");
  const active = fromSnapshot({ ...snapshot([...prefix, end, later]), state: { phase: "model", "run-id": "r2" } });
  const changed = applyHostEvent(active, live(correction()));
  assert.equal(changed.state["run-id"], "r2");
  assert.equal(changed.state.phase, "model");
  const row = changed.timeline.rows.find(row => row.kind === "outcome");
  assert(row?.kind === "outcome");
  assert.equal(row.event.data.status, "uncertain");
});

test("clear fences old state and terminal notifications while allowing a new run", () => {
  const clear = event("clear", 7, "session/clear", {});
  let p = fromSnapshot({ ...snapshot([...prefix, end, clear]), state: { phase: "idle", revision: 10, "last-outcome": runOutcome(end.data)! } });
  p = applyHostEvent(p, stateEvent({ phase: "model", "run-id": "r2", revision: 11, "last-outcome": runOutcome(end.data)! }));
  p = applyHostEvent(p, live(correction(), false));
  assert.equal(p.timeline.rows.length, 0, "cleared outcomes must not reappear");
  assert.equal(p.state["last-outcome"], undefined);
  const nextEnd = event("next-end", 9, "agent/run/end", { "run-id": "r2", status: "completed", verification: "not-run" });
  p = applyHostEvent(p, live(nextEnd));
  assert.equal(p.timeline.rows.length, 1);
  assert.equal(p.state["last-outcome"]?.["run-id"], "r2");
});

const old = { 'run-id':'old',status:'completed' as const,verification:'not-run' };
const fresh = { 'run-id':'fresh',status:'failed' as const,error:'fresh failure',verification:'not-run' };
const terminal=(id:string,seq:number,data:any)=>({id,seq,data,type:'agent/run/end',at:''});
const clear={id:'clear',seq:7,type:'session/clear',data:{},at:''};
test('historical correction cannot replace the latest completed run state',()=>{
 const p=fromSnapshot({...fixtureSnapshot(0),events:[terminal('old',5,old),terminal('fresh',10,fresh)],state:{phase:'idle','last-outcome':fresh}});
 const q=applyHostEvent(p,live(terminal('correction',6,{...old,status:'uncertain','host-arbitrated':true})));
 assert.equal(q.state['last-outcome']?.['run-id'],'fresh');assert.equal(q.state['last-outcome']?.error,'fresh failure');
});
test('clear also retires a state-only outcome without a durable terminal',()=>{
 const p=fromSnapshot({...fixtureSnapshot(0),events:[],state:{phase:'idle','last-outcome':old}});
 const q=applyHostEvent(p,live(clear));
 assert.equal(q.timeline.rows.length,0);assert.equal(q.state['last-outcome'],undefined);
 const r=applyHostEvent(q,{hostSeq:9,version:1,type:'event',event:'agent/state',data:{phase:'model','run-id':'fresh',revision:9,'last-outcome':old}});
 assert.equal(r.timeline.rows.length,0);
});
test('a clear snapshot rejects stale state-only outcomes but accepts post-clear runs',()=>{
 const p=fromSnapshot({...fixtureSnapshot(0),events:[clear],state:{phase:'idle','last-outcome':old}});
 assert.equal(p.timeline.rows.length,0);assert.equal(p.state['last-outcome'],undefined);
 const q=fromSnapshot({...fixtureSnapshot(0),events:[clear,terminal('fresh',10,fresh)],state:{phase:'idle','last-outcome':fresh}});
 assert.equal(q.timeline.rows.length,1);assert.equal(q.state['last-outcome']?.['run-id'],'fresh');
});

test('late clear retires state-only outcomes but keeps a proven post-clear run', () => {
  let p = fromSnapshot({ ...fixtureSnapshot(0), events: [], state: { phase: 'idle', 'last-outcome': old } });
  p = applyHostEvent(p, live({ id: 'later-step', seq: 9, type: 'step/start', data: {}, at: '' }));
  p = applyHostEvent(p, live(clear));
  assert.equal(p.timeline.rows.length, 0);
  p = applyHostEvent(p, live({ id: 'older-step', seq: 2, type: 'step/start', data: {}, at: '' }));
  p = applyHostEvent(p, { hostSeq: 11, version: 1, type: 'event', event: 'agent/state',
    data: { phase: 'model', 'run-id': 'fresh', revision: 11, 'last-outcome': old } });
  assert.equal(p.timeline.rows.length, 0);
  const freshOnly = fromSnapshot({ ...fixtureSnapshot(0), events: [terminal('fresh', 10, fresh)],
    state: { phase: 'idle', 'last-outcome': fresh } });
  const q = applyHostEvent(freshOnly, live(clear));
  assert.equal(q.timeline.rows.length, 1);
  assert.equal(q.state['last-outcome']?.['run-id'], 'fresh');
});
