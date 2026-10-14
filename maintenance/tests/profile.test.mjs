import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
