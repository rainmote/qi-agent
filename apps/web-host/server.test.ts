import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWebHost } from "./server.js";
import { WorkspaceRegistry, workspaceId } from "./workspaces.js";

async function temporaryRoot() {
  return mkdtemp(join(tmpdir(), "bb-agent-web-test-"));
}

async function removeTemporaryRoot(root: string) {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    await removeTemporaryRoot(root);
  }
});

test("web host authenticates, catalogs, creates a real worker, and invokes RPC", async () => {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const staticRoot = join(root, "static");
  await mkdir(workspace);
  await mkdir(join(workspace, "visible-child"));
  await mkdir(join(workspace, ".hidden-child"));
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
    const ready = await fetch(`${base}/health/ready`);
    assert.equal(ready.status, 200, await ready.text());
    assert.equal((await fetch(`${base}/api/bootstrap`)).status, 401);
    const bootstrapResponse = await fetch(`${base}/api/bootstrap`, { headers: authorization });
    const bootstrap = await bootstrapResponse.json() as {
      ok: boolean;
      result: { activeWorkspaceId: string };
    };
    assert.equal(bootstrap.ok, true);
    assert.equal(JSON.stringify(bootstrap).includes("test-token"), false);

    const agentPresetsResponse = await fetch(`${base}/api/presets`, { headers: authorization });
    const agentPresets = await agentPresetsResponse.json() as {
      ok: boolean;
      result: Array<{ id: string; name: string; broken?: boolean }>;
    };
    assert.equal(agentPresetsResponse.status, 200, JSON.stringify(agentPresets));
    assert.deepEqual(agentPresets.result.map((preset) => preset.id), ["standard", "creator"]);
    assert.equal(agentPresets.result[1]?.name, "创造模式");
    assert.equal(JSON.stringify(agentPresets).includes("config_path"), false);
    assert.equal(JSON.stringify(agentPresets).includes("directory"), false);

    const providersResponse = await fetch(`${base}/api/providers`, { headers: authorization });
    const providers = await providersResponse.json() as {
      ok: boolean;
      result: { providers: Array<{ id: string; apiKeyConfigured: boolean; authType: string; authFile?: string }> };
    };
    assert.equal(providers.ok, true);
    assert.deepEqual(providers.result.providers.slice(0, 2).map((provider) => provider.id),
      ["deepseek", "openai"]);
    assert.equal(providers.result.providers.find((provider) => provider.id === "chatgpt")?.authType,
      "chatgpt-subscription");
    assert.equal(JSON.stringify(providers).includes("apiKey\""), false);
    assert.equal(JSON.stringify(providers).includes("access_token"), false);
    assert.equal(JSON.stringify(providers).includes("account_id"), false);

    const saveProviderResponse = await fetch(`${base}/api/providers`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({
        id: "web-test",
        name: "Web Test",
        protocol: "openai-completions",
        baseUrl: "https://gateway.example/v1",
        apiKey: "web-test-secret",
        models: [{ id: "web-test-chat", name: "Web Test Chat" }],
      }),
    });
    const savedProvider = await saveProviderResponse.json() as {
      ok: boolean;
      result: { id: string; apiKeyConfigured: boolean };
    };
    assert.equal(savedProvider.ok, true, JSON.stringify(savedProvider));
    assert.equal(savedProvider.result.apiKeyConfigured, true);
    assert.equal(JSON.stringify(savedProvider).includes("web-test-secret"), false);

    const directoriesResponse = await fetch(
      `${base}/api/directories?path=${encodeURIComponent(workspace)}`,
      { headers: authorization },
    );
    const directories = await directoriesResponse.json() as {
      ok: boolean;
      result: { path: string; directories: Array<{ name: string; path: string }> };
    };
    assert.equal(directories.ok, true);
    assert.deepEqual(directories.result.directories.map((entry) => entry.name), ["visible-child"]);

    const forbiddenConfigResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({
        workspaceId: bootstrap.result.activeWorkspaceId,
        presetId: "creator",
        configPath: "/tmp/untrusted-agent.edn",
      }),
    });
    assert.equal(forbiddenConfigResponse.status, 400);

    const emptyPresetResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({
        workspaceId: bootstrap.result.activeWorkspaceId,
        presetId: "",
      }),
    });
    assert.equal(emptyPresetResponse.status, 400);

    const underscorePresetResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({
        workspaceId: bootstrap.result.activeWorkspaceId,
        presetId: "invalid_mode",
      }),
    });
    assert.equal(underscorePresetResponse.status, 400);

    const unknownPresetResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({
        workspaceId: bootstrap.result.activeWorkspaceId,
        presetId: "missing-mode",
      }),
    });
    const unknownPreset = await unknownPresetResponse.json() as {
      error?: { data?: { type?: string } };
    };
    assert.equal(unknownPresetResponse.status, 400);
    assert.equal(unknownPreset.error?.data?.type, "unknown_preset");

    const createResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({
        workspaceId: bootstrap.result.activeWorkspaceId,
        name: "E2E",
        presetId: "creator",
      }),
    });
    const created = await createResponse.json() as {
      result: {
        session: { id: string; name: string; presetId: string };
        snapshot: { cursor: { generation: number; sequence: number } };
      };
    };
    assert.equal(createResponse.status, 201, JSON.stringify(created));
    assert.equal(created.result.session.name, "E2E");
    assert.equal(created.result.session.presetId, "creator");
    assert.ok(created.result.snapshot.cursor.generation >= 1);
    assert.ok(created.result.snapshot.cursor.sequence >= 0);

    const creatorCatalogResponse = await fetch(
      `${base}/api/sessions?workspace=${encodeURIComponent(bootstrap.result.activeWorkspaceId)}`,
      { headers: authorization },
    );
    const creatorCatalog = await creatorCatalogResponse.json() as {
      result: Array<{ id: string; presetId?: string }>;
    };
    assert.equal(
      creatorCatalog.result.find((session) => session.id === created.result.session.id)?.presetId,
      "creator",
    );

    const rpcResponse = await fetch(
      `${base}/api/sessions/${created.result.session.id}/rpc`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ method: "turn.state", params: {} }),
      });
    const rpc = await rpcResponse.json() as { ok: boolean; result: { phase: string } };
    assert.equal(rpc.ok, true);
    assert.equal(rpc.result.phase, "idle");

    const modelListResponse = await fetch(
      `${base}/api/sessions/${created.result.session.id}/rpc`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ method: "model.list", params: {} }),
      });
    const modelList = await modelListResponse.json() as {
      ok: boolean;
      result: { providers: Array<{ id: string; model: string; "display-name"?: string }> };
    };
    assert.equal(modelList.ok, true, JSON.stringify(modelList));
    assert.equal(modelList.result.providers.some((provider) => provider.id === "web-test"
      && provider.model === "web-test-chat" && provider["display-name"] === "Web Test Chat"), true);

    const policyStatusResponse = await fetch(
      `${base}/api/sessions/${created.result.session.id}/rpc`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ method: "policy.status", params: {} }),
      });
    const policyStatus = await policyStatusResponse.json() as {
      ok: boolean;
      result: { mode: string; modes: Array<{ id: string; label: string }> };
    };
    assert.equal(policyStatus.ok, true, JSON.stringify(policyStatus));
    assert.ok(["deny", "ask", "allow"].includes(policyStatus.result.mode));
    assert.deepEqual(policyStatus.result.modes.map((mode) => mode.id), ["deny", "ask", "allow"]);

    const policySelectResponse = await fetch(
      `${base}/api/sessions/${created.result.session.id}/rpc`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ method: "policy.select", params: { mode: "ask" } }),
      });
    const policySelect = await policySelectResponse.json() as {
      ok: boolean;
      result: { mode: string };
    };
    assert.equal(policySelect.ok, true, JSON.stringify(policySelect));
    assert.equal(policySelect.result.mode, "ask");

    const forkResponse = await fetch(
      `${base}/api/sessions/${created.result.session.id}/fork`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ name: "E2E branch" }),
      });
    const forked = await forkResponse.json() as {
      result: {
        session: { id: string; name: string; presetId?: string };
        snapshot: { cursor: { generation: number; sequence: number } };
      };
    };
    assert.equal(forkResponse.status, 201);
    assert.notEqual(forked.result.session.id, created.result.session.id);
    assert.equal(forked.result.session.name, "E2E branch");
    assert.equal(forked.result.session.presetId, "creator");
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

    const archiveResponse = await fetch(
      `${base}/api/sessions/${forked.result.session.id}/archive`, {
        method: "POST",
        headers: { ...authorization, Origin: base },
      });
    const archived = await archiveResponse.json() as {
      ok: boolean;
      result: { archived: boolean };
    };
    assert.equal(archiveResponse.status, 200, JSON.stringify(archived));
    assert.equal(archived.result.archived, true);

    const catalogResponse = await fetch(
      `${base}/api/sessions?workspace=${encodeURIComponent(bootstrap.result.activeWorkspaceId)}`,
      { headers: authorization },
    );
    const catalog = await catalogResponse.json() as {
      result: Array<{ id: string }>;
    };
    assert.equal(catalog.result.some((session) => session.id === forked.result.session.id), false);
  } finally {
    await host.close();
    await removeTemporaryRoot(root);
  }
});

test("web host rejects network exposure unless it is explicitly acknowledged", async () => {
  await assert.rejects(
    startWebHost({ host: "0.0.0.0", port: 0 }),
    /Refusing a non-loopback Web Host/,
  );
});

test("web host increments the port until one is available", async () => {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const staticRoot = join(root, "static");
  await mkdir(workspace);
  await mkdir(staticRoot);
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>test</title>");

  const occupied = createServer((_request, response) => response.end("occupied"));
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  const occupiedPort = address.port;

  let host: Awaited<ReturnType<typeof startWebHost>> | undefined;
  try {
    host = await startWebHost({
      port: occupiedPort,
      workspace,
      stateDirectory: state,
      staticRoot,
      token: "test-token",
    });
    assert.ok(host.port > occupiedPort);
    assert.equal((await fetch(`http://${host.host}:${host.port}/health`)).status, 200);
  } finally {
    if (host) await host.close();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await removeTemporaryRoot(root);
  }
});
