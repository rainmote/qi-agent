import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { AgentWorker } from "./worker.js";

interface MockCommand { request_id: string; method: string; agent_id?: string | null; command_id?: string; client_id?: string; journal_id?: string; params?: Record<string, unknown> }

async function mockDaemon(handle?: (command: MockCommand, socket: Socket) => boolean) {
  const root = await mkdtemp("/tmp/qi-web-worker-test-");
  let socket: Socket | undefined;
  const server = createServer((connection) => {
    socket = connection;
    const lines = createInterface({ input: connection });
    lines.on("line", (line) => {
      const command = JSON.parse(line) as MockCommand;
      if (handle?.(command, connection)) return;
      const result = command.method === "agent.list"
        ? [{ agent_id: "test-agent", session_path: join(root, "session.jsonl"), status: "running" }]
        : command.method === "agent.attach"
          ? { snapshot: { session_id: "test-session", cursor: { generation: 7, sequence: 0 } } }
          : {};
      connection.write(`${JSON.stringify({ type: "response", version: 1,
        id: command.request_id, ok: true, result })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(join(root, "daemon.sock"), resolve));
  const worker = new AgentWorker(root, join(root, "session.jsonl"), root,
    { runtimeDirectory: root });
  await worker.callDaemon("test.ready");
  return {
    worker,
    push: (messages: unknown[]) => socket!.write(messages.map((value) => JSON.stringify(value)).join("\n") + "\n"),
    disconnect: () => socket!.destroy(),
    close: async () => {
      await worker.close();
      socket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("worker replay detects initial, malformed, stale, future, and foreign cursors", async () => {
  const daemon = await mockDaemon();
  try {
    const initial = daemon.worker.eventCursor;
    const epoch = initial.split(":")[0];
    assert.equal(daemon.worker.replayAfter().reset, "initial");
    assert.equal(daemon.worker.replayAfter("42").reset, "invalid-cursor");
    assert.equal(daemon.worker.replayAfter(`${epoch}:9000`).reset, "invalid-cursor");
    assert.equal(daemon.worker.replayAfter("previous:0").reset, "generation");
    const delivered = new Promise<void>((resolve) => daemon.worker.on("event", (event) => {
      if (event.hostSeq === 2_001) resolve();
    }));
    daemon.push(Array.from({ length: 2_001 }, (_, index) => ({
      type: "event", version: 1, event: "agent/state", data: { revision: index + 1 },
      cursor: { generation: 1, sequence: index + 1 },
    })));
    await delivered;
    assert.equal(daemon.worker.replayAfter(initial).reset, "buffer-gap");
    const replay = daemon.worker.replayAfter(`${epoch}:1`);
    assert.equal(replay.reset, null);
    assert.equal(replay.events.length, 2_000);
    assert.equal(replay.events[0].hostSeq, 2);
    assert.equal(replay.events.at(-1)?.hostSeq, 2_001);
    assert.deepEqual(daemon.worker.replayAfter(daemon.worker.eventCursor).events, []);
  } finally { await daemon.close(); }
});

test("worker generation changes reset the host epoch and retained events", async () => {
  const daemon = await mockDaemon();
  try {
    let delivered = once(daemon.worker, "event");
    daemon.push([{ type: "event", version: 1, event: "agent/state",
      cursor: { generation: 1, sequence: 1 } }]);
    await delivered;
    const previous = daemon.worker.eventCursor;
    const reset = once(daemon.worker, "reset");
    delivered = once(daemon.worker, "event");
    daemon.push([{ type: "event", version: 1, event: "worker/restarting",
      cursor: { generation: 2, sequence: 0 } }]);
    await reset;
    await delivered;
    assert.notEqual(daemon.worker.eventCursor.split(":")[0], previous.split(":")[0]);
    assert.equal(daemon.worker.replayAfter(previous).reset, "generation");
    assert.equal(daemon.worker.eventsAfter().length, 1);
    assert.equal(daemon.worker.eventsAfter()[0].hostSeq, 1);
  } finally { await daemon.close(); }
});

test("worker uses the attached snapshot generation before any live event arrives", async () => {
  const daemon = await mockDaemon();
  try {
    await daemon.worker.start();
    const before = daemon.worker.eventCursor;
    const reset = once(daemon.worker, "reset");
    daemon.push([{ type: "event", version: 1, event: "worker/restarting",
      cursor: { generation: 8, sequence: 0 } }]);
    await reset;
    assert.equal(daemon.worker.replayAfter(before).reset, "generation");
  } finally { await daemon.close(); }
});

test("worker reports both socket loss and explicit detach to stream subscribers", async () => {
  const daemon = await mockDaemon();
  try {
    const exited = once(daemon.worker, "exit");
    daemon.disconnect();
    await exited;
  } finally { await daemon.close(); }
  const detached = await mockDaemon();
  try {
    const exited = once(detached.worker, "exit");
    await detached.worker.close();
    await exited;
  } finally { await detached.close(); }
});

test("daemon socket resets reject pending calls without an uncaught readline error", async (t) => {
  const connections: Socket[] = [];
  const original = Socket.prototype.connect;
  t.mock.method(Socket.prototype, "connect", function (this: Socket, ...args: unknown[]) {
    connections.push(this);
    return Reflect.apply(original, this, args);
  });
  const received = new EventEmitter();
  const daemon = await mockDaemon((command) => {
    if (command.method !== "test.pending-reset") return false;
    received.emit("pending");
    return true;
  });
  try {
    const admitted = once(received, "pending");
    const pending = daemon.worker.callDaemon("test.pending-reset").then(
      () => ({ error: null }), (error: Error) => ({ error }));
    await admitted;
    const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    assert.doesNotThrow(() => connections.at(-1)!.emit("error", error));
    assert.match((await pending).error?.message || "", /ECONNRESET/);
  } finally { await daemon.close(); }
});

test("worker exit notifications terminate streams even while the daemon socket remains open", async () => {
  const daemon = await mockDaemon();
  try {
    const exited = once(daemon.worker, "exit");
    daemon.push([{ type: "event", version: 1, event: "worker/exited",
      cursor: { generation: 1, sequence: 1 } }]);
    await exited;
    assert.match(daemon.worker.stderr, /worker exited/);
  } finally { await daemon.close(); }
});

for (const method of ["session.archive", "agent.stop", "daemon.update"]) {
test(`worker exit rejects agent calls but preserves the ${method} response`, async () => {
  const received = new EventEmitter();
  const held = new Map<string, MockCommand>();
  const daemon = await mockDaemon((command) => {
    if (!["test.agent-wait", method].includes(command.method)) return false;
    held.set(command.method, command);
    received.emit(command.method);
    return true;
  });
  try {
    await daemon.worker.start();
    const agentSent = once(received, "test.agent-wait");
    const agentResult = assert.rejects(daemon.worker.call("test.agent-wait"), /worker exited.*uncertain/);
    await agentSent;
    const archiveSent = once(received, method);
    const archived = method === "session.archive"
      ? daemon.worker.callDaemon(method, {}) : daemon.worker.call(method, {});
    await archiveSent;
    assert.equal(held.get("test.agent-wait")?.agent_id, "test-agent");
    assert.equal(held.get(method)?.agent_id, method === "session.archive" ? null : "test-agent");
    const exited = once(daemon.worker, "exit");
    daemon.push([{ type: "event", version: 1, event: "worker/exited",
      cursor: { generation: 7, sequence: 1 } }]);
    await exited;
    await agentResult;
    daemon.push([{ type: "response", version: 1, ok: true,
      id: held.get(method)!.request_id, result: { completed: true } }]);
    assert.deepEqual(await archived, { completed: true });
  } finally { await daemon.close(); }
});

}

test("daemon socket EOF still rejects pending daemon control outcomes after worker exit", async () => {
  const received = new EventEmitter();
  const daemon = await mockDaemon((command) => {
    if (command.method !== "session.archive") return false;
    received.emit("archive");
    return true;
  });
  try {
    await daemon.worker.start();
    const sent = once(received, "archive");
    const archived = assert.rejects(daemon.worker.callDaemon("session.archive"), /daemon connection closed.*uncertain/);
    await sent;
    const exited = once(daemon.worker, "exit");
    daemon.push([{ type: "event", version: 1, event: "worker/exited",
      cursor: { generation: 7, sequence: 1 } }]);
    await exited;
    daemon.disconnect();
    await archived;
  } finally { await daemon.close(); }
});

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("unknown outcomes retain command identity across socket reconnects and completed replay", async () => {
  let executions = 0;
  const journal = new Map<string, unknown>();
  const daemon = await mockDaemon((command, socket) => {
    if (command.method !== "turn.submit" && command.method !== "command.status") return false;
    const key = `${command.journal_id}:${command.method === "command.status" ? command.params?.command_id : command.command_id}`;
    const reply = (result: unknown) => socket.write(`${JSON.stringify({type:"response", id:command.request_id, ok:true, result})}\n`);
    if (command.method === "command.status") reply(journal.has(key)
      ? { status: "completed", result: journal.get(key) } : { status: "not_found" });
    else if (journal.has(key)) reply(journal.get(key));
    else { executions++; journal.set(key, { accepted: true }); /* response lost */ }
    return true;
  });
  try {
    await assert.rejects(daemon.worker.call("turn.submit", {message:"once"}, 20, "stable-operation"),
      (error: any) => error.data?.status === "uncertain" && error.data?.command_id === "stable-operation");
    await daemon.worker.close();
    assert.deepEqual(await daemon.worker.callDaemon("command.status", {command_id:"stable-operation"}),
      {status:"completed",result:{accepted:true}});
    assert.deepEqual(await daemon.worker.call("turn.submit", {message:"once"}, 1000, "stable-operation"), {accepted:true});
    assert.equal(executions, 1);
  } finally { await daemon.close(); }
});

test("snapshot reuse carries an earlier cursor so events during and after snapshot remain replayable", async () => {
  let snapshots = 0;
  const daemon = await mockDaemon((command, socket) => {
    if (command.method === "session.snapshot") snapshots++;
    if (command.method !== "agent.attach") return false;
    socket.write(JSON.stringify({type:"event",event:"message",event_id:"during",durable:true,seq:1,
      cursor:{generation:7,sequence:1}}) + "\n");
    socket.write(JSON.stringify({type:"response",id:command.request_id,ok:true,
      result:{snapshot:{session_id:"test-session",events:[{id:"during"}],state:{revision:1},interactions_revision:0,cursor:{generation:7}}}}) + "\n");
    return true;
  });
  try {
    const cold = await daemon.worker.snapshot();
    assert.equal(snapshots, 0, "cold open reuses attach snapshot");
    assert.equal(daemon.worker.replayAfter(cold.eventCursor).events[0].event_id, "during");
    await daemon.worker.snapshot();
    assert.equal(snapshots, 1, "warm open requests one current snapshot");
    await daemon.worker.call("policy.select", {mode:"deny"});
  } finally { await daemon.close(); }
});

test("idle detach respects multiple browser references and in-flight calls without stopping the agent", async () => {
  const calls: string[] = [];
  let complete: (() => void) | undefined;
  const daemon = await mockDaemon((command, socket) => {
    calls.push(command.method);
    if (command.method !== "repl.eval") return false;
    complete = () => socket.write(JSON.stringify({type:"response",id:command.request_id,ok:true,result:{done:true}}) + "\n");
    return true;
  });
  daemon.worker.daemonEnvironment.idleDetachMs = 25;
  try {
    await daemon.worker.start();
    const first = daemon.worker.subscribeClient();
    const second = daemon.worker.subscribeClient();
    first(); first();
    await delay(60);
    assert.equal(calls.includes("agent.detach"), false);
    const pending = daemon.worker.call("repl.eval", {code:"mock"});
    while (!complete) await delay(2);
    second();
    await delay(60);
    assert.equal(calls.includes("agent.detach"), false);
    const exited = once(daemon.worker,"exit");
    complete(); await pending; await exited;
    await delay(10);
    assert.ok(calls.includes("agent.detach"));
    assert.ok(!calls.includes("agent.stop") && !calls.includes("interaction.resolve"));
    await daemon.worker.start();
    assert.equal(calls.filter(method => method === "agent.attach").length, 2);
  } finally { await daemon.close(); }
});
