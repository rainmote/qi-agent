import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "./sessions.js";
import { WorkspaceRegistry } from "./workspaces.js";

class FakeWorker extends EventEmitter {
  closed = false;
  readonly startResult: unknown;
  readonly calls: (method: string, params?: Record<string, unknown>) => Promise<unknown>;

  constructor(startResult: unknown,
    calls: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
    super();
    this.startResult = startResult;
    this.calls = calls;
  }

  async start(): Promise<unknown> {
    if (this.startResult instanceof Error) throw this.startResult;
    return this.startResult;
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.calls(method, params);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dao-session-manager-test-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  await mkdir(workspace);
  const registry = new WorkspaceRegistry(state);
  await registry.load(workspace);
  return { root, workspace, state, registry, workspaceId: registry.list()[0].id };
}

async function profiles(state: string): Promise<Record<string, string>> {
  try {
    return (JSON.parse(await readFile(join(state, "session-profiles.json"), "utf8")) as {
      profiles?: Record<string, string>;
    }).profiles || {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

test("create closes an uncommitted worker and rolls back its profile", async () => {
  const value = await fixture();
  const worker = new FakeWorker({ session_id: "new-session" }, async (method) => {
    if (method === "session.rename") throw new Error("rename failed");
    return {};
  });
  try {
    const manager = new SessionManager(value.registry, value.root, {}, () => worker);
    await assert.rejects(manager.create(value.workspaceId, "Name", "creator"), /rename failed/);
    assert.equal(worker.closed, true);
    assert.deepEqual(await profiles(value.state), {});
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("open closes a worker when initialization fails", async () => {
  const value = await fixture();
  const path = join(value.workspace, ".bb-agent", "sessions", "existing.jsonl");
  await mkdir(join(value.workspace, ".bb-agent", "sessions"), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    type: "session/start", at: "2026-08-28T00:00:00Z", data: { session_id: "existing" },
  })}\n`);
  const worker = new FakeWorker(new Error("start failed"), async () => ({}));
  try {
    const manager = new SessionManager(value.registry, value.root, {}, () => worker);
    await assert.rejects(manager.open("existing"), /start failed/);
    assert.equal(worker.closed, true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("open returns session metadata appended by startup plugins", async () => {
  const value = await fixture();
  const path = join(value.workspace, ".bb-agent", "sessions", "recovered.jsonl");
  await mkdir(join(value.workspace, ".bb-agent", "sessions"), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    type: "session/start", at: "2026-08-28T00:00:00Z", data: { session_id: "recovered" },
  })}\n`);
  const worker = new FakeWorker({ session_id: "recovered" }, async (method) => {
    if (method === "session.snapshot") return {};
    return {};
  });
  worker.start = async () => {
    await writeFile(path, `${JSON.stringify({
      type: "session/name", at: "2026-08-28T00:00:01Z", data: { name: "恢复后的标题" },
    })}\n`, { flag: "a" });
    return { session_id: "recovered" };
  };
  try {
    const manager = new SessionManager(value.registry, value.root, {}, () => worker);
    const opened = await manager.open("recovered");
    assert.equal(opened.summary.name, "恢复后的标题");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("fork closes the destination worker and rolls back its inherited profile", async () => {
  const value = await fixture();
  const sourcePath = join(value.workspace, ".bb-agent", "sessions", "source.jsonl");
  await mkdir(join(value.workspace, ".bb-agent", "sessions"), { recursive: true });
  await writeFile(sourcePath, `${JSON.stringify({
    type: "session/start", at: "2026-08-28T00:00:00Z", data: { session_id: "source" },
  })}\n`);
  await writeFile(join(value.state, "session-profiles.json"), `${JSON.stringify({
    profiles: { [sourcePath]: "creator" },
  })}\n`);
  let destinationWorker: FakeWorker | undefined;
  const sourceWorker = new FakeWorker({ session_id: "source" }, async (method, params) => {
    if (method === "session.snapshot") return {};
    if (method === "session.fork") {
      const destination = String(params?.destination);
      await writeFile(destination, `${JSON.stringify({
        type: "session/fork", at: "2026-08-28T00:00:01Z", data: { session_id: "forked" },
      })}\n`);
      return { path: destination, "session-id": "forked" };
    }
    return {};
  });
  try {
    const manager = new SessionManager(value.registry, value.root, {}, (_workspace, path) => {
      if (path === sourcePath) return sourceWorker;
      destinationWorker = new FakeWorker({ session_id: "forked" }, async (method) => {
        if (method === "session.rename") throw new Error("fork rename failed");
        return {};
      });
      return destinationWorker;
    });
    await assert.rejects(manager.fork("source", "Branch"), /fork rename failed/);
    assert.equal(destinationWorker?.closed, true);
    assert.deepEqual(await profiles(value.state), { [sourcePath]: "creator" });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
