import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildTimeline } from "./timeline-model";
import { displayTranscript, transcriptView } from "./transcript-display";
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

test("interleaved user input and active turns keep every step in original order", () => {
  const interrupted=model(true);
  assert.deepEqual(displayTranscript(interrupted,"compact",new Map()).rows,interrupted.rows);
  const active=buildTimeline(events([["message",user],["tool/call",tool]]));
  assert.deepEqual(displayTranscript(active,"standard",new Map()).rows,active.rows);
  assert.deepEqual(displayTranscript(model(),"verbose",new Map()).rows,model().rows);
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
