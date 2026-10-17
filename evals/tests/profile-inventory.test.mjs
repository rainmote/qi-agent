import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('Minimal and Code compose explicit tool subsets while preserving runtime and policy boundaries', async () => {
  const { stdout } = await exec('bb', ['--classpath', 'src:plugins', 'evals/experiments/profile_inventory.clj'], { timeout: 30000, maxBuffer: 4 * 2 ** 20 });
  const report = JSON.parse(stdout);
  assert.equal(report.model_calls, 0); assert.equal(report.rows.length, 4);
  const [standard, creator, minimal, code] = report.rows;
  assert.ok(standard.runtime.plugins.length > minimal.runtime.plugins.length);
  assert.ok(creator.runtime.plugins.length > standard.runtime.plugins.length);
  assert.deepEqual(minimal.runtime.tools.map(t => t.name), ['current_time', 'find', 'grep', 'ls', 'read']);
  assert.equal(code.runtime.tools.some(t => t.name === 'write'), true);
  assert.equal(code.runtime.tools.some(t => t.name === 'bb_repl'), false);
  assert.deepEqual(minimal['missing-capabilities'], ['write', 'bash']);
  assert.equal(minimal.tasks[0].verification, 'PASS');
  for (const row of report.rows) {
    assert.equal(row['production-defaults-changed'], false);
    assert.match(row['tool-schema-sha256'], /^[a-f0-9]{64}$/);
    assert.match(row['policy-sha256'], /^[a-f0-9]{64}$/);
    assert.ok(row['composition-ms'] >= 0);
    assert.equal(row['request-estimates'].length, 6);
    assert.ok(row['request-estimates'][0].budget['used-tokens'] > row['request-estimates'][0].budget['tool-tokens']);
    assert.equal(row.tasks.every(t => t['execution-verification'] === 'not-run'), true);
  }
  for (const row of [minimal, code]) {
    assert.ok(row['configured-plugins'].includes('qi.plugins.policy'));
    assert.ok(row['configured-plugins'].includes('qi.plugins.approval'));
    const runtime = row['configured-boundaries'].find(p => p.ns === 'qi.plugins.runtime').config;
    assert.equal(runtime['max-model-requests'], 12); assert.equal(runtime['max-wall-ms'], 30000);
  }
  assert.equal(code.tasks[1].verification, 'PASS');
  for (const row of [standard, creator, code]) {
    for (const task of row.tasks) if (task.available) assert.equal(task.verification, 'PASS', `${row.name}/${task.id}: ${task['tool-error']}`);
  }
});

test('tool registration accepts an empty subset and rejects non-string names', async () => {
  await exec('bb', ['--classpath', 'src:plugins', '-e', `
    (require '[qi.plugin :as p] '[qi.kernel :as k] '[babashka.fs :as fs])
    (let [root (fs/create-temp-dir) base [{:ns 'qi.plugins.execution-world :config {:root (str root)}}]
          ctx (p/boot! {:plugins (conj base {:ns 'qi.plugins.tools :config {:allow-tools []}})})]
      (try (assert (empty? (k/tools ctx)))
           (assert (try (p/boot! {:plugins (conj base {:ns 'qi.plugins.tools :config {:allow-tools [:read]}})}) false (catch Exception _ true)))
      (finally (k/dispose-all! ctx) (fs/delete-tree root))))`], { timeout: 10000 });
});
