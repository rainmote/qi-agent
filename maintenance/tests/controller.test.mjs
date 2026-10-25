import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { lockStore, readJournal, putArtifact, readArtifact, validateArtifacts, encode } from '../lib/store.mjs';
import { prepare, implement, verify, accept, retry, recover, restoreCandidate, transition } from '../lib/controller.mjs';
import { usageLedger, mayAttempt, actionIntent } from '../lib/ledger.mjs';
import { reviewWindow, recordReview, lessonState } from '../lib/reflection.mjs';
import { runProcess } from '../../evals/lib/core.mjs';

const policy = JSON.parse(await fs.readFile(new URL('../policy.json', import.meta.url)));
const image = 'sha256:' + 'a'.repeat(64);
const command = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-maint-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repo'), root = path.join(directory, 'state'), verifier = path.join(directory, 'verifier');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true }); await fs.mkdir(verifier);
  await fs.writeFile(path.join(repo, 'src/value.mjs'), 'export const value = 1;\n');
  await fs.writeFile(path.join(repo, 'untouched.txt'), 'keep\n');
  command(repo, 'init', '-b', 'main'); command(repo, 'add', '.');
  command(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline');
  const sha = command(repo, 'rev-parse', 'HEAD');
  const profile = path.join(directory, 'agent.edn'); await fs.writeFile(profile, '{:plugins []}\n');
  await fs.writeFile(path.join(verifier, 'acceptance.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
const {value} = await import('file://' + process.cwd() + '/src/value.mjs');
test('value is repaired', () => assert.equal(value, 2));\n`);
  const task = { schema_version: 1, task_id: 'test-task', goal: 'Make value equal two', kind: 'bug', base_sha: sha, image,
    profile_path: profile, verifier_dir: verifier, allowed_files: ['src/value.mjs'],
    checks: [{ id: 'parse', argv: ['node', '--check', 'src/value.mjs'], timeout_seconds: 10 }],
    acceptance: { file: 'acceptance.test.mjs', tests: ['value is repaired'] } };
  const lock = await lockStore(root); t.after(() => lock.close().catch(() => {}));
  const execute = async (options) => {
    const argv = options.argv.map((arg) => arg.startsWith('/acceptance/') ? path.join(options.mounts[0].source, arg.slice('/acceptance/'.length)) : arg);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    return runProcess(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), { cwd: options.workspace, timeoutMs: options.timeoutMs, env });
  };
  const init = () => prepare({ repo, root, controller: repo, task, policy, lock });
  const driver = { mode: 'offline', paid: false, unattended: false,
    argv: ['node', '-e', "require('node:fs').writeFileSync('src/value.mjs', 'export const value = 2;\\n')"] };
  return { directory, repo, root, task, lock, execute, init, driver, sha };
}

test('complete offline loop preserves the original checkout and requires exact manual acceptance', async (t) => {
  const f = await fixture(t); const scoped = await f.init();
  const ready = await implement({ ...f, id: f.task.task_id });
  assert.equal(ready.status, 'review_ready');
  assert.equal(ready.attempts, 1); assert.match(ready.candidate_sha, /^[0-9a-f]{40}$/);
  assert.equal(await fs.readFile(path.join(f.repo, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.equal(command(f.repo, 'status', '--porcelain'), '');
  assert.equal(ready.checks.find((check) => check.phase === 'red').tap.complete, true);
  assert.equal(ready.checks.find((check) => check.phase === 'red').tap.passed, false);
  await assert.rejects(accept({ ...f, id: f.task.task_id, expectedRevision: scoped.revision, review: {} }), /revision/);
  const review = { role: 'human', reviewer: 'fixture reviewer', decision: 'approve', summary: 'Inspected the source and assertions', head_sha: ready.candidate_sha };
  const accepted = await accept({ ...f, id: f.task.task_id, expectedRevision: ready.revision, review });
  assert.equal(accepted.status, 'accepted');
  assert.equal(command(f.repo, 'rev-parse', 'main'), f.sha, 'acceptance never merges or pushes');
  await validateArtifacts(f.root, await readJournal(f.root));
});

test('duplicate tasks are idempotent and changed contracts or concurrent tasks are refused', async (t) => {
  const f = await fixture(t); const first = await f.init();
  assert.deepEqual(await f.init(), first);
  await assert.rejects(prepare({ ...f, controller: f.repo, policy, task: { ...f.task, goal: 'changed' } }), /different contract/);
  await assert.rejects(prepare({ ...f, controller: f.repo, policy, task: { ...f.task, task_id: 'another' } }), /one active task/);
});

test('candidate tampering with tests, policy or unrelated files cannot manufacture success', async (t) => {
  const f = await fixture(t); const state = await f.init();
  await fs.writeFile(path.join(state.workspace, 'src/value.mjs'), 'export const value = 2;\n');
  await fs.writeFile(path.join(state.workspace, 'fake-success.json'), '{"status":"PASS"}');
  const result = await verify({ ...f, id: f.task.task_id });
  assert.equal(result.status, 'uncertain'); assert.match(result.reason, /outside the contract/);
  await assert.rejects(prepare({ ...f, controller: f.repo, policy, task: { ...f.task, task_id: 'protected', allowed_files: ['maintenance/policy.json'] } }), /Protected/);
});

test('a failing baseline blocks the writer before it can change source', async (t) => {
  const f = await fixture(t);
  f.task.checks[0].argv = ['node', '-e', 'process.exit(1)'];
  const scoped = await f.init();
  const result = await implement({ ...f, id: f.task.task_id });
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'baseline-failed');
  assert.equal(await fs.readFile(path.join(scoped.workspace, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
});

test('operator pause cancels baseline, worker and candidate checks without starting later work', async (t) => {
  for (const phase of ['before-start', 'baseline', 'worker', 'candidate']) {
    const f = await fixture(t); await f.init();
    let workers = 0, stopped = phase === 'before-start';
    const stop = () => fs.writeFile(path.join(f.root, 'pause.json'), '{"reason":"operator-stop"}');
    if (stopped) await stop();
    const execute = async (options) => {
      assert.equal(stopped, false, 'no new process may start after pause');
      if (!options.readonly) workers++;
      const current = !options.readonly ? 'worker' : options.workspace.includes('/verification/') ? 'candidate' : 'baseline';
      const result = await f.execute(options);
      if (current === phase) {
        await stop(); stopped = true;
        assert.equal(await options.shouldStop?.(), true, 'active check must observe operator pause');
      }
      return result;
    };
    const result = await implement({ ...f, id: f.task.task_id, execute });
    assert.equal(result.status, 'cancelled', phase);
    assert.equal(result.reason, 'operator-paused', phase);
    assert.equal(workers, ['before-start', 'baseline'].includes(phase) ? 0 : 1);
  }
});

test('syntax errors, skipped tests and fabricated process success are not red evidence', async (t) => {
  for (const body of ['syntax ! error', "process.exit(0)", "import test from 'node:test'; test.skip('value is repaired', () => {});"]) {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.task.verifier_dir, 'acceptance.test.mjs'), body);
    await f.init();
    const result = await implement({ ...f, id: f.task.task_id });
    assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'invalid-red-evidence');
  }
});

test('head or base changes after verification invalidate acceptance', async (t) => {
  const f = await fixture(t); await f.init();
  const ready = await implement({ ...f, id: f.task.task_id });
  const review = { role: 'human', reviewer: 'test', decision: 'approve', summary: 'test', head_sha: ready.candidate_sha };
  await fs.writeFile(path.join(ready.workspace, 'src/value.mjs'), 'export const value = 3;\n');
  await assert.rejects(accept({ ...f, id: f.task.task_id, expectedRevision: ready.revision, review }), /changed/);
  command(f.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'new main');
  await assert.rejects(accept({ ...f, id: f.task.task_id, expectedRevision: ready.revision, review }), /stale/);
});

test('known failures can retry with a new run identity; repeated source stops for no progress', async (t) => {
  const f = await fixture(t); await f.init();
  const driver = { ...f.driver, argv: ['node', '-e', "require('node:fs').writeFileSync('src/value.mjs', 'export const value = 3;\\n')"] };
  const first = await implement({ ...f, id: f.task.task_id, driver });
  assert.equal(first.status, 'failed');
  await retry({ ...f, id: f.task.task_id, expectedRevision: first.revision });
  const second = await implement({ ...f, id: f.task.task_id, driver });
  assert.equal(second.status, 'blocked'); assert.equal(second.reason, 'no-progress');
  assert.notEqual(second.run_id, first.run_id); assert.equal(second.attempts, 2);
});

test('interrupted work becomes uncertain and cannot replay; corrupt journal or missing evidence blocks recovery', async (t) => {
  const f = await fixture(t); const scoped = await f.init();
  await transition(f.root, f.lock, f.task.task_id, scoped.revision, 'implementing', { run_id: 'interrupted', attempts: 1 });
  assert.equal((await recover(f))[0].status, 'uncertain');
  assert.deepEqual(await recover(f), []);
  await assert.rejects(implement({ ...f, id: f.task.task_id }), /freshly scoped/);
  await fs.appendFile(path.join(f.root, 'events.jsonl'), '{"partial":');
  await assert.rejects(recover(f), /Incomplete journal tail/);
});

test('fencing rejects a second writer and a stale owner; evidence hashes detect loss or alteration', async (t) => {
  const f = await fixture(t);
  await assert.rejects(lockStore(f.root), /writer/);
  await assert.rejects(lockStore(f.root, { recover: true }), /live writer/);
  const artifact = await putArtifact(f.root, 'proof');
  await fs.writeFile(path.join(f.root, artifact.path), 'changed');
  await assert.rejects(readArtifact(f.root, artifact), /hash mismatch/);
  await fs.unlink(path.join(f.root, artifact.path));
  await assert.rejects(readArtifact(f.root, artifact), /ENOENT/);
  await fs.writeFile(path.join(f.root, 'writer.lock'), JSON.stringify({ token: 'new-owner' }));
  await assert.rejects(f.lock.append('test', {}), /Stale writer/);
});

test('unknown external outcomes require reconciliation and never authorize duplicate effects', () => {
  const intent = { type: 'action/intent', data: { action_id: 'push-1' } };
  assert.equal(actionIntent([], 'push-1', {}).allowed, true);
  assert.equal(actionIntent([intent], 'push-1', {}).status, 'uncertain');
  assert.equal(actionIntent([intent, { type: 'action/result', data: { action_id: 'push-1' } }], 'push-1', {}).allowed, false);
});

test('budgets include failed requests and keep missing costs unknown', () => {
  const known = { request_id: 'a', status: 'failed', cost_usd: 1, accounting_complete: true };
  const records = [known, known, { request_id: 'child', status: 'completed', cost_usd: 2, accounting_complete: true }];
  assert.equal(usageLedger(records).total_cost_usd, 3);
  const unknown = usageLedger([...records, { request_id: 'compaction', status: 'failed', cost_usd: null }]);
  assert.equal(unknown.total_cost_usd, null); assert.equal(unknown.known_cost_usd, 3);
  const args = { policy, startedAt: 1000, now: 1001, attempts: 0, usage: unknown, paid: true, unattended: true };
  assert.equal(mayAttempt(args), 'unknown-cost');
  assert.equal(mayAttempt({ ...args, attempts: 3 }), 'attempt-budget');
  assert.equal(mayAttempt({ ...args, now: 2700001 }), 'wall-budget');
  assert.equal(mayAttempt({ ...args, fingerprint: 'same', previousFingerprint: 'same' }), 'no-progress');
  assert.throws(() => usageLedger([known, { ...known, cost_usd: 4 }]), /Conflicting/);
});

test('partial review advances only through its saved report and quiet windows stay quiet', async (t) => {
  const f = await fixture(t);
  for (const subject of ['one', 'two', 'three']) command(f.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', subject);
  const end = command(f.repo, 'rev-parse', 'HEAD');
  const window = await reviewWindow({ ...f, start: f.sha, end, limit: 2 });
  assert.equal(window.remaining, 1);
  await assert.rejects(recordReview({ ...f, window, report: { summary: 'partial', reviewed_commits: [window.commits[0]] } }), /exactly/);
  assert.equal((await readJournal(f.root)).length, 0);
  await recordReview({ ...f, window, report: { summary: 'reviewed', reviewed_commits: window.commits } });
  const rest = await reviewWindow({ ...f, end });
  assert.equal(rest.commits.length, 1);
  await recordReview({ ...f, window: rest, report: { summary: 'reviewed', reviewed_commits: rest.commits } });
  assert.equal((await reviewWindow({ ...f, end })).quiet, true);
  await assert.rejects(reviewWindow({ ...f, start: f.sha, end }), /disagrees/);
});

test('repeated review of one incident cannot become three independent days', () => {
  const one = { pattern_key: 'retry', incident_id: 'one', occurred_at: '2026-10-12T12:00:00Z', evidence: ['commit-a'] };
  assert.equal(lessonState([one, one, one], 'retry').seen, 1);
  assert.equal(lessonState([one, one, one], 'retry').proposal_ready, false);
  assert.throws(() => lessonState([one, { ...one, occurred_at: '2026-10-13T12:00:00Z' }], 'retry'), /new occurrence date/);
  assert.equal(lessonState([one, { ...one, incident_id: 'two', occurred_at: '2026-10-13T12:00:00Z' },
    { ...one, incident_id: 'three', occurred_at: '2026-10-14T12:00:00Z' }], 'retry').proposal_ready, true);
});

test('verified artifacts restore a lost candidate without replaying a worker', async (t) => {
  const f = await fixture(t); await f.init();
  const ready = await implement({ ...f, id: f.task.task_id });
  await fs.rm(ready.workspace, { recursive: true });
  const restored = await restoreCandidate({ ...f, id: f.task.task_id });
  assert.equal(restored.candidate_sha, ready.candidate_sha);
  assert.equal(await fs.readFile(path.join(restored.workspace, 'src/value.mjs'), 'utf8'), 'export const value = 2;\n');
  assert.equal(command(restored.workspace, 'write-tree'), ready.candidate_tree);
  await assert.rejects(restoreCandidate({ ...f, id: f.task.task_id }), /already exists/);
});

test('report persistence failure cannot advance the review cursor', async (t) => {
  const f = await fixture(t);
  command(f.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'one');
  const window = await reviewWindow({ ...f, start: f.sha, end: command(f.repo, 'rev-parse', 'HEAD') });
  await fs.writeFile(path.join(f.root, 'artifacts'), 'not a directory');
  await assert.rejects(recordReview({ ...f, window, report: { summary: 'reviewed', reviewed_commits: window.commits } }));
  assert.equal((await readJournal(f.root)).length, 0);
});

test('a hidden staged change outside the contract cannot enter a verified commit', async (t) => {
  const f = await fixture(t); const scoped = await f.init();
  await fs.writeFile(path.join(scoped.workspace, 'untouched.txt'), 'unverified staged content\n');
  command(scoped.workspace, 'add', 'untouched.txt');
  await fs.writeFile(path.join(scoped.workspace, 'untouched.txt'), 'keep\n');
  const result = await implement({ ...f, id: f.task.task_id });
  assert.notEqual(result.status, 'review_ready');
  assert.match(result.reason, /outside the contract/);
});

test('verified new files and executable modes are included in the complete patch', async (t) => {
  const f = await fixture(t); f.task.allowed_files.push('src/new.mjs');
  const scoped = await f.init();
  await fs.writeFile(path.join(scoped.workspace, 'src/new.mjs'), 'export const added = true;\n');
  await fs.chmod(path.join(scoped.workspace, 'src/new.mjs'), 0o755);
  const result = await implement({ ...f, id: f.task.task_id });
  assert.equal(result.status, 'review_ready');
  const evidence = JSON.parse(await readArtifact(f.root, result.evidence));
  const patch = (await readArtifact(f.root, evidence.patch)).toString();
  assert.match(patch, /new file mode 100755/);
  assert.match(patch, /export const added = true;/);
  assert.match(command(f.repo, 'ls-tree', result.candidate_sha, '--', 'src/new.mjs'), /^100755 blob/);
  assert.equal(command(f.repo, 'show', result.candidate_sha + ':src/new.mjs'), 'export const added = true;');
});

test('a candidate mode change during checks invalidates the verified content', async (t) => {
  const f = await fixture(t); const scoped = await f.init();
  const execute = async (options) => {
    const result = await f.execute(options);
    if (options.workspace.includes(path.sep + 'verification' + path.sep)) {
      await fs.chmod(path.join(scoped.workspace, 'src/value.mjs'), 0o755);
    }
    return result;
  };
  const result = await implement({ ...f, execute, id: f.task.task_id });
  assert.notEqual(result.status, 'review_ready');
  assert.match(result.reason, /changed during verification/);
});

test('trusted materials and journal hashes cannot be silently rewritten', async (t) => {
  const f = await fixture(t); const state = await f.init();
  await fs.writeFile(path.join(state.material, 'profile/agent.edn'), 'tampered');
  await assert.rejects(verify({ ...f, id: f.task.task_id }), /material hash mismatch/);
  const file = path.join(f.root, 'events.jsonl');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('test-task', 'evil-task'));
  await assert.rejects(readJournal(f.root), /hash\/sequence mismatch/);
});

const boundedBudget = { schema_version: 1, model: 'fixture-model', effort: 'medium', task_usd: 1, daily_usd: 2,
  max_requests: 3, context_window_tokens: 4096, max_output_tokens: 512, input_usd_per_million: 1,
  output_usd_per_million: 2, price_valid_until: '2099-01-01T00:00:00Z', price_source: 'https://example.invalid/ceiling' };

test('budgeted controller routes the worker through a credential-free disconnected broker and still verifies the patch', async (t) => {
  const f = await fixture(t); await f.init(); let opened = 0, closed = 0;
  const result = await implement({ ...f, id: f.task.task_id, budget: boundedBudget,
    driver: { mode: 'qi-budgeted', paid: true, unattended: false },
    brokerFactory: async ({ directory }) => { opened++; await fs.mkdir(directory); return { failure: () => null, close: async () => { closed++; } }; },
    execute: async (options) => {
      if (options.readonly) return f.execute(options);
      assert.equal(options.network, false); assert.deepEqual(options.envNames, []);
      assert.equal(options.argv[1], '/controller/maintenance/relay.mjs');
      assert.equal(options.mounts.find((m) => m.target === '/gateway').writable, true);
      await fs.writeFile(path.join(options.workspace, 'src/value.mjs'), 'export const value = 2;\n');
      return { exit_code: 0, stdout: JSON.stringify({ type: 'result', ok: true, result: { status: 'completed' } }) + '\n', stderr: '' };
    } });
  assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(result.status, 'review_ready');
});

test('unattended mode cannot bypass exact task authorization or a failed baseline', async (t) => {
  const f = await fixture(t); f.task.checks[0].argv = ['node', '-e', 'process.exit(1)']; await f.init();
  let opened = 0;
  const options = { ...f, id: f.task.task_id, budget: boundedBudget, brokerFactory: async () => { opened++; } };
  await assert.rejects(implement({ ...options, driver: { mode: 'qi-budgeted', paid: true, unattended: true } }), /authorization/);
  const result = await implement({ ...options, driver: { mode: 'qi-budgeted', paid: true, unattended: false } });
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'baseline-failed'); assert.equal(opened, 0);
});

test('worker/container failures close the broker and preserve an uncertain terminal', async (t) => {
  const f = await fixture(t); await f.init(); let closed = false;
  const result = await implement({ ...f, id: f.task.task_id, budget: boundedBudget,
    driver: { mode: 'qi-budgeted', paid: true, unattended: false },
    brokerFactory: async () => ({ failure: () => null, close: async () => { closed = true; } }),
    execute: async (options) => options.readonly ? f.execute(options) : Promise.reject(new Error('container cleanup unknown')) });
  assert.equal(closed, true); assert.equal(result.status, 'uncertain'); assert.match(result.reason, /cleanup unknown/);
});


test('direct paid credentials are refused before any implementation or check dispatch', async (t) => {
  const f = await fixture(t);
  const scoped = await f.init();
  let calls = 0;
  await assert.rejects(implement({ ...f, id: f.task.task_id,
    driver: { mode: 'qi-supervised', paid: true, unattended: false },
    execute: async () => { calls++; throw new Error('unexpected dispatch'); } }), /[Pp]aid.*broker/);
  assert.equal(calls, 0);
  const events = await readJournal(f.root);
  assert.equal(events.some(event => event.type === 'task/transition' && event.data?.status === 'implementing'), false);
  assert.equal(scoped.attempts, 0);
});
