import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaults, codexArgs, codexEnvironment, checkCodex, decodeCodex, runCodex, codexLoop } from '../lib/codex.mjs';
import { lockStore, readJournal } from '../lib/store.mjs';
import { prepare, loadTask } from '../lib/controller.mjs';
import { git } from '../lib/execution.mjs';
import { runProcess } from '../../evals/lib/core.mjs';

const policy = JSON.parse(await fs.readFile(new URL('../policy.json', import.meta.url)));
const records = [
  { type: 'thread.started', thread_id: 'fixture' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Changed the candidate.' } },
  { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10, reasoning_output_tokens: 5 } },
];
const completed = (events = records) => ({ exit_code: 0, signal: null, error: null, timed_out: false, output_limited: false,
  stdout: events.map(event => JSON.stringify(event)).join('\n') + '\n', stderr: '', duration_ms: 1 });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-codex-loop-'));
  const repo = path.join(directory, 'repo'), root = path.join(directory, 'state'), verifier = path.join(directory, 'verifier');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true }); await fs.mkdir(verifier);
  await fs.writeFile(path.join(repo, 'src/value.mjs'), 'export const value = 1;\n');
  git(repo, 'init', '-b', 'main'); git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline');
  const base = git(repo, 'rev-parse', 'HEAD');
  const profile = path.join(directory, 'agent.edn'); await fs.writeFile(profile, '{:plugins []}\n');
  await fs.writeFile(path.join(verifier, 'acceptance.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
const { value } = await import('file://' + process.cwd() + '/src/value.mjs');
test('value is repaired', () => assert.equal(value, 2));\n`);
  const task = { schema_version: 1, task_id: 'codex-fixture', kind: 'bug', goal: 'Make value equal two',
    base_sha: base, image: 'sha256:' + 'a'.repeat(64), profile_path: profile, verifier_dir: verifier,
    allowed_files: ['src/value.mjs'], checks: [{ id: 'syntax', argv: ['node', '--check', 'src/value.mjs'], timeout_seconds: 10 }],
    acceptance: { file: 'acceptance.test.mjs', tests: ['value is repaired'] } };
  const lock = await lockStore(root);
  t.after(async () => { await lock.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const executions = [];
  const execute = async options => {
    executions.push(options);
    const argv = options.argv.map(arg => arg.startsWith('/acceptance/') ? path.join(options.mounts[0].source, arg.slice('/acceptance/'.length)) : arg);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    return runProcess(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), { cwd: options.workspace, env, timeoutMs: options.timeoutMs });
  };
  const doctor = async () => ({ version: 'fixture (not a real model)', authentication: 'fixture' });
  const init = () => prepare({ repo, root, controller: repo, task, policy, lock });
  return { directory, repo, root, task, lock, base, execute, doctor, init, executions, id: task.task_id };
}

test('Codex defaults pin the requested model and effort without API credentials or full-access flags', () => {
  const argv = codexArgs('/tmp/candidate');
  assert.equal(argv[argv.indexOf('--model') + 1], 'gpt-6.1-sol');
  assert.ok(argv.includes('model_reasoning_effort="xhigh"'));
  assert.ok(argv.includes('forced_login_method="chatgpt"'));
  assert.ok(argv.includes('workspace-write')); assert.ok(argv.includes('--ignore-user-config'));
  assert.equal(argv.some(arg => /dangerously|full-auto|add-dir/.test(arg)), false);
  assert.deepEqual(codexEnvironment({ PATH: '/bin', HOME: '/home/fixture', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', RANDOM_TOKEN: 'secret' }), { PATH: '/bin', HOME: '/home/fixture' });
  assert.throws(() => codexArgs('/tmp/candidate', { ...defaults, authentication: 'api' }), /configuration/);
});

test('doctor rejects changed CLI versions and API logins without invoking a model', async () => {
  for (const [version, login] of [['codex-cli 0.158.0', 'Logged in using ChatGPT'], ['codex-cli 0.157.1', 'Logged in using an API key']]) {
    await assert.rejects(checkCodex('fixture', async (_command, args) => ({ exit_code: 0, stdout: args[0] === '--version' ? version : login, stderr: '' })), /required/);
  }
});

test('success text and zero exit cannot replace a valid completed turn', () => {
  assert.equal(decodeCodex(completed()).status, 'completed');
  for (const result of [completed([]), completed(records.slice(0, -1)), completed([...records, records.at(-1)]),
    completed([records[3]]), completed([{ type: 'future.unknown' }]),
    { ...completed(), stdout: 'PASS\n' }, { ...completed(), timed_out: true },
    { ...completed(), exit_code: 1 }, { ...completed(), cancelled: true }]) assert.notEqual(decodeCodex(result).status, 'completed');
  assert.equal(decodeCodex(completed()).usage.input_tokens, 100, 'cached tokens are not added again');
});

test('independent red/green checks drive one repair and create a review candidate without changing main', async t => {
  const f = await fixture(t); await f.init();
  const prompts = [];
  const writer = async options => {
    prompts.push(options.prompt);
    await fs.writeFile(path.join(options.workspace, 'src/value.mjs'), `export const value = ${prompts.length === 1 ? 3 : 2};\n`);
    return completed();
  };
  const result = await codexLoop({ ...f, writer });
  assert.equal(result.status, 'review_ready'); assert.equal(result.attempts, 2);
  assert.match(prompts[1], /value is repaired/); assert.match(prompts[1], /ERR_ASSERTION/);
  assert.equal(await fs.readFile(path.join(f.repo, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.base);
  assert.equal(result.checks.find(check => check.phase === 'red').tap.reason, 'acceptance_assertions_failed');
  const journal = await readJournal(f.root);
  assert.equal(journal.filter(event => event.type === 'action/result').length, 2);
  assert.ok(journal.filter(event => event.type === 'implementation/result').every(event => event.data.usage.total_cost_usd === null));
});

test('repeated failed patches stop at no-progress instead of spending the third attempt', async t => {
  const f = await fixture(t); await f.init(); let calls = 0;
  const result = await codexLoop({ ...f, writer: async options => {
    calls++; await fs.writeFile(path.join(options.workspace, 'src/value.mjs'), 'export const value = 3;\n'); return completed();
  } });
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'no-progress'); assert.equal(calls, 2);
});

test('different failing candidates stop at the fixed three-attempt ceiling', async t => {
  const f = await fixture(t); await f.init(); let calls = 0;
  const result = await codexLoop({ ...f, writer: async options => {
    calls++; await fs.writeFile(path.join(options.workspace, 'src/value.mjs'), `export const value = ${calls + 2};\n`); return completed();
  } });
  assert.equal(result.status, 'failed'); assert.equal(calls, 3);
});

test('baseline failure and operator pause prevent model admission', async t => {
  for (const mode of ['baseline', 'pause']) {
    const f = await fixture(t);
    if (mode === 'baseline') f.task.checks[0].argv = ['node', '-e', 'process.exit(1)'];
    await f.init();
    if (mode === 'pause') await fs.writeFile(path.join(f.root, 'pause.json'), '{}');
    const result = await codexLoop({ ...f, writer: async () => assert.fail('writer must not run') });
    assert.equal(result.status, mode === 'baseline' ? 'blocked' : 'cancelled');
  }
});

test('missing terminal never verifies or automatically retries a written patch', async t => {
  const f = await fixture(t); await f.init(); let calls = 0;
  const result = await codexLoop({ ...f, writer: async options => {
    calls++; await fs.writeFile(path.join(options.workspace, 'src/value.mjs'), 'export const value = 2;\n'); return completed(records.slice(0, -1));
  } });
  assert.equal(result.status, 'uncertain'); assert.equal(calls, 1);
  assert.equal(f.executions.length, 2, 'only baseline and red were checked');
});

test('a process exception leaves durable intent and blocks new tasks until reconciliation', async t => {
  const f = await fixture(t); await f.init();
  const result = await codexLoop({ ...f, writer: async () => { throw new Error('lost process receipt'); } });
  assert.equal(result.status, 'uncertain');
  await assert.rejects(prepare({ ...f, controller: f.repo, policy, task: { ...f.task, task_id: 'next' } }), /Unresolved external action/);
});

test('Codex cannot consume the API-budgeted queue or change local launch configuration', async t => {
  const f = await fixture(t); const state = await f.init();
  await fs.mkdir(path.join(state.workspace, '.codex'));
  await assert.rejects(codexLoop({ ...f, writer: async () => assert.fail() }), /configuration/);
  await f.lock.append('queue/enqueued', { task_id: f.id });
  await assert.rejects(codexLoop({ ...f, writer: async () => assert.fail() }), /unattended queue/);
  assert.equal((await loadTask(f.root, f.id)).state.attempts, 0);
});

test('real subprocess receives stdin, records its PID, and preserves a completed JSONL stream', async () => {
  let pid;
  const result = await runCodex({ command: process.execPath,
    argv: ['-e', `let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{if(text!=='fixture prompt') process.exit(2);process.stdout.write(${JSON.stringify(completed().stdout)});});`],
    prompt: 'fixture prompt', workspace: os.tmpdir(), timeoutMs: 3000, shouldStop: async () => false, onSpawn: async value => { pid = value; } });
  assert.ok(Number.isSafeInteger(pid)); assert.equal(decodeCodex(result).status, 'completed');
});

test('process pause and deadline terminate the writer and cannot promote late success', async () => {
  for (const mode of ['pause', 'timeout']) {
    const result = await runCodex({ command: process.execPath, argv: ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      prompt: '', workspace: os.tmpdir(), timeoutMs: mode === 'timeout' ? 250 : 3000,
      shouldStop: async () => mode === 'pause', onSpawn: async () => {} });
    assert.equal(mode === 'timeout' ? result.timed_out : result.cancelled, true);
    assert.notEqual(decodeCodex(result).status, 'completed');
  }
});
