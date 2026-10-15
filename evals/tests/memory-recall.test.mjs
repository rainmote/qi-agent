import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);

test('twenty frozen long histories preserve explicit constraints in both representation controls', async () => {
  const file = 'evals/experiments/memory-cases.json';
  const raw = await readFile(file);
  assert.equal(createHash('sha256').update(raw).digest('hex'), '8d63b91339ff29fb5280948059ac726d7217428964ebf86be9e85f5a1c7d4f77');
  const fixture = JSON.parse(raw);
  const { stdout } = await exec('bb', ['--classpath', 'src:plugins', 'evals/experiments/memory_recall.clj', file], { timeout: 30000, maxBuffer: 2 ** 20 });
  const result = JSON.parse(stdout);
  assert.equal(result.case_count, 20); assert.equal(result.checkpoint_matches, 20); assert.equal(result.layered_matches, 20);
  assert.equal(result.model_calls, 0); assert.equal(result.model_semantic_recall, null);
  assert.equal(result.production_memory_enabled, false);
  for (const [index, row] of result.cases.entries()) {
    assert.ok(row['source-chars'] > 48000);
    assert.deepEqual(row.checkpoint.values, fixture.cases[index].expected);
    assert.deepEqual(row.layered.values, fixture.cases[index].expected);
    assert.equal(row['project-hidden-when-untrusted'], true);
    assert.equal(row['ephemeral-hidden-in-other-session'], true);
    for (const record of row.layered.records) {
      assert.equal(record['source-event'], fixture.cases[index].annotations[1].id);
      assert.equal(record.supersedes, fixture.cases[index].annotations[0].id);
      assert.equal(record.review, 'fixture-only');
    }
  }
});

test('constraint annotations reject missing provenance, stale supersession and cross-scope overwrite', async () => {
  await exec('bb', ['--classpath', 'src:plugins:evals/experiments', '-e', `
    (require '[memory-recall :as m])
    (let [a {:id "a" :at "2026-10-15T00:00:00Z" :scope "project" :key "push" :value false}
          rejects? (fn [events] (try (m/active-records events) false (catch Exception _ true)))]
      (assert (rejects? [(dissoc a :at)]))
      (assert (rejects? [a a]))
      (assert (rejects? [a (assoc a :id "b" :supersedes "unknown")]))
      (assert (rejects? [a (assoc a :id "b" :scope "user" :supersedes "a")]))
      (assert (rejects? [a (assoc a :id "b")]))
      (assert (= 2 (count (m/active-records [a (assoc a :id "b" :scope "user")])))))`], { timeout: 10000 });
});
