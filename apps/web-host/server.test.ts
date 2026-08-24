import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWebHost } from "./server.js";
import { WorkspaceRegistry, workspaceId } from "./workspaces.js";

async function temporaryRoot() {
  return mkdtemp(join(tmpdir(), "bb-agent-web-test-"));
}

test("workspace registry persists canonical allowlisted roots", async () => {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  await mkdir(workspace);
  try {
    const registry = new WorkspaceRegistry(state);
    await registry.load(workspace);
    assert.equal(registry.list().length, 1);
    const canonical = registry.list()[0].path;
    assert.equal(registry.list()[0].id, workspaceId(canonical));
    const restored = new WorkspaceRegistry(state);
    await restored.load();
    assert.equal(restored.get(workspaceId(canonical)).path, canonical);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("web host authenticates, catalogs, creates a real worker, and invokes RPC", async () => {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const staticRoot = join(root, "static");
  await mkdir(workspace);
  await mkdir(staticRoot);
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>test</title>");
  const host = await startWebHost({
    port: 0,
    workspace,
    stateDirectory: state,
    staticRoot,
    token: "test-token",
  });
  const base = `http://${host.host}:${host.port}`;
  const authorization = { Authorization: "Bearer test-token" };
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/bootstrap`)).status, 401);
    const bootstrapResponse = await fetch(`${base}/api/bootstrap`, { headers: authorization });
    const bootstrap = await bootstrapResponse.json() as {
      ok: boolean;
      result: { activeWorkspaceId: string };
    };
    assert.equal(bootstrap.ok, true);
    assert.equal(JSON.stringify(bootstrap).includes("test-token"), false);

    const createResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ workspaceId: bootstrap.result.activeWorkspaceId, name: "E2E" }),
    });
    const created = await createResponse.json() as {
      result: {
        session: { id: string; name: string };
        snapshot: { cursor: { generation: number; sequence: number } };
      };
    };
    assert.equal(createResponse.status, 201, JSON.stringify(created));
    assert.equal(created.result.session.name, "E2E");
    assert.ok(created.result.snapshot.cursor.generation >= 1);
    assert.ok(created.result.snapshot.cursor.sequence >= 0);

    const rpcResponse = await fetch(
      `${base}/api/sessions/${created.result.session.id}/rpc`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ method: "turn.state", params: {} }),
      });
    const rpc = await rpcResponse.json() as { ok: boolean; result: { phase: string } };
    assert.equal(rpc.ok, true);
    assert.equal(rpc.result.phase, "idle");

    const forkResponse = await fetch(
      `${base}/api/sessions/${created.result.session.id}/fork`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ name: "E2E branch" }),
      });
    const forked = await forkResponse.json() as {
      result: {
        session: { id: string; name: string };
        snapshot: { cursor: { generation: number; sequence: number } };
      };
    };
    assert.equal(forkResponse.status, 201);
    assert.notEqual(forked.result.session.id, created.result.session.id);
    assert.equal(forked.result.session.name, "E2E branch");
    assert.ok(forked.result.snapshot.cursor.generation >= 1);

    const unsafeFork = await fetch(
      `${base}/api/sessions/${created.result.session.id}/rpc`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ method: "session.fork", params: { destination: "/tmp/not-allowed" } }),
      });
    assert.equal(unsafeFork.status, 400);

    const rejectedOrigin = await fetch(
      `${base}/api/sessions/${created.result.session.id}/rpc`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json", Origin: "https://example.com" },
        body: JSON.stringify({ method: "turn.state", params: {} }),
      });
    assert.equal(rejectedOrigin.status, 403);
  } finally {
    await host.close();
    await rm(root, { recursive: true });
  }
});
