import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWebHost } from "./server.js";
import type { AgentWorker } from "./worker.js";
import { referencesIn, resolveReferences } from "./workspace-references.js";
import { snapshotTurnId } from "./turn-files.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qi-files-http-")), workspace = join(root, "workspace"); await mkdir(workspace);
  const host = await startWebHost({ port: 0, token: "fixture", workspace, stateDirectory: join(root, "state") });
  const id = host.workspaces.list()[0].id, base = `http://127.0.0.1:${host.port}`;
  const request = (path: string, input?: unknown) => fetch(`${base}${path}`, { method: input === undefined ? "GET" : "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  return { root, workspace, host, id, base, request, close: async () => { await host.close(); await rm(root, { recursive: true, force: true }); } };
}

test("authenticated HTTP uploads have a dedicated 12 MiB bound and safe download headers", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.base}/api/workspaces/${f.id}/files`)).status, 401);
    const uploaded = await f.request(`/api/workspaces/${f.id}/attachments`, { name: "large.txt", mime: "text/html", base64: Buffer.alloc(1_100_000, 97).toString("base64") });
    assert.equal(uploaded.status, 201);
    const reference = (await uploaded.json()).result;
    assert.equal(reference.mime, "text/plain");
    const download = await f.request(`/api/workspaces/${f.id}/attachments/${reference.id}`);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.match(download.headers.get("content-disposition")!, /^attachment/);
    assert.match(download.headers.get("content-security-policy")!, /sandbox/);
    assert.equal((await download.arrayBuffer()).byteLength, 1_100_000);
    assert.equal((await f.request(`/api/workspaces/${f.id}/resolve-references`, { message: "x".repeat(1_100_000) })).status, 400);
    assert.equal((await f.request(`/api/workspaces/${f.id}/attachments`, { name: "a.txt", mime: "text/plain", base64: "A".repeat(13 * 1024 * 1024) })).status, 400);
    await f.host.workspaces.remove(f.id);
    assert.equal((await f.request(`/api/workspaces/${f.id}/attachments/${reference.id}`)).status, 400);
  } finally { await f.close(); }
});

test("file references quote actual bounded content and session references enforce workspace eligibility", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "note.md"), "# fixture source\nOnly this workspace.");
    const resolved = await f.request(`/api/workspaces/${f.id}/resolve-references`, { message: 'Inspect @file:"note.md"' });
    assert.match((await resolved.json()).result, /fixture source/);
    assert.equal((await f.request(`/api/workspaces/${f.id}/resolve-references`, { message: 'Inspect @file:"../outside.txt"' })).status, 400);
    assert.equal((await f.request(`/api/workspaces/${f.id}/resolve-references`, { message: 'Inspect @session:"not-in-this-workspace"' })).status, 400);
    const directory = join(f.workspace, ".qi-agent", "sessions"); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "fixture.jsonl"), [{ type: "session/start", data: { session_id: "fixture-history" } },
      { type: "message", data: { message: { role: "assistant", content: "read history without starting a worker" } } }].map(value => JSON.stringify(value)).join("\n"));
    f.host.sessions.worker = async () => { throw new Error("History references must not start a worker"); };
    const history = await f.request(`/api/workspaces/${f.id}/resolve-references`, { message: 'Inspect @session:"fixture-history"' });
    assert.equal(history.status, 200); assert.match((await history.json()).result, /without starting a worker/);
    assert.equal(referencesIn('@file:"note.md" @file:"note.md"').length, 1);
    const excerpt = await resolveReferences(f.host.files, f.id, '@session:"fixture-session"', async () => ({ events: [{ type: "message", data: { message: { role: "assistant", content: "real fixture answer" } } }] }));
    assert.match(excerpt, /real fixture answer/);
    assert.throws(() => referencesIn(Array.from({ length: 5 }, (_, i) => `@file:"${i}"`).join(" ")), /最多/);
  } finally { await f.close(); }
});

test("real RPC route brackets accepted turns with snapshots and resolves latest changes after restart", async () => {
  const f = await fixture();
  try {
    const root = await realpath(f.workspace); await writeFile(join(root, "note.txt"), "before");
    let released = 0;
    const worker = new EventEmitter() as EventEmitter & { workspaceRoot: string; subscribeClient: () => () => void; call: (...args: any[]) => Promise<unknown> };
    worker.workspaceRoot = root; worker.subscribeClient = () => () => { released++; };
    worker.call = async (method, params) => {
      if (method === "turn.submit") {
        await writeFile(join(root, "note.txt"), "after");
        worker.emit("event", { type: "event", event: "remote/run-result", data: { request_id: "daemon-selected-id", ok: true, result: { aborted: true } } });
      }
      return { accepted: true, request_id: "daemon-selected-id" };
    };
    f.host.sessions.worker = async () => worker as unknown as AgentWorker;
    const result = await f.request("/api/sessions/fixture-session/rpc", { method: "turn.submit", params: { message: "fixture only" }, commandId: "fixture-command-1" });
    assert.equal(result.status, 200);
    let changes: any;
    for (let i = 0; i < 100; i++) {
      changes = await f.host.files.sessionChanges(f.id, "fixture-session");
      if (changes) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(changes.turnId, snapshotTurnId("fixture-session", "fixture-command-1")); assert.equal(changes.partial, true);
    assert.match(changes.files[0].diff, /-before\n\+after/); assert.equal(released, 1);
    const { WorkspaceFiles } = await import("./workspace-files.js");
    const restarted = new WorkspaceFiles(f.host.workspaces);
    assert.deepEqual(await restarted.sessionChanges(f.id, "fixture-session"), changes);
    assert.equal((await f.request("/api/sessions/fixture-session/rpc", { method: "automation.resolve", params: {} })).status, 400);
  } finally { await f.close(); }
});
