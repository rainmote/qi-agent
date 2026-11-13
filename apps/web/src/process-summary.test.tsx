import assert from "node:assert/strict";
import test from "node:test";
import { processCategory, processDetail, processSummary } from "./process-summary";
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
