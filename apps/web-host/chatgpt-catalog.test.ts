import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchChatGptModels, parseChatGptModels, readChatGptLogin } from "./chatgpt-catalog.js";
import { ProviderRegistry } from "./providers.js";

const fixtureModels = { models: [
  { slug: "fixture-second", display_name: "Second", visibility: "list", priority: 2, context_window: 272000,
    supported_in_api: false, supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }, { effort: "ultra" }], default_reasoning_level: "low" },
  { slug: "fixture-hidden", visibility: "hide", priority: 0 },
  { slug: "fixture-first", display_name: "First", visibility: "list", priority: 1, context_window: 500000, max_context_window: 872000,
    supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }], default_reasoning_level: "medium" },
] };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "qi-chatgpt-catalog-")), authFile = join(root, "auth.json");
  const login = (account = "fixture-account-a", token = "fixture-token") => writeFile(authFile,
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token, account_id: account } }), { mode: 0o600 });
  await login();
  const registry = new ProviderRegistry(join(root, "state"), { codexAuthFile: authFile });
  await registry.load();
  return { root, authFile, registry, login };
}

test("subscription discovery uses visible account catalog, exact metadata and canonical credentials", async () => {
  const { root, registry } = await setup(), previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  try {
    globalThis.fetch = async (url, options) => { requests.push({ url: String(url), options }); return Response.json(fixtureModels); };
    const models = await registry.discover({ providerId: "chatgpt" });
    assert.deepEqual(models, [
      { id: "fixture-first", name: "First", contextWindow: 500000, thinkingLevels: ["low", "medium"], defaultThinkingLevel: "medium" },
      { id: "fixture-second", name: "Second", contextWindow: 272000, thinkingLevels: ["low", "xhigh"], defaultThinkingLevel: "low" },
    ]);
    assert.equal(requests[0].url, "https://chatgpt.com/backend-api/codex/models?client_version=0.163.0");
    const headers = new Headers(requests[0].options?.headers);
    assert.equal(headers.get("authorization"), "Bearer fixture-token");
    assert.equal(headers.get("chatgpt-account-id"), "fixture-account-a");
    assert.equal(requests[0].options?.redirect, "error");
    await assert.rejects(registry.discover({ providerId: "chatgpt", baseUrl: "https://example.invalid" }), /官方/);
    await assert.rejects(registry.discover({ providerId: "chatgpt", apiKey: "browser-key" }), /官方/);
    assert.equal(requests.length, 1);
  } finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});

test("catalog persists privately, refresh failure retains same-account models, account changes clear them", async () => {
  const { root, registry, authFile, login } = await setup(), previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(fixtureModels);
    const first = await registry.refreshChatGptModels();
    assert.equal(first.models.length, 2); assert.equal(first.modelCatalogError, undefined);
    const bytes = await readFile(registry.statePath, "utf8");
    assert(!bytes.includes("fixture-token")); assert(!bytes.includes("fixture-account-a"));
    assert.match(JSON.parse(bytes).chatGptCatalogIdentity, /^[0-9a-f]{64}$/);
    const restarted = new ProviderRegistry(registry.stateDirectory, { codexAuthFile: authFile }); await restarted.load();
    assert.deepEqual((await restarted.list()).find(p => p.id === "chatgpt")?.models, first.models);
    globalThis.fetch = async () => new Response("private-response-must-not-leak", { status: 503 });
    const failed = await registry.refreshChatGptModels();
    assert.deepEqual(failed.models, first.models); assert.match(failed.modelCatalogError!, /HTTP 503/);
    assert(!JSON.stringify(failed).includes("private-response"));
    await login("fixture-account-b");
    assert.deepEqual((await registry.list()).find(p => p.id === "chatgpt")?.models, []);
    const switched = await registry.refreshChatGptModels();
    assert.deepEqual(switched.models, []); assert.match(switched.modelCatalogError!, /503/);
    assert.equal(JSON.parse(await readFile(registry.statePath, "utf8")).chatGptCatalogIdentity, undefined);
    globalThis.fetch = async () => Response.json(fixtureModels);
    const recovered = await registry.refreshChatGptModels();
    assert.equal(recovered.models.length, 2); assert.equal(recovered.modelCatalogError, undefined);
  } finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});

test("account or token changes while catalog GET is pending cannot publish stale results", async () => {
  const { root, registry, login } = await setup(), previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { await login("fixture-account-b"); return Response.json(fixtureModels); };
    const switched = await registry.refreshChatGptModels();
    assert.deepEqual(switched.models, []); assert.match(switched.modelCatalogError!, /登录已变化/);
    globalThis.fetch = async () => { await login("fixture-account-b", "fixture-refreshed-token"); return Response.json(fixtureModels); };
    const refreshed = await registry.refreshChatGptModels();
    assert.deepEqual(refreshed.models, []); assert.match(refreshed.modelCatalogError!, /登录已变化/);
  } finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});

test("empty, malformed, duplicate and hidden-only catalog responses remain failures", async () => {
  for (const value of [null, {}, { models: [] }, { models: [{ visibility: "hide" }] },
    { models: [{ visibility: "list" }] }, { models: [fixtureModels.models[0], fixtureModels.models[0]] }]) {
    assert.throws(() => parseChatGptModels(value), /ChatGPT/);
  }
  const { root, registry } = await setup(), previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(fixtureModels);
    const first = await registry.refreshChatGptModels();
    globalThis.fetch = async () => Response.json({ models: [] });
    const failed = await registry.refreshChatGptModels();
    assert.deepEqual(failed.models, first.models); assert.match(failed.modelCatalogError!, /没有可用模型/);
    globalThis.fetch = async () => { throw new Error("ChatGPT transport failure containing fixture-token"); };
    assert.doesNotMatch((await registry.refreshChatGptModels()).modelCatalogError!, /fixture-token/);
  } finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});

test("subscription draft cannot replace the authenticated catalog", async () => {
  const { root, registry } = await setup();
  try {
    const input = { id: "chatgpt", name: "Browser supplied", protocol: "chatgpt-subscription" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex", models: [{ id: "invented", name: "Invented" }] };
    await assert.rejects(registry.upsert(input), /刷新模型列表/);
    await assert.rejects(registry.upsert({ ...input, id: "another" }), /刷新模型列表/);
    const state = JSON.parse(await readFile(registry.statePath, "utf8"));
    delete state.chatGptCatalogIdentity; state.providers.find((p: { id: string }) => p.id === "chatgpt").models = input.models;
    await writeFile(registry.statePath, JSON.stringify(state));
    await registry.load();
    assert.deepEqual((await registry.list()).find(p => p.id === "chatgpt")?.models, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("subscription credentials reject symlinks, public files and oversized files before fetch", async () => {
  const { root, authFile } = await setup(), previousFetch = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = async () => { requests++; throw new Error("unexpected network"); };
    const link = join(root, "link.json"); await symlink(authFile, link);
    assert.equal((await readChatGptLogin(link)).authStatus, "invalid");
    await assert.rejects(fetchChatGptModels(link), /登录不可用/);
    if (process.platform !== "win32") {
      await chmod(authFile, 0o644);
      assert.equal((await readChatGptLogin(authFile)).authStatus, "insecure");
      await chmod(authFile, 0o600);
    }
    await writeFile(authFile, " ".repeat(262145));
    assert.equal((await readChatGptLogin(authFile)).authStatus, "invalid");
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});


test("catalog response size is bounded without exposing response data", async () => {
  const { root, authFile } = await setup(), previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("x".repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(fetchChatGptModels(authFile), /超过大小限制/);
  } finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});

test("Host account identity agrees with the runtime fixture vectors", async () => {
  const { root, authFile, login } = await setup();
  try {
    const vectors = JSON.parse(await readFile(new URL("../../test/fixtures/chatgpt-identity-vectors.json", import.meta.url), "utf8"));
    for (const vector of vectors) {
      await login(vector.accountId, vector.accessToken);
      const value = await readChatGptLogin(authFile);
      assert.equal(value.authStatus, "configured", vector.name);
      assert.equal(value.identity, vector.identity, vector.name);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
