import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { AgentWorker } from "./worker.js";

test("daemon socket resets reject pending calls without an uncaught readline error", {
  timeout: 5_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dao-worker-reset-"));
  const clients: Socket[] = [];
  const peers: Socket[] = [];
  const original = Socket.prototype.connect;
  t.mock.method(Socket.prototype, "connect", function (this: Socket, ...args: unknown[]) {
    clients.push(this);
    return Reflect.apply(original, this, args);
  });
  const received = new EventEmitter();
  const daemon = createServer((socket) => {
    peers.push(socket);
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const command = JSON.parse(line) as { request_id: string; method: string };
      if (command.method === "test.pending-reset") {
        received.emit("pending");
        return;
      }
      const result = command.method === "agent.list" ? []
        : command.method === "agent.create" ? { agent: { agent_id: "reset-test" } }
          : {};
      socket.write(`${JSON.stringify({
        type: "response", id: command.request_id, ok: true, result,
      })}\n`);
    });
  });
  const worker = new AgentWorker(root, join(root, "session.jsonl"), root, {
    runtimeDirectory: root,
  });
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    for (const socket of clients) socket.destroy();
    await worker.close();
    for (const socket of peers) socket.destroy();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  })();
  t.after(cleanup);
  try {
    daemon.listen(join(root, "daemon.sock"));
    await once(daemon, "listening", { signal: t.signal });
    await worker.start();
    const admitted = once(received, "pending", { signal: t.signal });
    const pending = worker.call("test.pending-reset").then(
      () => ({ error: null }), (error: Error) => ({ error }));
    await admitted;
    assert.equal(clients.length, 1);
    const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    assert.doesNotThrow(() => clients[0].emit("error", error));
    assert.equal((await pending).error, error);
  } finally {
    await cleanup();
  }
});
