import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  async callDaemon(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.calls(method, params);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qi-agent-session-manager-test-")));
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

test("catalog keeps legacy .bb-agent sessions visible", async () => {
  const value = await fixture();
  const directory = join(value.workspace, ".bb-agent", "sessions");
  const path = join(directory, "legacy.jsonl");
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify({
    type: "session/start", at: "2026-08-28T00:00:00Z", data: { session_id: "legacy" },
  })}\n`);
  try {
    const manager = new SessionManager(value.registry, value.root, {}, () => {
      throw new Error("listing must not start a worker");
    });
    const sessions = await manager.list(value.registry.list()[0]);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "legacy");
    assert.match(sessions[0].path, /\.bb-agent\/sessions\/legacy\.jsonl$/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

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
  const path = join(value.workspace, ".qi-agent", "sessions", "existing.jsonl");
  await mkdir(join(value.workspace, ".qi-agent", "sessions"), { recursive: true });
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
  const path = join(value.workspace, ".qi-agent", "sessions", "recovered.jsonl");
  await mkdir(join(value.workspace, ".qi-agent", "sessions"), { recursive: true });
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
  const sourcePath = join(value.workspace, ".qi-agent", "sessions", "source.jsonl");
  await mkdir(join(value.workspace, ".qi-agent", "sessions"), { recursive: true });
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

test("archive delegates unopened legacy history to daemon without starting a worker and preserves its profile", async () => {
  const value = await fixture();
  const directory = join(value.workspace, ".bb-agent", "sessions");
  const path = join(directory, "legacy.jsonl");
  const content = `${JSON.stringify({
    type: "session/start", at: "2026-08-28T00:00:00Z", data: { session_id: "legacy" },
  })}\n`;
  await mkdir(directory, { recursive: true });
  await writeFile(path, content);
  await writeFile(join(value.state, "session-profiles.json"), JSON.stringify({ profiles: { [path]: "creator" } }));
  let starts = 0;
  const archivePath = join(value.workspace, ".bb-agent", "archive", "sessions", "legacy.jsonl");
  const worker = new FakeWorker({}, async (method, params) => {
    assert.equal(method, "session.archive");
    assert.deepEqual(params, { session_path: path, archive_path: archivePath });
    // Daemon owns stop, rename and durable lifecycle state. The host only
    // updates its index after that authority acknowledges the destination.
    assert.equal(worker.closed, false);
    assert.deepEqual(await profiles(value.state), { [path]: "creator", [archivePath]: "creator" });
    await mkdir(dirname(archivePath), { recursive: true });
    await rename(path, archivePath);
    return { archived: true, session_path: archivePath };
  });
  worker.start = async () => { starts += 1; throw new Error("Archive must not hydrate history"); };
  try {
    const manager = new SessionManager(value.registry, value.root, {}, () => worker);
    assert.equal((await manager.listAll()).length, 1);
    assert.deepEqual(await manager.archive("legacy"), { archived: true });
    assert.equal(starts, 0);
    assert.equal(worker.closed, true);
    assert.equal(await readFile(archivePath, "utf8"), content);
    assert.deepEqual(await manager.listAll(), []);
    assert.deepEqual(await profiles(value.state), { [archivePath]: "creator" });
    const restarted = new SessionManager(value.registry, value.root, {}, () => {
      throw new Error("Restart listing must not start a worker");
    });
    assert.deepEqual(await restarted.listAll(), []);
    await assert.rejects(restarted.open("legacy"), /not found/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("failed archive keeps history and the attached worker available for a retry", async () => {
  const value = await fixture();
  const path = join(value.workspace, ".qi-agent", "sessions", "running.jsonl");
  await mkdir(dirname(path), { recursive: true });
  const content = `${JSON.stringify({ type: "session/start", data: { session_id: "running" } })}\n`;
  await writeFile(path, content);
  let attempts = 0;
  const worker = new FakeWorker({ session_id: "running" }, async (method, params) => {
    if (method === "session.snapshot") return { running: true };
    assert.equal(method, "session.archive");
    assert.equal(worker.closed, false, "Do not detach before the daemon confirms stopping");
    attempts += 1;
    if (attempts === 1) throw new Error("writer could not stop");
    const destination = String(params?.archive_path);
    await mkdir(dirname(destination), { recursive: true });
    await rename(path, destination);
    return { archived: true, session_path: destination };
  });
  try {
    const manager = new SessionManager(value.registry, value.root, {}, () => worker);
    await manager.open("running");
    await assert.rejects(manager.archive("running"), /writer could not stop/);
    assert.equal(worker.closed, false);
    assert.equal(await readFile(path, "utf8"), content);
    assert.equal((await manager.worker("running")), worker);
    assert.deepEqual(await manager.archive("running"), { archived: true });
    assert.equal(worker.closed, true);
    assert.equal(attempts, 2);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("archive retries after a lost acknowledgement and host restart, and prevents concurrent reopening", async () => {
  const value = await fixture();
  const path = join(value.workspace, ".qi-agent", "sessions", "uncertain.jsonl");
  await mkdir(dirname(path), { recursive: true });
  const content = `${JSON.stringify({ type: "session/start", data: { session_id: "uncertain" } })}\n`;
  await writeFile(path, content);
  let attempts = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let created = 0;
  const archivePath = join(value.workspace, ".qi-agent", "archive", "sessions", "uncertain.jsonl");
  const calls: unknown[] = [];
  try {
    const factory = () => {
      created += 1;
      return new FakeWorker(new Error("must not hydrate"), async (method, params) => {
        assert.equal(method, "session.archive");
        calls.push(params);
        attempts += 1;
        if (attempts === 1) {
          await mkdir(dirname(archivePath), { recursive: true });
          await rename(path, archivePath);
          throw new Error("acknowledgement lost");
        }
        signalStarted!();
        await blocked;
        return { archived: true, session_path: archivePath };
      });
    };
    const manager = new SessionManager(value.registry, value.root, {}, factory);
    await assert.rejects(manager.archive("uncertain"), /acknowledgement lost/);
    const restarted = new SessionManager(value.registry, value.root, {}, factory);
    const retry = restarted.archive("uncertain");
    await started;
    const reopening = assert.rejects(restarted.open("uncertain"), /not found/);
    release!();
    assert.deepEqual(await retry, { archived: true });
    await reopening;
    assert.equal(created, 2, "Concurrent reopen must not recreate the original transcript");
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(await readFile(archivePath, "utf8"), content);
    assert.deepEqual(await restarted.listAll(), []);
    assert.deepEqual(await restarted.archive("uncertain"), { archived: true });
    assert.equal(attempts, 3, "An HTTP retry of a completed archive is idempotent too");
  } finally {
    release?.();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("persisted archive retries cannot bypass workspace boundaries or target a replaced session", async () => {
  const value = await fixture();
  const path = join(value.workspace, ".qi-agent", "sessions", "replaced.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ type: "session/start", data: { session_id: "different" } })}\n`);
  try {
    await writeFile(join(value.state, "session-archive-targets.json"), JSON.stringify({
      targets: {
        old: { workspaceId: value.workspaceId, path },
        outside: { workspaceId: value.workspaceId, path: join(value.root, "outside.jsonl") },
      },
    }));
    const manager = new SessionManager(value.registry, value.root, {}, () => {
      throw new Error("Invalid targets must not reach the daemon");
    });
    await assert.rejects(manager.archive("old"), /replaced by a different/);
    await assert.rejects(manager.archive("outside"), /outside the allowlisted/);
    assert.match(await readFile(path, "utf8"), /different/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("archive rejects linked or invalid source replacements without touching the external history", async () => {
  const value = await fixture();
  const directory = join(value.workspace, ".qi-agent", "sessions");
  const path = join(directory, "linked.jsonl");
  const external = join(value.root, "external.jsonl");
  const content = `${JSON.stringify({ type: "session/start", data: { session_id: "linked" } })}\n`;
  await mkdir(directory, { recursive: true });
  await writeFile(external, content);
  await writeFile(join(value.state, "session-archive-targets.json"), JSON.stringify({
    targets: { linked: { workspaceId: value.workspaceId, path } },
  }));
  try {
    const manager = new SessionManager(value.registry, value.root, {}, () => {
      throw new Error("An invalid path must not reach the daemon");
    });
    await symlink(external, path);
    await assert.rejects(manager.archive("linked"), /real allowlisted file/);
    assert.equal(await readFile(external, "utf8"), content);
    await rm(path);
    await writeFile(path, "{partial json");
    await assert.rejects(manager.archive("linked"), /invalid session/);
    await rm(directory, { recursive: true });
    const externalDirectory = join(value.root, "external-sessions");
    await mkdir(externalDirectory);
    await writeFile(join(externalDirectory, "linked.jsonl"), content);
    await symlink(externalDirectory, directory, "dir");
    await assert.rejects(manager.archive("linked"), /real allowlisted directory/);
    assert.equal(await readFile(join(externalDirectory, "linked.jsonl"), "utf8"), content);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("corrected profile and archive state can be loaded again without restarting the host", async () => {
  const value = await fixture();
  const path = join(value.workspace, ".qi-agent", "sessions", "retry.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ type: "session/start", data: { session_id: "retry" } })}\n`);
  const worker = new FakeWorker({}, async (method, params) => {
    assert.equal(method, "session.archive");
    const target = String(params?.archive_path);
    await mkdir(dirname(target), { recursive: true });
    await rename(path, target);
    return { archived: true, session_path: target };
  });
  try {
    await writeFile(join(value.state, "session-profiles.json"), JSON.stringify({
      profiles: { [path]: "partially-loaded", bad: "INVALID!" },
    }));
    const manager = new SessionManager(value.registry, value.root, {}, () => worker);
    await assert.rejects(manager.listAll(), /invalid preset/);
    await writeFile(join(value.state, "session-profiles.json"), JSON.stringify({ profiles: {} }));
    assert.equal((await manager.listAll())[0].presetId, undefined);
    await writeFile(join(value.state, "session-archive-targets.json"), JSON.stringify({
      targets: { wrong: { workspaceId: value.workspaceId, path }, invalid: null },
    }));
    await assert.rejects(manager.archive("retry"), /invalid target/);
    await writeFile(join(value.state, "session-archive-targets.json"), JSON.stringify({ targets: {} }));
    assert.deepEqual(await manager.archive("retry"), { archived: true });
    const persisted = JSON.parse(await readFile(join(value.state, "session-archive-targets.json"), "utf8"));
    assert.deepEqual(Object.keys(persisted.targets), ["retry"]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("opening a previously listed session uses its indexed path without rescanning workspaces", async () => {
  const value = await fixture();
  const path = join(value.workspace, ".qi-agent", "sessions", "indexed.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ type: "session/start", data: { session_id: "indexed" } })}\n`);
  const worker = new FakeWorker({ session_id: "indexed" }, async () => ({}));
  try {
    const manager = new SessionManager(value.registry, value.root, {}, () => worker);
    await manager.listAll();
    const before = manager.catalog.statistics;
    const opened = await manager.open("indexed");
    assert.equal(opened.summary.id, "indexed");
    assert.equal(manager.catalog.statistics.directoryReads, before.directoryReads);
    assert.equal(manager.catalog.statistics.bytesRead, before.bytesRead);
    await manager.closeAll();
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("shutdown after archiving the last session uses a daemon control connection without hydrating it", async () => {
  const value = await fixture();
  const path = join(value.workspace, ".qi-agent", "sessions", "last.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ type: "session/start", data: { session_id: "last" } })}\n`);
  const calls: string[] = [];
  const workers: FakeWorker[] = [];
  const runtime = join(value.root, "runtime");
  const shutdownId = "00000000-0000-4000-8000-000000000001";
  const receiptPath = join(runtime, `shutdown-${shutdownId}.json`);
  await mkdir(runtime);
  try {
    const manager = new SessionManager(value.registry, value.root, { runtimeDirectory: runtime }, () => {
      const worker = new FakeWorker(new Error("Control must not hydrate a session"), async (method, params) => {
        calls.push(method);
        if (method === "session.archive") {
          const target = String(params?.archive_path);
          await mkdir(dirname(target), { recursive: true });
          await rename(path, target);
          return { archived: true, session_path: target };
        }
        if (method === "daemon.hello") return { capabilities: ["daemon.shutdown-preserve.v1"] };
        assert.equal(method, "daemon.shutdown");
        assert.deepEqual(params, { preserve_sessions: true });
        await writeFile(receiptPath, JSON.stringify({ schema_version: 1, shutdown_id: shutdownId,
          preserve_sessions: true, ok: true, errors: [] }));
        return { shutting_down: true, preserve_sessions: true, shutdown_id: shutdownId, receipt_path: receiptPath };
      });
      workers.push(worker);
      return worker;
    });
    await manager.shutdownDaemon();
    assert.equal(workers.length, 0, "A host that never used the daemon must not launch it on close");
    await manager.archive("last");
    await manager.shutdownDaemon();
    assert.deepEqual(calls, ["session.archive", "daemon.hello", "daemon.shutdown"]);
    assert.ok(workers.every((worker) => worker.closed));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("provider reload reports partial failures and retries only selected sessions", async () => {
  const value = await fixture();
  const calls: string[] = [];
  let fail = true;
  const directory = join(value.workspace, ".qi-agent", "sessions");
  await mkdir(directory, { recursive: true });
  for (const id of ["healthy", "failed"]) await writeFile(join(directory, `${id}.jsonl`),
    `${JSON.stringify({ type: "session/start", data: { session_id: id } })}\n`);
  const manager = new SessionManager(value.registry, value.root, {}, (_workspace, path) => {
    const id = path.endsWith("healthy.jsonl") ? "healthy" : "failed";
    return new FakeWorker({ session_id: id }, async (method) => {
      if (method === "provider.settings.reload") {
        calls.push(id);
        if (id === "failed" && fail) throw new Error("simulated reload timeout");
      }
      return {};
    });
  });
  try {
    await manager.open("healthy"); await manager.open("failed");
    const first = await manager.reloadProviderSettings();
    assert.deepEqual(first.applied, ["healthy"]);
    assert.equal(first.failures[0].sessionId, "failed");
    assert.match(first.failures[0].message, /timeout/);
    fail = false;
    const second = await manager.reloadProviderSettings(["failed"]);
    assert.deepEqual(second.applied, ["failed"]); assert.deepEqual(second.failures, []);
    assert.deepEqual(calls, ["healthy", "failed", "failed"]);
    assert.equal((await manager.reloadProviderSettings(["closed"])).failures[0].sessionId, "closed");
  } finally { await manager.closeAll(); await rm(value.root, { recursive: true, force: true }); }
});

for (const action of ["open", "create", "fork"] as const) {
  test(`workspace revocation invalidates a delayed ${action} even when the same path is added again`, async () => {
    const value = await fixture();
    const source = join(value.workspace,".qi-agent","sessions","source.jsonl");
    await mkdir(dirname(source), {recursive:true});
    await writeFile(source, JSON.stringify({type:"session/start",data:{session_id:"source"}})+"\n");
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const workers: FakeWorker[] = [];
    const manager = new SessionManager(value.registry,value.root,{}, (_workspace,path) => {
      const worker = new FakeWorker({session_id:path === source ? "source" : "new"}, async (method,params) => {
        if (method === "session.fork") {
          await writeFile(String(params?.destination), JSON.stringify({type:"session/start",data:{session_id:"new"}})+"\n");
          return {path:params?.destination,"session-id":"new"};
        }
        return {};
      });
      worker.start = async () => {
        if (action !== "fork" || path !== source) { entered(); await gate; }
        if (action === "create") await writeFile(path, JSON.stringify({type:"session/start",data:{session_id:"new"}})+"\n");
        return worker.startResult;
      };
      workers.push(worker); return worker;
    });
    try {
      const pending = action === "open" ? manager.open("source") : action === "create"
        ? manager.create(value.workspaceId) : manager.fork("source");
      const rejected = assert.rejects(pending,/revoked|allowlisted/);
      await started;
      await value.registry.remove(value.workspaceId);
      await assert.rejects(manager.create(value.workspaceId), /allowlisted|not found/i);
      await value.registry.add(value.workspace);
      release(); await rejected;
      assert.ok(workers.every(worker => worker.closed));
    } finally { release(); await manager.closeAll(); await rm(value.root,{recursive:true,force:true}); }
  });
}

test("cached workers cannot bypass revocation even if connection close fails", async () => {
  const value = await fixture();
  const source = join(value.workspace,".qi-agent","sessions","source.jsonl");
  await mkdir(dirname(source),{recursive:true});
  await writeFile(source,JSON.stringify({type:"session/start",data:{session_id:"source"}})+"\n");
  const worker = new FakeWorker({session_id:"source"},async()=>({}));
  worker.close = async () => { throw new Error("simulated close failure"); };
  const manager = new SessionManager(value.registry,value.root,{},()=>worker);
  try {
    await manager.open("source");
    await value.registry.remove(value.workspaceId);
    await assert.rejects(manager.worker("source"),/allowlisted|not found/i);
    assert.throws(() => (worker as any).authorize(), /revoked/);
  } finally { await manager.closeAll(); await rm(value.root,{recursive:true,force:true}); }
});

test("failed workspace persistence restores access through fresh connections only", async () => {
  const value = await fixture();
  const source = join(value.workspace,".qi-agent","sessions","source.jsonl");
  await mkdir(dirname(source),{recursive:true});
  await writeFile(source,JSON.stringify({type:"session/start",data:{session_id:"source"}})+"\n");
  const workers:FakeWorker[]=[];
  const manager=new SessionManager(value.registry,value.root,{},()=>{
    const worker=new FakeWorker({session_id:"source"},async()=>({})); workers.push(worker);return worker;
  });
  try {
    await manager.open("source");
    await rename(value.state,`${value.state}-saved`);
    await writeFile(value.state,"prevent state write");
    await assert.rejects(value.registry.remove(value.workspaceId));
    assert.equal(value.registry.get(value.workspaceId).id,value.workspaceId);
    assert.equal(workers[0].closed,true);
    assert.throws(()=>(workers[0] as any).authorize(),/revoked/);
    await rm(value.state);await rename(`${value.state}-saved`,value.state);
    await manager.open("source");
    assert.equal(workers.length,2);
    assert.equal(workers[1].closed,false);
  } finally {await manager.closeAll();await rm(value.root,{recursive:true,force:true});}
});
