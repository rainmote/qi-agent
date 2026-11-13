import assert from "node:assert/strict";
import test from "node:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Timeline } from "./Timeline";
import { fromSnapshot, applyHostEvent } from "./projection";
import { fixtureSnapshot } from "./timeline-fixture-data";
import { continuableRun, isContinuationRequest } from "./run-continuation";
import type { DurableEvent } from "./types";

const event = (id: string, type: string, data: Record<string, unknown>): DurableEvent => ({id,type,data,seq:Number(id),at:"2026-11-13T08:00:00Z"});
const failure = event("2","agent/run/end",{"run-id":"r",status:"failed",reason:"provider-error"});
const project = (events: DurableEvent[]) => fromSnapshot({...fixtureSnapshot(0),events,state:{phase:"idle"}});

test("continuation only targets the latest known model failure and is a journaled submit option", () => {
  assert.equal(continuableRun(project([failure])),"r");
  for(const status of ["uncertain","completed","cancelled"]) {
    assert.equal(continuableRun(project([{...failure,data:{...failure.data,status}}])),null);
  }
  for(const reason of ["restored","tool-terminated","step-budget","no-progress","provider-refusal"]) {
    assert.equal(continuableRun(project([{...failure,data:{...failure.data,reason}}])),null);
  }
  assert.equal(continuableRun(project([failure,event("3","message",{message:{role:"user",content:"new task"}})])),null);
  const active=project([failure,event("3","agent/run/start",{"run-id":"new"})]);
  assert.equal(continuableRun(active),null);
  assert(isContinuationRequest({options:{"continuation-of":"r"}}));
  assert(!isContinuationRequest({message:"user draft"}));
});

test("initial instructions and continuation receipts survive replay and clear without becoming user messages", () => {
  const events=[event("1","context/snapshot",{content:"Workspace rules\nSkills catalog"}),failure,
    event("3","agent/continuation",{"previous-run-id":"r","run-id":"next"})];
  let live=project([]);
  for(const e of events) live=applyHostEvent(live,{hostSeq:e.seq,version:1,type:"event",durable:true,seq:e.seq,event_id:e.id,event:e.type,data:e.data,at:e.at});
  assert.deepEqual(live.timeline,project(events).timeline);
  for(const view of ["compact","standard","detailed","verbose"] as const) {
    const html=renderToStaticMarkup(<Timeline projection={live} scrollRef={createRef()} view={view} />);
    assert.match(html,/本轮指令/);
    assert.match(html,/已请求继续生成/);
    assert.doesNotMatch(html,/Workspace rules|message-user/,'large context stays lazy until expanded');
  }
  const cleared=project([...events,event("4","session/clear",{})]);
  assert.equal(cleared.timeline.rows.length,0);
});
