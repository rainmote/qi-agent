import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderRegistry } from "./providers.js";

test("provider registry persists secrets privately and returns redacted settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "dao-provider-test-"));
  try {
    const registry = new ProviderRegistry(root);
    await registry.load();
    assert.deepEqual(registry.list().slice(0, 2).map((provider) => provider.id), ["deepseek", "openai"]);

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

    const restored = new ProviderRegistry(root);
    await restored.load();
    assert.equal(restored.list().find((provider) => provider.id === "acme")?.apiKeyConfigured, true);
    await restored.upsert({
      id: "acme",
      name: "Acme Updated",
      protocol: "openai-completions",
      baseUrl: "https://gateway.example/v1",
      models: [{ id: "acme-chat", name: "Acme Chat" }],
    });
    assert.equal(restored.list().find((provider) => provider.id === "acme")?.apiKeyConfigured, true,
      "an empty key edit should preserve the stored key");
    assert.equal(await restored.remove("acme"), true);
    await assert.rejects(restored.remove("deepseek"), /内置提供方不能删除/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider registry discovers OpenAI-compatible model catalogs", async () => {
  const root = await mkdtemp(join(tmpdir(), "dao-provider-discovery-test-"));
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
