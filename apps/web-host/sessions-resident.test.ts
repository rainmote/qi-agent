import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SessionManager } from "./sessions.js";
import { WorkspaceRegistry } from "./workspaces.js";

async function fixture(created: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qi-resident-title-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const registry = new WorkspaceRegistry(join(root, "state"));
  await registry.load(workspace);
  const workspaceId = registry.list()[0].id;
  let path = join(workspace, ".qi-agent", "sessions", "resident.jsonl");
  const seed = JSON.stringify({ type: "session/start", at: "2026-10-29T00:00:00Z", data: { session_id: "resident" } }) + "\n";
  if (!created) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, seed); }
  let starts = 0;
  const worker = Object.assign(new EventEmitter(), {
    async start() { starts++; if (created) await writeFile(path, seed); return { session_id: "resident" }; },
    async call() { return {}; },
    async close() {},
  });
  const manager = new SessionManager(registry, root, {}, (_workspace, destination) => { path = destination; return worker; });
  const first = created ? await manager.create(workspaceId, undefined, "creator") : await manager.open("resident");
  return { root, registry, workspaceId, manager, first, worker, starts: () => starts,
    append: (events: unknown[]) => appendFile(path, events.map(event => JSON.stringify(event) + "\n").join("")),
    async close() { await manager.closeAll(); await rm(root, { recursive: true, force: true }); } };
}

for (const created of [true, false]) {
  test(`resident ${created ? "created" : "recovered"} session refreshes durable metadata without restarting`, async () => {
    const f = await fixture(created);
    try {
      for (const [index, name] of ["自动生成的标题", "用户更改的标题"].entries()) {
        const at = `2026-10-29T00:00:0${index + 1}Z`;
        await f.append([
          { type: "message", at, data: { role: "assistant", content: "done" } },
          { type: "session/name", at, data: { name } },
          { type: "session/label", at, data: { label: `label-${index}` } },
        ]);
        assert.equal((await f.manager.list(f.registry.list()[0]))[0].name, name);
        const opened = await f.manager.open("resident");
        assert.equal(opened.summary.name, name, "resident reopen must return the persisted title");
        assert.equal(opened.summary.label, `label-${index}`);
        assert.equal(opened.summary.messageCount, index + 1);
        assert.equal(opened.summary.eventCount, 1 + 3 * (index + 1));
        assert.equal(opened.summary.updatedAt, at);
        assert.equal(opened.summary.presetId, created ? "creator" : undefined);
        assert.equal(opened.worker, f.first.worker);
        assert.equal(f.starts(), 1);
      }
    } finally { await f.close(); }
  });
}

test("resident metadata refresh rechecks access after asynchronous catalog read", async () => {
  const f = await fixture(false);
  try {
    const describe = f.manager.catalog.describe.bind(f.manager.catalog);
    f.manager.catalog.describe = async (...args) => {
      const summary = await describe(...args);
      await f.registry.remove(f.workspaceId);
      return summary;
    };
    await assert.rejects(f.manager.open("resident"), /revoked|allowlisted/i);
  } finally { await f.close(); }
});

test("resident reopen rejects replaced transcript identity", async () => {
  const f = await fixture(false);
  try {
    await writeFile(f.first.summary.path, JSON.stringify({ type: "session/start", data: { session_id: "replacement" } }) + "\n");
    await assert.rejects(f.manager.open("resident"), /identity changed/i);
  } finally { await f.close(); }
});
