// Run this proposal under the verifier's private HOME. Each registry also uses
// an explicit synthetic auth file, and fetch never delegates to the network.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderRegistry } from "./providers.js";

const originalEndpoint = "https://saved.example/v1";
const originalKey = "saved-update-fixture-key";
const provider = (baseUrl: string, apiKey?: string) => ({
  id: "saved-update",
  name: "Saved update fixture",
  protocol: "openai-responses" as const,
  baseUrl,
  ...(apiKey === undefined ? {} : { apiKey }),
  models: [{ id: "fixture-model", name: "Fixture model" }],
});

type Request = { url: string; authorization: string | null };

async function withFixture(run: (fixture: {
  registry: ProviderRegistry;
  requests: Request[];
  settingsPath: string;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "qi-provider-update-boundary-"));
  const previousFetch = globalThis.fetch;
  const requests: Request[] = [];
  try {
    await chmod(root, 0o700);
    const fixtureHome = join(root, "home");
    await mkdir(fixtureHome, { mode: 0o700 });
    const authFile = join(fixtureHome, "fixture-auth.json");
    await writeFile(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: {
      access_token: "synthetic-never-sent", account_id: "synthetic-account",
    } }), { mode: 0o600 });
    globalThis.fetch = async (input, options) => {
      requests.push({ url: String(input), authorization: new Headers(options?.headers).get("authorization") });
      return Response.json({ data: [{ id: "fixture-model" }] });
    };
    const registry = new ProviderRegistry(join(root, "state"), { codexAuthFile: authFile });
    await registry.load();
    await run({ registry, requests, settingsPath: registry.statePath });
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
}

test("saved-key endpoint updates reject implicit reuse without changing stored or live settings", async t => {
  const endpoints = [
    ["host", "https://other.example/v1"],
    ["port", "https://saved.example:8443/v1"],
    ["path", "https://saved.example/v2"],
  ] as const;
  const absentKeys = [
    ["omitted", undefined], ["empty", ""], ["whitespace", "   "],
  ] as const;
  for (const [endpointKind, baseUrl] of endpoints) {
    for (const [keyKind, apiKey] of absentKeys) {
      await t.test(`${endpointKind} change with ${keyKind} key`, async () => {
        await withFixture(async ({ registry, requests, settingsPath }) => {
          await registry.upsert(provider(originalEndpoint, originalKey));
          const before = await readFile(settingsPath);
          await assert.rejects(registry.upsert(provider(baseUrl, apiKey)), /密钥|credential|key/i);
          assert.deepEqual(await readFile(settingsPath), before,
            "rejected endpoint edits must not alter persisted settings");
          assert.deepEqual(requests, [], "saving or rejecting settings performs no discovery request");
          await registry.discover({ providerId: "saved-update" });
          assert.deepEqual(requests, [{ url: `${originalEndpoint}/models`, authorization: `Bearer ${originalKey}` }],
            "the live registry must retain the original endpoint and key after rejection");
        });
      });
    }
  }
});

test("normalized equivalent endpoint edits retain a saved key", async () => {
  await withFixture(async ({ registry, requests, settingsPath }) => {
    await registry.upsert(provider(originalEndpoint, originalKey));
    await registry.upsert(provider("https://SAVED.example:443/v1/", "   "));
    const saved = JSON.parse(await readFile(settingsPath, "utf8")).providers
      .find((entry: { id: string }) => entry.id === "saved-update");
    assert.equal(saved.baseUrl, originalEndpoint);
    assert.equal(saved.apiKey, originalKey);
    await registry.discover({ providerId: "saved-update" });
    assert.deepEqual(requests, [{ url: `${originalEndpoint}/models`, authorization: `Bearer ${originalKey}` }]);
  });
});

test("an explicit replacement key permits moving a saved provider endpoint", async () => {
  await withFixture(async ({ registry, requests, settingsPath }) => {
    await registry.upsert(provider(originalEndpoint, originalKey));
    const baseUrl = "https://other.example/v2";
    const replacement = "explicit-replacement-fixture-key";
    await registry.upsert(provider(baseUrl, replacement));
    const saved = JSON.parse(await readFile(settingsPath, "utf8")).providers
      .find((entry: { id: string }) => entry.id === "saved-update");
    assert.equal(saved.baseUrl, baseUrl);
    assert.equal(saved.apiKey, replacement);
    await registry.discover({ providerId: "saved-update" });
    assert.deepEqual(requests, [{ url: `${baseUrl}/models`, authorization: `Bearer ${replacement}` }]);
  });
});

test("a keyless custom provider may change endpoints without acquiring credentials", async () => {
  await withFixture(async ({ registry, requests, settingsPath }) => {
    await registry.upsert(provider(originalEndpoint));
    const baseUrl = "https://keyless.example/v2";
    const updated = await registry.upsert(provider(baseUrl, "   "));
    assert.equal(updated.apiKeyConfigured, false);
    assert.equal(updated.authStatus, "missing");
    const saved = JSON.parse(await readFile(settingsPath, "utf8")).providers
      .find((entry: { id: string }) => entry.id === "saved-update");
    assert.equal(saved.baseUrl, baseUrl);
    assert.equal(saved.apiKey, undefined);
    await registry.discover({ providerId: "saved-update" });
    assert.deepEqual(requests, [{ url: `${baseUrl}/models`, authorization: null }]);
  });
});
