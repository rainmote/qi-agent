import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTree, loadTasks, readTask, relativePath, runProcess, cleanEnvironment, verifyCandidate } from '../lib/core.mjs';
import { summarize, writeReport } from '../lib/report.mjs';

const tasksRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tasks');
async function temporary(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-eval-test-'));
  try { return await action(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('independent verifier rejects early exit and ignores agent-authored test replacement', async () => {
  await temporary(async (root) => {
    const task = await readTask(path.join(tasksRoot, 'dev-001-latest-request'));
    const candidate = path.join(root, 'candidate');
    await copyTree(path.join(task.root, 'workspace'), candidate);
    await fs.writeFile(path.join(candidate, task.allowed_files[0]), 'export function createRequestStore() {}\nprocess.exit(0);\n');
    const earlyExit = await verifyCandidate(task, candidate);
    assert.equal(earlyExit.passed, false);
    assert.equal(earlyExit.tap.complete, false);
    await copyTree(path.join(task.root, 'solution'), candidate);
    await fs.mkdir(path.join(candidate, 'tests'), { recursive: true });
    await fs.writeFile(path.join(candidate, 'tests/acceptance.test.mjs'), 'process.exit(0);\n');
    const modifiedTests = await verifyCandidate(task, candidate);
    assert.equal(modifiedTests.tests_passed, true);
    assert.equal(modifiedTests.passed, false);
    assert.ok(modifiedTests.forbidden_changes.some((change) => change.path === 'tests/acceptance.test.mjs'));
  });
});

test('path traversal and symlink deliverables are rejected', async () => {
  for (const value of ['../secret', '/secret', 'src/../secret', 'src\\secret', '', 'src//a']) {
    assert.throws(() => relativePath(value));
  }
  await temporary(async (root) => {
    const task = (await loadTasks(tasksRoot))[0];
    const candidate = path.join(root, 'candidate');
    await copyTree(path.join(task.root, 'workspace'), candidate);
    const file = path.join(candidate, task.allowed_files[0]);
    await fs.rm(file);
    await fs.symlink(path.join(task.root, 'solution', task.allowed_files[0]), file);
    await assert.rejects(() => verifyCandidate(task, candidate), /Symbolic links/);
  });
});

test('process deadlines and output limits stop execution without inherited credentials', async () => {
  await temporary(async (root) => {
    const environment = cleanEnvironment(root);
    assert.deepEqual(Object.keys(environment).sort(), ['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TMPDIR', 'TZ'].sort());
    const timed = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: root, env: environment, timeoutMs: 150,
    });
    assert.equal(timed.timed_out, true);
    assert.notEqual(timed.exit_code, 0);
    const flooded = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)'], {
      cwd: root, env: environment, timeoutMs: 3000, maxOutputBytes: 1024,
    });
    assert.equal(flooded.output_limited, true);
    assert.ok(Buffer.byteLength(flooded.stdout) <= 1024);
  });
});

function record(trial, success, overrides = {}) {
  return { schema_version: 1, run_id: 'r' + trial, task_id: 't1', task_hash: 'abc', agent: 'qi', model: 'model-a',
    mode: 'test', trial, success, cost_usd: null, cost_complete: false, agent_duration_ms: 10,
    task_title: 'task', verifier_duration_ms: 10, ...overrides };
}

test('report keeps missing costs unknown and does not equate one success with stable success', () => {
  const one = summarize([record(1, true)])[0];
  assert.equal(one.stable3_rate, null);
  assert.equal(one.cost_per_success_usd, null);
  const three = summarize([record(1, true), record(2, true), record(3, false)])[0];
  assert.equal(three.stable3_rate, 0);
  assert.equal(three.success_rate, 2 / 3);
  assert.equal(three.stable3_eligible_tasks, 1);
  const paid = summarize([record(1, true, { cost_usd: 1, cost_complete: true }), record(2, false, { cost_usd: 2, cost_complete: true })])[0];
  assert.equal(paid.cost_per_success_usd, 3);
  assert.throws(() => summarize([record(1, true), record(1, false, { run_id: 'different' })]), /Duplicate task trial/);
  assert.throws(() => summarize([record(1, true), record(2, true, { task_hash: 'changed' })]), /Mixed task revisions/);
});

test('HTML escapes result text rather than executing agent output', async () => {
  await temporary(async (root) => {
    await writeReport(root, [record(1, false, { task_title: '<script>alert(1)</script>', agent: 'evil<img src=x>' })]);
    const html = await fs.readFile(path.join(root, 'report.html'), 'utf8');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;img src=x&gt;'));
  });
});

test('CLI planning records provenance without executing the selected agent', async () => {
  await temporary(async (root) => {
    const config = path.join(root, 'config.json');
    await fs.writeFile(config, JSON.stringify({ codex: {
      command: '/nonexistent-must-not-be-executed', model: 'test-model', reasoning_effort: 'medium',
    } }));
    const output = path.join(root, 'plan');
    const execution = await runProcess(process.execPath, [path.resolve(tasksRoot, '../run.mjs'), 'plan',
      '--config', config, '--agents', 'codex', '--task', 'dev-001-latest-request', '--out', output], {
      cwd: root, env: cleanEnvironment(root), timeoutMs: 10000,
    });
    assert.equal(execution.exit_code, 0, execution.stderr);
    const plan = JSON.parse(await fs.readFile(path.join(output, 'plan.json'), 'utf8'));
    assert.equal(plan.mode, 'plan_only');
    assert.match(plan.evaluator_source_hash, /^[0-9a-f]{64}$/);
    assert.match(plan.dataset_hash, /^[0-9a-f]{64}$/);
    assert.equal(plan.invocations.length, 1);
    assert.equal(plan.invocations[0].command, '/nonexistent-must-not-be-executed');
  });
});
