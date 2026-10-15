import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { AgentWorker } from "./worker.js";
import type { WorkspaceFiles } from "./workspace-files.js";
import { TurnFiles, snapshotTurnId } from "./turn-files.js";

test("identical command IDs in different sessions have independent snapshots and admission", async () => {
  const began: string[] = [], finished: string[] = [], recorded: string[] = [];
  const files = { beginTurn: async (_workspace: string, turn: string) => { began.push(turn); },
    finishTurn: async (_workspace: string, turn: string) => { finished.push(turn); },
    recordSessionTurn: async (_workspace: string, session: string) => { recorded.push(session); },
    discardTurn: async () => {} } as unknown as WorkspaceFiles;
  const tracker = new TurnFiles(files);
  const worker = () => Object.assign(new EventEmitter(), { subscribeClient: () => () => {} }) as unknown as AgentWorker;
  const a = worker(), b = worker();
  await tracker.begin(a, "workspace", "session-a", "same-command");
  await tracker.begin(b, "workspace", "session-b", "same-command");
  assert.deepEqual(began, [snapshotTurnId("session-a", "same-command"), snapshotTurnId("session-b", "same-command")]);
  a.emit("event", { event: "remote/run-result", data: { request_id: "daemon-a", ok: true } });
  b.emit("event", { event: "remote/run-result", data: { request_id: "daemon-b", ok: true } });
  tracker.reconcile("session-a", "same-command", { request_id: "daemon-a" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(recorded, ["session-a"]); assert.equal(finished.length, 1);
  tracker.admit("workspace", "session-b", "same-command", { request_id: "daemon-b" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(recorded, ["session-a", "session-b"]); assert.equal(new Set(finished).size, 2);
  await tracker.close();
});

test("turn snapshots preserve actual execution outcomes without asserting acceptance", async () => {
  for (const status of ["completed", "failed", "cancelled", "uncertain"] as const) {
    const options: any[] = [];
    const files = { beginTurn: async () => true, finishTurn: async (_workspace: string, _turn: string, value: unknown) => { options.push(value); },
      recordSessionTurn: async () => {}, discardTurn: async () => {} } as unknown as WorkspaceFiles;
    const worker = Object.assign(new EventEmitter(), { subscribeClient: () => () => {} }) as unknown as AgentWorker;
    const tracker = new TurnFiles(files);
    await tracker.begin(worker, "workspace", "session", "command-1");
    tracker.admit("workspace", "session", "command-1", { request_id: "request-1" });
    const event = { event: "remote/run-result", data: { request_id: "request-1", ok: status === "completed", result: { status, reason: status } } };
    worker.emit("event", event); worker.emit("event", event);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(options.length, 1); assert.equal(options[0].execution.status, status); assert.equal(options[0].verification, undefined);
    await tracker.close();
  }
});
