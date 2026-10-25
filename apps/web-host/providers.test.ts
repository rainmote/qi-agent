import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderRegistry } from "./providers.js";

test("provider registry persists secrets privately and returns redacted settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-agent-provider-test-"));
  try {
    if (process.platform !== "win32") await chmod(root, 0o755);
    const authFile = join(root, "codex-auth.json");
    const registry = new ProviderRegistry(root, { codexAuthFile: authFile });
    await registry.load();
    if (process.platform !== "win32") {
      assert.equal((await stat(root)).mode & 0o777, 0o700);
    }
    assert.deepEqual((await registry.list()).slice(0, 3).map((provider) => provider.id),
      ["deepseek", "openai", "chatgpt"]);
    const missingSubscription = (await registry.list()).find((provider) => provider.id === "chatgpt");
    assert.equal(missingSubscription?.authType, "chatgpt-subscription");
    assert.equal(missingSubscription?.authStatus, "missing");

    const saved = await registry.upsert({
      id: "acme",
      name: "Acme Gateway",
      protocol: "openai-completions",
      baseUrl: "https://gateway.example/v1/",
      apiKey: "secret-value",
      models: [{ id: "acme-chat", name: "Acme Chat", contextWindow: 32_000 }],
    });
    assert.equal(saved.apiKeyConfigured, true);
    assert.equal("apiKey" in saved, false);
    assert.equal(saved.baseUrl, "https://gateway.example/v1");

    const persisted = await readFile(registry.statePath, "utf8");
    assert.match(persisted, /secret-value/);
    assert.equal((await stat(registry.statePath)).mode & 0o777, 0o600);

    await Promise.all(Array.from({ length: 8 }, (_, index) => registry.upsert({
      id: `parallel-${index}`,
      name: `Parallel ${index}`,
      protocol: "openai-completions",
      baseUrl: `https://gateway-${index}.example/v1`,
      apiKey: `parallel-secret-${index}`,
      models: [{ id: `parallel-model-${index}`, name: `Parallel model ${index}` }],
    })));
    const concurrentState = JSON.parse(await readFile(registry.statePath, "utf8")) as {
      providers: Array<{ id: string }>;
    };
    assert.equal(concurrentState.providers.filter(({ id }) => id.startsWith("parallel-")).length, 8);
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);

    const restored = new ProviderRegistry(root);
    await restored.load();
    assert.equal((await restored.list()).find((provider) => provider.id === "acme")?.apiKeyConfigured, true);
    await restored.upsert({
      id: "acme",
      name: "Acme Updated",
      protocol: "openai-completions",
      baseUrl: "https://gateway.example/v1",
      models: [{ id: "acme-chat", name: "Acme Chat" }],
    });
    assert.equal((await restored.list()).find((provider) => provider.id === "acme")?.apiKeyConfigured, true,
      "an empty key edit should preserve the stored key");
    assert.equal(await restored.remove("acme"), true);
    await assert.rejects(restored.remove("deepseek"), /内置提供方不能删除/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider registry discovers the local Codex ChatGPT login without exposing tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-agent-provider-chatgpt-auth-test-"));
  const authFile = join(root, "auth.json");
  try {
    await writeFile(authFile, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "private-access-token", account_id: "private-account-id" },
    }), { mode: 0o600 });
    const registry = new ProviderRegistry(join(root, "state"), { codexAuthFile: authFile });
    await registry.load();
    const provider = (await registry.list()).find((entry) => entry.id === "chatgpt");
    assert.equal(provider?.authStatus, "configured");
    assert.equal(provider?.authSource, "codex-auth-cache");
    assert.equal(provider?.authFile, authFile);
    assert.equal(JSON.stringify(provider).includes("private-access-token"), false);
    assert.equal(JSON.stringify(provider).includes("private-account-id"), false);

    if (process.platform !== "win32") {
      await chmod(authFile, 0o644);
      assert.equal((await registry.list()).find((entry) => entry.id === "chatgpt")?.authStatus,
        "insecure");
      await chmod(authFile, 0o600);
    }

    const expiredToken = ["header", Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url"),
      "signature"].join(".");
    await writeFile(authFile, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: expiredToken, account_id: "private-account-id" },
    }));
    assert.equal((await registry.list()).find((entry) => entry.id === "chatgpt")?.authStatus,
      "expired");

    await writeFile(authFile, JSON.stringify({ auth_mode: "apikey", tokens: {} }));
    assert.equal((await registry.list()).find((entry) => entry.id === "chatgpt")?.authStatus,
      "invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider registry discovers OpenAI-compatible model catalogs", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-agent-provider-discovery-test-"));
  const modelServer = createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, "Bearer discovery-key");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [
      { id: "zeta" },
      { id: "alpha", name: "Alpha" },
      { id: "" },
    ] }));
  });
  await new Promise<void>((resolve, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", resolve);
  });
  const address = modelServer.address();
  assert.ok(address && typeof address === "object");
  try {
    const registry = new ProviderRegistry(root);
    await registry.load();
    const models = await registry.discover({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "discovery-key",
    });
    assert.deepEqual(models, [{ id: "alpha", name: "Alpha" }, { id: "zeta", name: "zeta" }]);
  } finally {
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});


test("environment credentials stay bound during edits and model discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-provider-boundary-"));
  try {
    const registry = new ProviderRegistry(root);
    await registry.load();
    for (const [baseUrl, protocol, apiKeyEnv] of [
      ["https://example.com/v1", "openai-responses", "OPENAI_API_KEY"],
      ["https://api.openai.com:8443/v1", "openai-responses", "OPENAI_API_KEY"],
      ["https://example.com/v1", "anthropic-messages", "HOME"],
    ] as const) {
      await assert.rejects(registry.upsert({ id: "unsafe", name: "Unsafe", baseUrl, protocol,
        apiKeyEnv, models: [{ id: "test", name: "Test" }] }), /credential/i);
    }
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { requests++; return Response.json({ data: [] }); };
    try {
      await assert.rejects(registry.discover({ providerId: "openai", baseUrl: "https://example.com/v1" }),
        /credential/i);
      assert.equal(requests, 0);
      await registry.discover({ providerId: "openai", baseUrl: "https://example.com/v1", apiKey: "explicit" });
      assert.equal(requests, 1, "an explicit caller key can target a custom endpoint");
    } finally { globalThis.fetch = originalFetch; }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("provider settings readers refuse public files and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-provider-private-"));
  try {
    const registry = new ProviderRegistry(root);
    await registry.load();
    const bytes = await readFile(registry.statePath);
    await chmod(registry.statePath, 0o644);
    await assert.rejects(new ProviderRegistry(root).load(), /private|owner/i);
    await rm(registry.statePath);
    const target = join(root, "target.json");
    await writeFile(target, bytes, { mode: 0o600 });
    await symlink(target, registry.statePath);
    await assert.rejects(new ProviderRegistry(root).load(), /symbolic|private/i);
    assert.deepEqual(await readFile(target), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
