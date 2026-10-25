import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { startWebHost as startHost } from "./server.js";
import { WorkspaceRegistry, workspaceId } from "./workspaces.js";
import type { AgentWorker } from "./worker.js";
import type { EventReplay, HostEvent } from "./types.js";

// Tests never consult the developer's subscription login.
const startWebHost = (options: Parameters<typeof startHost>[0] = {}) => startHost({
  codexAuthFile: join(options.stateDirectory || tmpdir(), "fixture-only-missing-codex-auth.json"), ...options,
});

async function temporaryRoot() {
  return mkdtemp(join(tmpdir(), "qi-agent-web-test-"));
}

async function removeTemporaryRoot(root: string) {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

class StreamWorker extends EventEmitter {
  workspaceRoot = "";
  epoch = "first";
  sequence = 0;
  released = 0;
  snapshotCalls = 0;
  replay: EventReplay = { reset: "initial", events: [] };
  snapshot: () => Promise<unknown> = async () => ({ events: [], state: { revision: 0 } });

  get eventCursor() { return `${this.epoch}:${this.sequence}`; }
  replayAfter() { return this.replay; }
  subscribeClient() { return () => { this.released += 1; }; }
  async call() { this.snapshotCalls += 1; return this.snapshot(); }
  push(event: Partial<HostEvent>) {
    const value = { type: "event", version: 1, ...event,
      hostEpoch: this.epoch, hostSeq: ++this.sequence } as HostEvent;
    this.emit("event", value);
    return value;
  }
}

async function streamFixture() {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const host = await startWebHost({ port: 0, workspace,
    stateDirectory: join(root, "state"), token: "stream-test" });
  const worker = new StreamWorker();
  worker.workspaceRoot = host.workspaces.list()[0].path;
  host.sessions.worker = async () => worker as unknown as AgentWorker;
  return { host, worker, base: `http://127.0.0.1:${host.port}`, close: async () => {
    await host.close();
    await removeTemporaryRoot(root);
  } };
}

async function eventStream(base: string, cursor?: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/sessions/test/events`, {
    headers: { Authorization: "Bearer stream-test", ...(cursor ? { "Last-Event-ID": cursor } : {}) },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    abort: () => controller.abort(),
    next: async (): Promise<{ event: string; id?: string; data: any } | null> => {
      while (true) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = frame.match(/^event: (.+)$/m)?.[1];
          if (event) return { event, id: frame.match(/^id: (.+)$/m)?.[1],
            data: JSON.parse(frame.match(/^data: (.+)$/m)?.[1] || "null") };
          continue;
        }
        const next = await reader.read();
        if (next.done) return null;
        buffer += decoder.decode(next.value, { stream: true });
      }
    },
  };
}

test("web transport rejects malformed Host without terminating the server", { timeout: 5_000 }, async () => {
  const fixture = await streamFixture();
  try {
    for (const invalidHost of ["[", "localhost:invalid-port"]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(`${fixture.base}/health`, { headers: { Host: invalidHost } }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        });
        request.once("error", reject);
        request.end();
      });
      assert.equal(status, 400);
    }
    assert.equal((await fetch(`${fixture.base}/health`)).status, 200);
    assert.equal((await fetch(`${fixture.base}/api/bootstrap`)).status, 401);
  } finally { await fixture.close(); }
});

test("token bootstrap commits a protected same-origin document before using the Strict cookie", async () => {
  const fixture = await streamFixture();
  try {
    for (const path of ["/", "//outside.invalid/path", "/%3Cscript%3E"]) {
      const url = `${fixture.base}${path}?token=stream-test&return=https://outside.invalid/`;
      const response = await fetch(url, { redirect: "manual" });
      assert.equal(response.status, 200, "bootstrap must commit a document instead of a cross-site HTTP redirect");
      assert.equal(response.headers.get("location"), null);
      assert.match(response.headers.get("content-type") || "", /^text\/html/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      const cookie = response.headers.get("set-cookie") || "";
      assert.match(cookie, /^qi_agent_web=stream-test; HttpOnly; SameSite=Strict; Path=\/$/);
      const body = await response.text();
      assert.equal(body.includes("stream-test"), false, "token must not be reflected in the document");
      assert.equal(body.includes("outside.invalid"), false, "request parameters must not be reflected");
      const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      assert.equal(scripts.length, 1);
      const script = scripts[0][1];
      const digest = createHash("sha256").update(script).digest("base64");
      assert.equal(response.headers.get("content-security-policy"),
        `default-src 'none'; script-src 'sha256-${digest}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      let destination = "";
      runInNewContext(script, { URL, window: { location: { href: url, replace: (target: string) => { destination = target; } } } });
      const target = new URL(destination);
      assert.equal(target.origin, fixture.base);
      assert.equal(target.pathname, new URL(url).pathname);
      assert.equal(target.search, "");
      assert.equal(target.hash, "");
      assert.equal((await fetch(`${fixture.base}/api/bootstrap`, { headers: { Cookie: cookie.split(";")[0] } })).status, 200);
    }
    for (const path of ["/", "/?token=wrong", "/api/bootstrap?token=wrong"]) {
      const response = await fetch(`${fixture.base}${path}`);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("set-cookie"), null);
    }
    const foreign = await fetch(`${fixture.base}/api/workspaces`, {
      method: "POST", headers: { Cookie: "qi_agent_web=stream-test", Origin: "https://outside.invalid", "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp" }),
    });
    assert.equal(foreign.status, 403);
  } finally { await fixture.close(); }
});

test("web transport rejects archive destination overrides before opening a worker", { timeout: 5_000 }, async () => {
  const fixture = await streamFixture();
  let workerOpened = false;
  fixture.host.sessions.worker = async () => {
    workerOpened = true;
    throw new Error("archive RPC must not open a worker");
  };
  try {
    const response = await fetch(`${fixture.base}/api/sessions/test/rpc`, {
      method: "POST",
      headers: { Authorization: "Bearer stream-test", "Content-Type": "application/json", Origin: fixture.base },
      body: JSON.stringify({ method: "session.archive",
        params: { session_path: "/outside/session.jsonl", archive_path: "/outside/other.jsonl" } }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /archives are managed by the Web Host/);
    assert.equal(workerOpened, false);
  } finally { await fixture.close(); }
});

test("web transport installs one snapshot with only uncovered events during continuous updates", { timeout: 5_000 }, async () => {
  const fixture = await streamFixture();
  const worker = fixture.worker;
  worker.snapshot = async () => {
    worker.push({ durable: true, event_id: "included", event: "message", seq: 1 });
    worker.push({ durable: true, event_id: "new", event: "message", seq: 2 });
    for (let revision = 1; revision <= 100; revision += 1) {
      worker.push({ event: "agent/state", data: { revision, phase: "model", "partial-assistant": String(revision) } });
    }
    worker.push({ event: "interaction/request", data: { id: "old", revision: 4 } });
    worker.push({ event: "interaction/resolved", data: { id: "old", revision: 5 } });
    worker.push({ event: "interaction/request", data: { id: "new", revision: 6 } });
    worker.push({ event: "interaction/request", data: { id: "newer-high", revision: 8 } });
    worker.push({ event: "interaction/request", data: { id: "newer-low", revision: 7 } });
    return { events: [{ id: "included", seq: 1 }],
      state: { revision: 50, phase: "model", "partial-assistant": "50" },
      interactions: [], interactions_revision: 5 };
  };
  try {
    const stream = await eventStream(fixture.base);
    const initial = await stream.next();
    assert.equal(initial?.event, "snapshot");
    assert.equal(initial?.id, "first:107");
    assert.equal(initial?.data.reason, "initial");
    assert.equal(initial?.data.warning, undefined);
    const events = initial!.data.events as HostEvent[];
    assert.equal(events.length, 54);
    assert.equal(events[0].event_id, "new");
    assert.deepEqual(events.filter((event) => event.event === "agent/state")
      .map((event) => event.data?.revision), Array.from({ length: 50 }, (_, index) => index + 51));
    assert.deepEqual(events.filter((event) => event.event?.startsWith("interaction/"))
      .map((event) => event.data?.id), ["new", "newer-high", "newer-low"]);
    assert.equal(worker.snapshotCalls, 1);
    assert.equal((await stream.next())?.event, "ready");
    worker.push({ event: "agent/state", data: { revision: 49 } });
    worker.push({ event: "interaction/request", data: { id: "late-old", revision: 4 } });
    worker.push({ event: "agent/state", data: { revision: 101 } });
    const live = await stream.next();
    assert.equal(live?.event, "worker");
    assert.equal(live?.id, "first:110");
    assert.equal(live?.data.data.revision, 101);
    worker.emit("exit");
    assert.equal(await stream.next(), null);
    assert.equal(worker.released, 1);
    for (const name of ["event", "exit", "reset"]) assert.equal(worker.listenerCount(name), 0);
  } finally { await fixture.close(); }
});

test("web transport replays a continuous cursor and resnapshots buffer gaps and generations", { timeout: 5_000 }, async () => {
  const fixture = await streamFixture();
  const worker = fixture.worker;
  try {
    const retained = worker.push({ durable: true, event_id: "retained", seq: 1 });
    worker.replay = { reset: null, events: [retained] };
    let stream = await eventStream(fixture.base, "first:0");
    assert.equal((await stream.next())?.data.event_id, "retained");
    assert.equal((await stream.next())?.event, "ready");
    assert.equal(worker.snapshotCalls, 0);
    worker.emit("reset");
    assert.equal(await stream.next(), null);
    for (const reason of ["buffer-gap", "generation"] as const) {
      worker.replay = { reset: reason, events: [] };
      worker.epoch = reason;
      stream = await eventStream(fixture.base, "first:1");
      const snapshot = await stream.next();
      assert.equal(snapshot?.event, "snapshot");
      assert.equal(snapshot?.data.reason, reason);
      assert.equal(snapshot?.id, `${reason}:1`);
      assert.equal((await stream.next())?.event, "ready");
      worker.emit("exit");
      assert.equal(await stream.next(), null);
    }
    assert.equal(worker.snapshotCalls, 2);
    assert.equal(worker.released, 3);
  } finally { await fixture.close(); }
});

test("web transport cleans subscriptions when a worker exits during snapshot capture", { timeout: 5_000 }, async () => {
  const fixture = await streamFixture();
  let finish!: (snapshot: unknown) => void;
  fixture.worker.snapshot = () => new Promise((resolve) => { finish = resolve; });
  try {
    const stream = await eventStream(fixture.base);
    fixture.worker.emit("exit");
    assert.equal(await stream.next(), null);
    assert.equal(fixture.worker.released, 1);
    for (const name of ["event", "exit", "reset"]) assert.equal(fixture.worker.listenerCount(name), 0);
    finish({ events: [], state: {} });
  } finally { await fixture.close(); }
});

test("web transport cleans subscriptions on browser abort and snapshot failure", { timeout: 5_000 }, async () => {
  const fixture = await streamFixture();
  let finish!: (snapshot: unknown) => void;
  fixture.worker.snapshot = () => new Promise((resolve) => { finish = resolve; });
  try {
    const stream = await eventStream(fixture.base);
    stream.abort();
    for (let attempt = 0; fixture.worker.released === 0 && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(fixture.worker.released, 1);
    for (const name of ["event", "exit", "reset"]) assert.equal(fixture.worker.listenerCount(name), 0);
    finish({ events: [], state: {} });
    fixture.worker.snapshot = async () => { throw new Error("snapshot unavailable"); };
    const failed = await eventStream(fixture.base);
    assert.equal(await failed.next(), null);
    assert.equal(fixture.worker.released, 2);
    for (const name of ["event", "exit", "reset"]) assert.equal(fixture.worker.listenerCount(name), 0);
  } finally { await fixture.close(); }
});

test("web transport exposes a warning for legacy snapshot state without revisions", { timeout: 5_000 }, async () => {
  const fixture = await streamFixture();
  fixture.worker.snapshot = async () => {
    fixture.worker.push({ event: "agent/state", data: { phase: "model" } });
    return { events: [], state: { phase: "idle" } };
  };
  try {
    const stream = await eventStream(fixture.base);
    const snapshot = await stream.next();
    assert.match(snapshot?.data.warning, /重启运行时/);
    fixture.worker.emit("exit");
    await stream.next();
    assert.equal(await stream.next(), null);
  } finally { await fixture.close(); }
});

test("workspace registry persists canonical allowlisted roots", async () => {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  await mkdir(workspace);
  await mkdir(state, { mode: 0o755 });
  try {
    const registry = new WorkspaceRegistry(state);
    await registry.load(workspace);
    assert.equal(registry.list().length, 1);
    const canonical = registry.list()[0].path;
    assert.equal(registry.list()[0].id, workspaceId(canonical));
    if (process.platform !== "win32") {
      assert.equal((await stat(state)).mode & 0o777, 0o700);
      assert.equal((await stat(registry.statePath)).mode & 0o777, 0o600);
    }

    const additional = Array.from({ length: 8 }, (_, index) =>
      join(root, `workspace-${index}`));
    await Promise.all(additional.map((path) => mkdir(path)));
    await Promise.all(additional.map((path) => registry.add(path)));
    assert.equal(registry.list().length, additional.length + 1);
    const persisted = JSON.parse(await readFile(registry.statePath, "utf8")) as {
      workspaces: Array<{ path: string }>;
    };
    assert.equal(persisted.workspaces.length, additional.length + 1);
    assert.deepEqual((await readdir(state)).filter((name) => name.endsWith(".tmp")), []);

    const restored = new WorkspaceRegistry(state);
    await restored.load();
    assert.equal(restored.get(workspaceId(canonical)).path, canonical);
    assert.equal(restored.list().length, additional.length + 1);
  } finally {
    await removeTemporaryRoot(root);
  }
});

test("workspace registry rejects a symbolic-link state directory", async () => {
  const root = await temporaryRoot();
  const target = join(root, "real-state");
  const linked = join(root, "linked-state");
  await mkdir(target);
  await symlink(target, linked, "dir");
  try {
    await assert.rejects(new WorkspaceRegistry(linked).load(),
      /must be a real directory/);
  } finally {
    await removeTemporaryRoot(root);
  }
});

test("computer-use preset opens a real worker with explicit connection controls", async () => {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const host = await startWebHost({ port: 0, workspace,
    stateDirectory: join(root, "state"), token: "computer-preset-test" });
  const base = `http://${host.host}:${host.port}`;
  const headers = { Authorization: "Bearer computer-preset-test",
    "Content-Type": "application/json", Origin: base };
  try {
    const response = await fetch(`${base}/api/sessions`, { method: "POST", headers,
      body: JSON.stringify({ workspaceId: host.workspaces.list()[0].id, presetId: "computer-use" }) });
    const created = await response.json();
    assert.equal(response.status, 201, JSON.stringify(created));
    assert.equal(created.result.session.presetId, "computer-use");
    const rpc = await fetch(`${base}/api/sessions/${created.result.session.id}/rpc`, {
      method: "POST", headers, body: JSON.stringify({ method: "runtime.status", params: {} }),
    });
    const status = await rpc.json();
    assert.equal(status.ok, true, JSON.stringify(status));
    const computer = status.result["computer-use"];
    assert.equal(computer["configured-provider"], "lcu");
    assert.equal(computer.enabled, true);
    assert.equal(computer.connected, false);
    assert.equal(computer["local-desktop"], true);
    assert.equal(computer["image-model"], true);
    assert.deepEqual(computer.tools, []);
    assert.deepEqual(computer.capabilities.surfaces, ["computer"]);
    assert.ok(status.result.commands.some((command: { name: string }) => command.name === "computer"));
  } finally {
    await host.close();
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
    assert.deepEqual(agentPresets.result.map((preset) => preset.id), ["standard", "creator", "production", "computer-use"]);
    assert.equal(agentPresets.result[1]?.name, "创造模式");
    assert.equal(agentPresets.result[3]?.name, "电脑操作");
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
      result: { providers: Array<{ id: string; model: string; "display-name"?: string; "settings-provider-id"?: string }> };
    };
    assert.equal(modelList.ok, true, JSON.stringify(modelList));
    assert.equal(modelList.result.providers.some((provider) => provider["settings-provider-id"] === "web-test"
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

test("network-exposed web host accepts an HTTPS proxy origin and secures its cookie", async () => {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const staticRoot = join(root, "static");
  await mkdir(workspace);
  await mkdir(staticRoot);
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>test</title>");
  const host = await startWebHost({
    host: "0.0.0.0",
    port: 0,
    workspace,
    stateDirectory: state,
    staticRoot,
    token: "proxy-test-token",
    unsafeAllowNetwork: true,
  });
  const base = `http://127.0.0.1:${host.port}`;
  const proxyHeaders = {
    Authorization: "Bearer proxy-test-token",
    "X-Forwarded-Host": "agent.example.test",
    Origin: "https://agent.example.test",
  };
  try {
    const cookie = await fetch(`${base}/?token=proxy-test-token`, {
      headers: { "X-Forwarded-Host": proxyHeaders["X-Forwarded-Host"] },
      redirect: "manual",
    });
    assert.equal(cookie.status, 200);
    assert.match(cookie.headers.get("set-cookie") || "", /; Secure$/);

    const accepted = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { ...proxyHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ path: workspace }),
    });
    assert.equal(accepted.status, 201, await accepted.text());

    const rejected = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { ...proxyHeaders, Origin: "https://other.example.test",
        "Content-Type": "application/json" },
      body: JSON.stringify({ path: workspace }),
    });
    assert.equal(rejected.status, 403);
  } finally {
    await host.close();
    await removeTemporaryRoot(root);
  }
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

test("provider save exposes reload failures and retry does not resave credentials", async () => {
  const fixture = await streamFixture();
  const calls: Array<readonly string[] | undefined> = [];
  fixture.host.sessions.reloadProviderSettings = async (ids) => {
    calls.push(ids);
    return { scope: "open-web-sessions", applied: ids ? ["failed"] : [], failures: ids ? []
      : [{ sessionId: "failed", sessionName: "Example", message: "reload timed out" }] };
  };
  const post = (path: string, body: unknown) => fetch(`${fixture.base}${path}`, {
    method: "POST", headers: { Authorization: "Bearer stream-test", "Content-Type": "application/json", Origin: fixture.base },
    body: JSON.stringify(body),
  });
  try {
    const saved = await (await post("/api/providers", { id: "reload-test", name: "Reload Test",
      protocol: "openai-completions", baseUrl: "https://example.invalid/v1", apiKey: "test-only-key",
      models: [{ id: "test", name: "Test" }] })).json();
    assert.equal(saved.ok, true); assert.equal(saved.result.reload.failures.length, 1);
    assert.equal(JSON.stringify(saved).includes("test-only-key"), false);
    const retried = await (await post("/api/providers/reload", { sessionIds: ["failed"] })).json();
    assert.deepEqual(retried.result.applied, ["failed"]);
    assert.deepEqual(calls, [undefined, ["failed"]]);
    assert.equal((await post("/api/providers/reload", { sessionIds: "invalid" })).status, 400);
  } finally { await fixture.close(); }
});

test("RPC errors retain uncertain outcomes and the caller's command identity", async () => {
  const fixture = await streamFixture();
  try {
    fixture.worker.call = async (...args: unknown[]) => {
      assert.deepEqual(args,["turn.submit",{message:"once"},30000,"browser-original-id"]);
      throw Object.assign(new Error("transport timeout"),{data:{status:"uncertain",command_id:"browser-original-id"}});
    };
    const response = await fetch(`${fixture.base}/api/sessions/test/rpc`,{
      method:"POST",headers:{Authorization:"Bearer stream-test","Content-Type":"application/json"},
      body:JSON.stringify({method:"turn.submit",params:{message:"once"},commandId:"browser-original-id"}),
    });
    const error = await response.json() as any;
    assert.equal(response.status,400);
    assert.deepEqual(error.error.data,{status:"uncertain",command_id:"browser-original-id"});
    fixture.host.sessions.commandStatus = async (id,commandId) => {
      assert.equal(id,"test");assert.equal(commandId,"browser-original-id");return {status:"pending"};
    };
    const queried = await fetch(`${fixture.base}/api/sessions/test/operations/browser-original-id`,{
      headers:{Authorization:"Bearer stream-test"},
    });
    assert.equal((await queried.json() as any).result.status,"pending");
  } finally {await fixture.close();}
});

test("an opening snapshot cursor avoids SSE snapshots and Last-Event-ID takes precedence", async () => {
  const fixture = await streamFixture();
  let seen: string | null | undefined;
  fixture.worker.replayAfter = (cursor?: string | null) => {seen=cursor;return {reset:null,events:[]};};
  try {
    for (const last of [undefined,"new:7"]) {
      const abort = new AbortController();
      const response = await fetch(`${fixture.base}/api/sessions/test/events?after=opening%3A0`,{
        headers:{Authorization:"Bearer stream-test",...(last ? {"Last-Event-ID":last} : {})},signal:abort.signal,
      });
      await response.body!.getReader().read();
      assert.equal(seen,last || "opening:0");
      assert.equal(fixture.worker.snapshotCalls,0);
      abort.abort();
    }
  } finally {await fixture.close();}
});

test("subscription refresh persists catalog and reports worker reload and discovery failures independently", async () => {
  const root = await temporaryRoot(), originalFetch = globalThis.fetch;
  const workspace = join(root, "workspace"), authFile = join(root, "fixture-codex-auth.json");
  await mkdir(workspace);
  await writeFile(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: {
    access_token: "fixture-only-token", account_id: "fixture-only-account" } }), { mode: 0o600 });
  let requests = 0, unavailable = false, host: Awaited<ReturnType<typeof startWebHost>> | undefined;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://chatgpt.com/")) {
      requests++;
      assert.equal(String(url), "https://chatgpt.com/backend-api/codex/models?client_version=0.163.0");
      if (unavailable) return new Response("private diagnostic", { status: 503 });
      return Response.json({ models: [{ slug: `fixture-model-${requests}`, display_name: "Fixture",
        visibility: "list", context_window: 500000, supported_reasoning_levels: [{ effort: "low" }], default_reasoning_level: "low" }] });
    }
    return originalFetch(url, options);
  };
  try {
    host = await startWebHost({ port: 0, workspace, codexAuthFile: authFile,
      stateDirectory: join(root, "state"), token: "fixture-auth" });
    assert.equal(requests, 1, "startup discovers the signed-in account catalog");
    let reloads = 0;
    host.sessions.reloadProviderSettings = async () => { reloads++; return { scope: "open-web-sessions", applied: [],
      failures: [{ sessionId: "failed-worker", sessionName: "Fixture worker", message: "fixture reload timeout" }] }; };
    const url = `http://127.0.0.1:${host.port}/api/providers/chatgpt/refresh`;
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    assert.equal(requests, 1, "unauthenticated callers cannot refresh the subscription");
    const post = () => fetch(url, { method: "POST", headers: { Authorization: "Bearer fixture-auth", "Content-Type": "application/json" }, body: "{}" });
    const result = await (await post()).json() as any;
    assert.equal(result.ok, true); assert.equal(result.result.models[0].id, "fixture-model-2");
    assert.equal(result.result.reload.failures[0].sessionId, "failed-worker"); assert.equal(reloads, 1);
    unavailable = true;
    const failed = await (await post()).json() as any;
    assert.equal(failed.ok, true); assert.match(failed.result.modelCatalogError, /HTTP 503/);
    assert.equal(failed.result.models[0].id, "fixture-model-2"); assert.equal(reloads, 2);
    assert.doesNotMatch(JSON.stringify(failed), /fixture-only-token|fixture-only-account|private diagnostic/);
  } finally { globalThis.fetch = originalFetch; await host?.close(); await removeTemporaryRoot(root); }
});
