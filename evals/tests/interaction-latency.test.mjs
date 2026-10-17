import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
test('thirty native steer and cancel samples cover each slow call phase with local clocks', { timeout: 30000 }, async () => {
  const { stdout } = await exec('bb', ['--classpath', 'src:plugins', 'evals/experiments/interaction_latency.clj'], { timeout: 25000, maxBuffer: 2 ** 20 });
  const report = JSON.parse(stdout);
  assert.equal(report.samples.length, 180); assert.equal(report.groups.length, 6);
  assert.equal(report.model_calls, 0); assert.equal(report.production_samples, 0); assert.equal(report.cost_usd, null);
  for (const row of report.samples) {
    assert.equal(row.sample_kind, 'fixture'); assert.match(row.profile_sha256, /^[a-f0-9]{64}$/);
    assert.ok(row.run_id); assert.ok(row.terminal_ms >= 0);
    if (row.action === 'steer') { assert.ok(row.queue_item_id); assert.ok(row.consumed_ms >= row.received_ms); }
    else { assert.equal(row.status, 'cancelled'); assert.equal(row.consumed_ms, null); }
  }
  for (const group of report.groups) {
    assert.equal(group.received.n, 30); assert.equal(group.terminal.n, 30);
    assert.ok(group.received.p95_ms <= 250);
    if (group.action === 'cancel') assert.ok(group.terminal.p95_ms <= 1000);
    else assert.equal(group.consumed.n, 30);
  }
});
