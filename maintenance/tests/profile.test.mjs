import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { runProcess } from '../../evals/lib/core.mjs';

test('generated maintenance profile parses with bounded runtime and no automatic orchestration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-maint-profile-'));
  try {
    const file = path.join(root, 'agent.edn');
    execFileSync(process.execPath, [fileURLToPath(new URL('../profile.mjs', import.meta.url)), 'example-model', 'medium', file]);
    const result = execFileSync('bb', ['-e', `(require '[clojure.edn :as edn])
      (let [p (edn/read-string (slurp (first *command-line-args*)))
            specs (:plugins p) runtime (some #(when (= 'qi.plugins.runtime (:ns %)) %) specs)]
        (assert (some #(= 'qi.plugins.openai-responses (:ns %)) specs))
        (assert (= 32 (get-in runtime [:config :max-steps])))
        (assert (zero? (get-in runtime [:config :max-retries])))
        (assert (not-any? #(contains? '#{qi.plugins.automation qi.plugins.planning qi.plugins.subagent} (:ns %)) specs))
        (print "valid"))`, file], { encoding: 'utf8' });
    assert.equal(result, 'valid');
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('../profile.mjs', import.meta.url)), 'example-model', 'medium', file], { stdio: 'pipe' }), /Command failed/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('native maintenance worker reaches only its loopback relay with a placeholder credential', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-maint-relay-'));
  let requests = 0, authorization;
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    requests++; authorization = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'resp_fixture', status: 'completed',
      model: 'fixture-model', usage: { input_tokens: 3, output_tokens: 1 },
      output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const profile = path.join(root, 'agent.edn');
    await fs.writeFile(profile, `{:plugins [{:ns qi.plugins.session :config {:path nil :ephemeral true}}
      {:ns qi.plugins.model-registry} {:ns qi.plugins.openai-responses :config {:model "fixture-model"}}
      {:ns qi.plugins.runtime}]}`);
    const run = (url) => runProcess('bb', ['--classpath', 'src:plugins', 'maintenance/worker.clj', profile, 'hello'],
      { timeoutMs: 10000, env: { ...process.env, OPENAI_API_KEY: 'fixture-secret-must-not-reach-relay', QI_MAINTENANCE_BROKER_URL: url } });
    const result = await run(`http://127.0.0.1:${server.address().port}/v1`);
    assert.equal(result.exit_code, 0, result.stderr);
    assert.equal(requests, 1); assert.equal(authorization, 'Bearer maintenance-broker');
    const terminal = result.stdout.split('\n').filter(Boolean).map(JSON.parse).filter((v) => v.type === 'result').at(-1);
    assert.equal(terminal.ok, true); assert.equal(terminal.result.status, 'completed');
    for (const url of ['https://example.invalid/v1', 'http://127.0.0.1:0/v1', 'http://127.0.0.1:65536/v1', 'http://127.0.0.1:123/v1?redirect=x']) {
      const rejected = await run(url); assert.notEqual(rejected.exit_code, 0); assert.match(rejected.stderr, /loopback relay/);
    }
    assert.equal(requests, 1, 'invalid relay configuration must not send any requests');
  } finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});
