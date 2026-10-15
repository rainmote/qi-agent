import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "./sessions.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { AgentWorker } from "./worker.js";
import { WorkspaceFiles } from "./workspace-files.js";
import { TurnFiles, snapshotTurnId } from "./turn-files.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(config = "tui-mock.edn", idleDetachMs = 30_000) {
  const root = await realpath(await mkdtemp("/tmp/qi-operations-"));
  const workspace = join(root,"w"), runtime = join(root,"r"), state = join(root,"s");
  await mkdir(workspace);
  const registry = new WorkspaceRegistry(join(root,"web"));
  await registry.load(workspace);
  const environment = {runtimeDirectory:runtime,stateDirectory:state,idleDetachMs};
  const child: ChildProcess = spawn(process.env.QI_AGENT_BIN || join(repository,"apps/tui-rs/target/debug/qi-agent"),
    ["daemon","serve","--repository-root",repository,"--config",join(repository,"examples",config)],
    {cwd:root,stdio:["ignore","ignore","pipe"],env:{...process.env,QI_AGENT_HOME:join(root,"home"),
      QI_AGENT_PRESET_USER_ROOT:join(root,"presets"),QI_AGENT_RUNTIME_DIR:runtime,QI_AGENT_STATE_DIR:state,
      QI_AGENT_MAX_WORKERS:"2",QI_AGENT_IDLE_EVICTION_MINUTES:"90"}});
  let diagnostics = "";
  child.stderr?.on("data",(value:Buffer)=>{diagnostics=(diagnostics+value.toString()).slice(-8000);});
  const managers: SessionManager[] = [];
  const control = new AgentWorker(workspace,join(root,"control"),repository,environment);
  const createManager = () => {
    const manager = new SessionManager(registry,repository,environment);
    managers.push(manager); return manager;
  };
  const close = async () => {
    await Promise.allSettled(managers.map(manager=>manager.closeAll()));
    if (child.exitCode === null && child.signalCode === null) {
      try {await control.callDaemon("daemon.shutdown",{},2000);} catch {}
      const exited = once(child,"exit");
      const timer = setTimeout(()=>child.kill("SIGKILL"),4000);
      if (child.exitCode === null && child.signalCode === null) await exited;
      clearTimeout(timer);
    }
    await control.close();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  };
  try {
    const deadline = Date.now()+15000;
    while (!existsSync(join(runtime,"daemon.sock"))) {
      assert.equal(child.exitCode,null,diagnostics);
      assert.ok(Date.now()<deadline,diagnostics || "daemon start timed out");
      await delay(20);
    }
  } catch (error) {await close();throw error;}
  return {root,workspace,registry,environment,control,createManager,close};
}

test("real daemon reconciles a timed-out side effect after Web Host reconnection without repeating it", {timeout:30000}, async () => {
  const value = await fixture();
  try {
    const manager = value.createManager();
    const opened = await manager.create(value.registry.list()[0].id);
    const marker = join(value.workspace,"executions.txt");
    const entered = join(value.workspace,"entered.txt"), release = join(value.workspace,"release.txt");
    const params = {code:`(do (spit ${JSON.stringify(entered)} "entered") (loop [n 0] (when (and (< n 1000) (not (.exists (java.io.File. ${JSON.stringify(release)})))) (Thread/sleep 10) (recur (inc n)))) (spit ${JSON.stringify(marker)} "once\\n" :append true) :done)`};
    await assert.rejects(opened.worker.call("repl.eval",params,20,"original-operation"),
      (error:any)=>error.data?.status==="uncertain" && error.data.command_id==="original-operation");
    // The client timeout is not an admission receipt. Wait for the actual worker
    // to enter the operation, then hold it across disconnection with a barrier.
    for (let n=0;n<1000 && !existsSync(entered);n++) await delay(10);
    assert.equal(existsSync(entered),true,"the timed-out operation reached the worker");
    assert.equal((await manager.commandStatus(opened.summary.id,"original-operation") as any).status,"pending");
    await manager.closeAll();
    const reconnected = value.createManager();
    assert.equal((await reconnected.commandStatus(opened.summary.id,"original-operation") as any).status,"pending");
    await writeFile(release,"continue");
    for (let n=0;n<1000;n++) {
      if ((await reconnected.commandStatus(opened.summary.id,"original-operation") as any).status==="completed") break;
      await delay(10);
    }
    assert.equal((await reconnected.commandStatus(opened.summary.id,"original-operation") as any).status,"completed");
    const current = await reconnected.open(opened.summary.id);
    await current.worker.call("repl.eval",params,5000,"original-operation");
    assert.equal(await readFile(marker,"utf8"),"once\n");
    await assert.rejects(current.worker.call("repl.eval",{code:"different"},5000,"original-operation"),/different mutation/);
  } finally {await value.close();}
});

test("quota pressure releases unviewed Web attachments and resumes their histories later", {timeout:30000}, async () => {
  const value = await fixture();
  try {
    const manager = value.createManager();
    const first = await manager.create(value.registry.list()[0].id);
    const second = await manager.create(value.registry.list()[0].id);
    first.worker.subscribeClient()(); second.worker.subscribeClient()();
    const third = await manager.create(value.registry.list()[0].id);
    assert.ok(third.summary.id);
    const status = await value.control.callDaemon("daemon.status") as any;
    assert.equal(status.worker_count,2);
    assert.ok(status.agents.some((agent:any)=>agent.residency==="inactive"));
    const reopened = await manager.open(first.summary.id);
    assert.equal((reopened.snapshot as any).session_id,first.summary.id);
  } finally {await value.close();}
});

test("browser detach preserves approvals and capacity pressure cannot evict a waiting task", {timeout:30000}, async () => {
  const value = await fixture("daemon-approval-mock.edn",300);
  try {
    const manager = value.createManager();
    const first = await manager.create(value.registry.list()[0].id);
    const release = first.worker.subscribeClient();
    await first.worker.call("turn.submit",{message:"request mock approval"});
    let snapshot:any;
    for (let i=0;i<100;i++) {
      snapshot = await first.worker.call("session.snapshot");
      if (snapshot.interactions.length) break;
      await delay(10);
    }
    assert.equal(snapshot.interactions.length,1);
    const exited = once(first.worker,"exit"); release(); await exited;
    // One session awaits approval; another has an active viewer. Neither is disposable.
    const second = await manager.create(value.registry.list()[0].id);
    const secondRelease = second.worker.subscribeClient();
    await assert.rejects(manager.create(value.registry.list()[0].id),/worker quota/);
    const reopened = await manager.open(first.summary.id);
    assert.equal((reopened.snapshot as any).interactions.length,1);
    assert.equal(existsSync(join(value.workspace,"approval.txt")),false);
    await reopened.worker.call("interaction.resolve",{id:snapshot.interactions[0].id,decision:"deny"});
    secondRelease();
  } finally {await value.close();}
});

test("real daemon completion is bound to its admission request and releases the turn snapshot pin", {timeout:30000}, async () => {
  const value = await fixture();
  const files = new WorkspaceFiles(value.registry, {
    attachmentDirectory: join(value.root, "uploads"),
    snapshotDirectory: join(value.root, "snapshots"),
  });
  const tracker = new TurnFiles(files);
  try {
    const workspace = value.registry.list()[0];
    const session = await value.createManager().create(workspace.id);
    const commandId = "snapshot-stable-command-001";
    await writeFile(join(value.workspace, "change.txt"), "before\n");
    await tracker.begin(session.worker, workspace.id, session.summary.id, commandId);
    assert.equal(session.worker.idle, false, "the snapshot pins the worker without a browser subscriber");
    await writeFile(join(value.workspace, "change.txt"), "after\n");
    let completed: any;
    const capture = (event: any) => { if (event.event === "remote/run-result") completed = event; };
    session.worker.on("event", capture);
    const admission = await session.worker.call("turn.submit", { message: "run the offline discovery fixture" }, 5000, commandId) as any;
    assert.equal(typeof admission.request_id, "string");
    assert.notEqual(admission.request_id, commandId, "daemon request identity differs from the idempotency key");
    // Deliberately postpone admission until the real completion has arrived.
    // This verifies the early-event buffer instead of assuming response order.
    for (let attempt = 0; attempt < 200 && !completed; attempt++) await delay(10);
    assert.equal(completed?.data?.request_id, admission.request_id);
    assert.equal(await files.sessionChanges(workspace.id, session.summary.id), null);
    tracker.admit(workspace.id, session.summary.id, commandId, admission);
    let changes: Awaited<ReturnType<WorkspaceFiles["sessionChanges"]>> = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      changes = await files.sessionChanges(workspace.id, session.summary.id);
      if (changes && session.worker.idle) break;
      await delay(10);
    }
    assert.equal(changes?.turnId, snapshotTurnId(session.summary.id, commandId));
    assert.equal(changes?.partial, false);
    assert.deepEqual(changes?.files.map(file => [file.path, file.status]), [["change.txt", "modified"]]);
    assert.match(changes!.files[0].diff || "", /-before\n\+after/);
    assert.equal(session.worker.idle, true, "completion releases the snapshot's subscriber pin");
    session.worker.off("event", capture);
  } finally { await tracker.close(); await value.close(); }
});
