import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { startWebHost } from "./server.js";
import { AgentWorker } from "./worker.js";

test("cold and warm snapshot handoff each transfer history once and preserve intervening events", {timeout:10000}, async () => {
  const root = await realpath(await mkdtemp("/tmp/qi-snapshot-"));
  const workspace = join(root,"w"); await mkdir(workspace);
  const snapshot = {session_id:"sample",cursor:{generation:1},state:{phase:"idle",revision:1},
    interactions:[],interactions_revision:0,events:Array.from({length:2000},(_,i)=>({
      id:`event-${i}`,seq:i+1,type:"message",data:{message:{role:"user",content:"x".repeat(200)}},
    }))};
  let connection:Socket | undefined;
  let fullSnapshots = 0, snapshotBytes = 0;
  const daemon = createServer(socket=>{
    connection=socket;
    createInterface({input:socket}).on("line",line=>{
      const command=JSON.parse(line);
      let result:unknown={};
      if(command.method==="agent.list") result=[{agent_id:"agent",session_path:join(root,"session.jsonl"),status:"running"}];
      if(command.method==="agent.attach" || command.method==="session.snapshot") {
        fullSnapshots++; snapshotBytes+=Buffer.byteLength(JSON.stringify(snapshot));
        result=command.method==="agent.attach" ? {snapshot} : snapshot;
      }
      socket.write(JSON.stringify({type:"response",id:command.request_id,ok:true,result})+"\n");
    });
  });
  await new Promise<void>(resolve=>daemon.listen(join(root,"daemon.sock"),resolve));
  const worker=new AgentWorker(workspace,join(root,"session.jsonl"),root,{runtimeDirectory:root});
  const host=await startWebHost({codexAuthFile:join(root,"fixture-only-missing-codex-auth.json"),port:0,workspace,stateDirectory:join(root,"web"),token:"handoff"});
  host.sessions.worker=async()=>worker;
  const measurements=[];
  try {
    for(const kind of ["cold","warm"]) {
      const beforeCount=fullSnapshots,beforeBytes=snapshotBytes,start=performance.now();
      const opened=await worker.snapshot();
      assert.ok(opened.eventCursor);
      const delivered=once(worker,"event");
      connection!.write(JSON.stringify({type:"event",event:"message",event_id:kind,durable:true,seq:2001,
        data:{message:{role:"assistant",content:"between open and subscribe"}},cursor:{generation:1}})+"\n");
      await delivered;
      const abort=new AbortController();
      const response=await fetch(`http://127.0.0.1:${host.port}/api/sessions/sample/events?after=${encodeURIComponent(opened.eventCursor!)}`,{
        headers:{Authorization:"Bearer handoff"},signal:abort.signal,
      });
      const reader=response.body!.getReader(); let frames="";
      while(!frames.includes("event: ready")) frames+=new TextDecoder().decode((await reader.read()).value);
      assert.ok(frames.includes(`"event_id":"${kind}"`));
      assert.ok(!frames.includes("event: snapshot"));
      assert.equal(fullSnapshots-beforeCount,1);
      measurements.push({kind,fullSnapshots:fullSnapshots-beforeCount,snapshotBytes:snapshotBytes-beforeBytes,
        elapsedMs:Math.round(performance.now()-start)});
      abort.abort();
    }
    console.log(JSON.stringify({snapshotHandoff:measurements}));
  } finally {
    await worker.close(); connection?.destroy(); await host.close();
    await new Promise<void>(resolve=>daemon.close(()=>resolve()));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
