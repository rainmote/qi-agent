import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildTimeline } from "./timeline-model";
import { collapseTiming, displayTranscript, transcriptView } from "./transcript-display";
import { SubagentPanel } from "./SubagentPanel";
import type { DurableEvent } from "./types";

const events = (values: Array<[string, Record<string, unknown>]>): DurableEvent[] => values.map(([type,data],index) => ({
  id: `e${index}`, type, data, seq:index+1, at:"2026-10-19T00:00:00Z",
}));
const user = {message:{role:"user",content:"检查文件"}};
const tool = {"call-id":"read-1",name:"read",arguments:{path:"README.md"}};
const answer = {message:{role:"assistant",content:"检查完成",reasoning_content:"先阅读，再总结"}};
const outcome = {"run-id":"r1",status:"completed",verification:"not-run"};
const model = (interrupted=false) => buildTimeline(events([
  ["message",user], ["tool/call",tool],
  ...(interrupted ? [["message",user] as [string,Record<string,unknown>]] : []),
  ["tool/result",{"call-id":"read-1",ok:false,error:"读取失败"}],
  ["approval/decision",{decision:"deny",tool:"write"}],
  ["message",answer], ["agent/run/end",outcome],
]));

test("settled turns fold process while retaining final answer, decisions and unverified outcome", () => {
  const view = displayTranscript(model(),"standard",new Map());
  assert.deepEqual(view.rows.map(row => row.kind),["message","turn-control","decision","message","outcome"]);
  assert.match(view.rows.find(row => row.kind === "turn-control")!.label,/1 失败/);
  assert.equal(view.hiddenReasoning.size,1);
  const header=view.rows.find(row => row.kind === "turn-control")!;
  const open=displayTranscript(model(),"standard",new Map([[header.id,true]]));
  assert.equal(open.rows.filter(row => row.kind === "tools").length,1);
  assert.equal(open.hiddenReasoning.size,0);
  const focused = displayTranscript(model(),"standard",new Map(), "e1");
  assert.equal(focused.rows.filter(row => row.kind === "tools").length,1,"completion cannot hide a focused tool control");
});

test("standard interleaved user input and active turns keep every step in original order", () => {
  const interrupted=model(true);
  assert.deepEqual(displayTranscript(interrupted,"standard",new Map()).rows,interrupted.rows);
  const active=buildTimeline(events([["message",user],["tool/call",tool]]));
  assert.deepEqual(displayTranscript(active,"standard",new Map()).rows,active.rows);
  assert.deepEqual(displayTranscript(model(),"verbose",new Map()).rows,model().rows);
});

test("next-input folding retains the latest process, respects manual choices and folds on a later user message", () => {
  const current = model();
  const latest = displayTranscript(current,"standard",new Map(),null,"next-input");
  const control = latest.rows.find(row => row.kind === "turn-control")!;
  assert.equal(control.open,true);
  assert.equal(latest.rows.filter(row => row.kind === "tools").length,1);
  assert.equal(displayTranscript(current,"standard",new Map([[control.id,false]]),null,"next-input")
    .rows.find(row => row.kind === "turn-control")!.open,false);
  const later = buildTimeline([...events([
    ["message",user],["tool/call",tool],["tool/result",{"call-id":"read-1",ok:true,content:"read"}],
    ["message",answer],["agent/run/end",outcome],
  ]),{id:"next-user",seq:100,at:"2026-10-19T00:01:00Z",type:"message",data:user}]);
  const history = displayTranscript(later,"standard",new Map(),null,"next-input");
  assert.equal(history.rows.find(row => row.kind === "turn-control")!.open,false);
  assert.equal(history.rows.at(-1)?.id,"next-user");
  assert.equal(collapseTiming("next-input"),"next-input");
  assert.equal(collapseTiming("unknown"),"completion");
});

test("failed, cancelled and uncertain turns retain their process without a whole-turn fold", () => {
  for (const status of ["failed", "cancelled", "uncertain"]) {
    const stopped=buildTimeline(events([["message",user],["message",answer], ["tool/call",tool],
      ["agent/run/end",{...outcome,status}]]));
    const result=displayTranscript(stopped,"standard",new Map());
    assert.deepEqual(result.rows,stopped.rows);
    assert.equal(result.hiddenReasoning.size,0);
  }
});

test("display preferences fail back to standard and subtask results remain disclosure content", () => {
  assert.equal(transcriptView("verbose"),"verbose");
  assert.equal(transcriptView("unknown"),"standard");
  const html=renderToStaticMarkup(<SubagentPanel jobs={[{id:"a",label:"只读复核",provider:"offline",status:"completed",result:"没有发现阻断问题"}]} />);
  assert.match(html,/<details/);
  assert.doesNotMatch(html,/<details[^>]+open=/);
  assert.match(html,/已完成 · 尚未验收/);
  assert.match(html,/没有发现阻断问题/);
});


test("compact groups consecutive steps and resolved approvals without duplicate placeholders", () => {
  const values: Array<[string, Record<string, unknown>]> = [["message", user]];
  for (let i = 0; i < 9; i++) values.push(
    ["message", {message:{role:"assistant",tool_calls:[{id:`c${i}`} ]}}],
    ["tool/call", {...tool,"call-id":`c${i}`}],
    ["approval/decision", {decision:"allow",tool:"read"}],
    ["tool/result", {"call-id":`c${i}`,ok:true}], ["step/end", {}]);
  const live = buildTimeline(events(values));
  const compact = displayTranscript(live,"compact",new Map());
  assert.deepEqual(compact.rows.map(row=>row.kind),["message","step-control"]);
  const group = compact.rows.find(row=>row.kind === "step-control")!;
  assert.equal(group.batch.calls.length,9);
  assert.equal(displayTranscript(live,"compact",new Map(),group.id).rows.find(row=>row.kind === "step-control")!.open,false,
    "focusing the header cannot expand it before its first click");
  const expanded = displayTranscript(live,"compact",new Map([[group.id,true]]));
  assert.equal(expanded.rows.filter(row=>row.kind === "tools").length,9);
  assert.equal(expanded.rows.filter(row=>row.kind === "decision").length,9);
  assert.equal(expanded.rows.filter(row=>row.kind === "message").length,1);
  const settled = buildTimeline(events([...values,["message",answer],["agent/run/end",outcome]]));
  const folded = displayTranscript(settled,"compact",new Map());
  assert.deepEqual(folded.rows.map(row=>row.kind),["message","turn-control","message"]);
  assert.match(folded.rows.find(row=>row.kind === "turn-control")!.caption,/尚未验收/);
  const focused = displayTranscript(settled,"compact",new Map(),group.id);
  assert.equal(focused.rows.find(row=>row.kind === "turn-control")!.open,true);
  assert.equal(focused.rows.find(row=>row.kind === "step-control")!.open,false);
});

test("compact retains narration, user input, refusals and abnormal outcomes outside step groups", () => {
  for (const status of ["failed","cancelled","uncertain"]) {
    const original = model(true);
    const end = original.rows.find(row=>row.kind === "outcome")!;
    assert.equal(end.kind,"outcome");
    if (end.kind !== "outcome") throw new Error("Outcome missing");
    const stopped = {...original,rows:original.rows.map(row=>row === end ? {...end,event:{...end.event,data:{...end.event.data,status}}} : row)};
    const compact = displayTranscript(stopped,"compact",new Map());
    assert(!compact.rows.some(row=>row.kind === "turn-control"));
    assert(compact.rows.some(row=>row.kind === "step-control"));
    assert(compact.rows.some(row=>row.kind === "decision" && row.event.data.decision === "deny"));
    assert(compact.rows.some(row=>row.kind === "outcome" && row.event.data.status === status));
    assert.deepEqual(compact.rows.filter(row=>row.kind === "message").map(row=>row.id),original.rows.filter(row=>row.kind === "message").map(row=>row.id));
  }
});

test("compact splits mixed reasoning from narration without mutating durable events", () => {
  const original = events([["message",user],["tool/call",tool],["step/end",{}],["message",answer]]);
  const before = JSON.stringify(original), timeline = buildTimeline(original);
  const compact = displayTranscript(timeline,"compact",new Map());
  assert.deepEqual(compact.rows.map(row=>row.kind),["message","step-control","message"]);
  const group = compact.rows.find(row=>row.kind === "step-control")!;
  assert.equal(group.reasoningCount,1);
  const expanded = displayTranscript(timeline,"compact",new Map([[group.id,true]]));
  const messages = expanded.rows.flatMap(row=>row.kind === "message" ? [row.event.data.message as Record<string,unknown>] : []);
  assert.equal(messages.filter(message=>message.content).length,2);
  const reasoning = messages.filter(message=>message.reasoning_content);
  assert.equal(reasoning.length,1);
  assert.equal(reasoning[0].content,undefined);
  assert.equal(JSON.stringify(original),before);
});
