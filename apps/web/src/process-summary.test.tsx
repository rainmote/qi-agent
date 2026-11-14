import assert from "node:assert/strict";
import test from "node:test";
import { processCategory, processDetail, processSummary, toolSummary } from "./process-summary";
import { buildTimeline } from "./timeline-model";
import { displayTranscript, foldedReplies, transcriptView } from "./transcript-display";
import type { DurableEvent } from "./types";
const call = (id: string, name: string): DurableEvent => ({id,seq:1,at:"2026-11-14T00:00:00Z",type:"tool/call",data:{"call-id":id,name}});
test("process summaries rank recorded calls, preserve tie order and deduplicate identities", () => {
  const calls=[call("b","bash"),call("r","read"),call("r","read"),call("s","read")];
  assert.equal(processSummary(calls).label,"读取文件 · 运行命令");
  assert.equal(processSummary(calls.slice(0,2)).label,"运行命令 · 读取文件");
  assert.equal(processCategory("terminal_inspect").label,"搜索");
  assert.equal(processCategory("functions.read").label,"调用工具");
  assert.equal(processCategory("Read").label,"调用工具");
  assert.equal(processSummary([],true).label,"注入上下文");
});
test("live task detail follows field priority and avoids dumping code or arbitrary JSON", () => {
  assert.equal(processDetail({command:"cat secret",description:" Inspect\n the inputs "}),"Inspect the inputs");
  assert.equal(processDetail({questions:[{question:""},{question:"Continue?"}]}),"Continue?");
  assert.equal(processDetail({queries:["one","two"]}),"one, two");
  assert.equal(processDetail({queries:["one",2],path:"notes.md"}),"notes.md");
  assert.equal(processDetail({code:"raw source",patch:"raw patch",metadata:{secret:"x"}}),"");
  const emoji="👩🏽‍💻";assert.equal(processDetail({title:emoji.repeat(170)}),emoji.repeat(159)+"…");
});
test("reply preferences preserve all narration by default and offer explicit final-only folding", () => {
  const data: Array<[string, Record<string, unknown>]> = [["message",{message:{role:"user",content:"Inspect"}}],
    ["tool/call",{"call-id":"r",name:"read"}],
    ["message",{message:{role:"assistant",content:"Inputs checked",reasoning_content:"Look at constraints"}}],
    ["tool/call",{"call-id":"b",name:"bash"}],
    ["message",{message:{role:"assistant",content:"Done"}}],
    ["agent/run/end",{"run-id":"r",status:"completed",verification:"not-run"}]];
  const model=buildTimeline(data.map(([type,data],i)=>({id:String(i),seq:i,at:"2026-11-14T00:00:00Z",type,data})));
  const all=displayTranscript(model,"standard",new Map());
  assert(all.rows.some(row=>row.id==="2"));assert(all.hiddenReasoning.has("2"));
  const final=displayTranscript(model,"standard",new Map(),null,"completion","final");
  assert(!final.rows.some(row=>row.id==="2"));assert(final.rows.some(row=>row.id==="4"));
  assert.equal(transcriptView(null),"detailed");assert.equal(foldedReplies(null),"all");
});


test("command exit status is distinct from transport success and stderr text", async () => {
  const {toolFailed} = await import("./tool-status");
  const result=(data: Record<string, unknown>): DurableEvent=>({id:"r",seq:1,at:"",type:"tool/result",data});
  assert(toolFailed(result({ok:true,status:"error",name:"bash",details:{"exit-code":127}})));
  assert(toolFailed(result({ok:true,name:"bash",details:{"exit-code":2}})));
  assert(!toolFailed(result({ok:true,name:"bash",details:{"exit-code":0},content:"stderr: error is a sample word"})));
  assert(!toolFailed(undefined));
});

test("tool summaries use valid prose without exposing raw commands, code or arbitrary arguments", () => {
  const raw = { command: "python3 -c 'print(123)'", cwd: "/private/workspace" };
  assert.equal(toolSummary("bash", { ...raw, description: "  核对\n库存汇总 ", title: "other" }), "核对 库存汇总");
  assert.equal(toolSummary("bash", { ...raw, description: " ", title: "计算总收入" }), "计算总收入");
  for (const description of [undefined, null, "", " ", {}, ["raw"], 42]) {
    assert.equal(toolSummary("bash", { ...raw, description }), "执行 Shell 命令");
  }
  assert.equal(toolSummary("exec_command", { cmd: "rm example" }), "执行 Shell 命令");
  assert.equal(toolSummary("bb_repl", { code: "(println :raw)" }), "执行代码");
  assert.equal(toolSummary("unknown", { code: "raw", metadata: { secret: "raw" } }), "查看工具详情");
  assert.equal(processDetail(raw), "");
  assert.equal(toolSummary("read", { path: "inventory.csv" }), "inventory.csv");
  const emoji = "👩🏽‍💻";
  assert.equal(toolSummary("bash", { description: emoji.repeat(8) }, 4), emoji.repeat(3) + "…");
  assert.equal(toolSummary("bash", { description: "<script>literal text</script>" }), "<script>literal text</script>");
});

test("collapsed failures retain structured status without leaking raw stderr", async () => {
  const { toolFailureSummary } = await import("./tool-status");
  const result = (details: Record<string, unknown>): DurableEvent => ({ id: "r", seq: 1, at: "", type: "tool/result",
    data: { status: "error", content: "raw stdout and stderr", error: "raw error", details } });
  assert.equal(toolFailureSummary(result({ "exit-code": 127 })), "命令失败 · exit 127 · 展开查看详情");
  for (const exit of [undefined, null, {}, "127", 0]) assert.equal(toolFailureSummary(result({ "exit-code": exit })), "调用失败，展开查看详情");
});
