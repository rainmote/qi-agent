import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { lockStore, readJournal, encode, digest } from '../lib/store.mjs';
import { enqueue, tick, pause, resume, scheduleSlot } from '../lib/runner.mjs';
import { cleanupContainer } from '../lib/execution.mjs';
import { recover, transition } from '../lib/controller.mjs';

const command = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const budget = { schema_version: 1, model: 'fixture-model', effort: 'medium', task_usd: 1, daily_usd: 2,
  max_requests: 3, context_window_tokens: 4096, max_output_tokens: 512, input_usd_per_million: 1,
  output_usd_per_million: 2, price_valid_until: '2099-01-01T00:00:00Z', price_source: 'https://example.invalid/ceiling' };
const policy = JSON.parse(await fs.readFile(new URL('../policy.json', import.meta.url)));
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-runner-'));
  const repo = path.join(dir, 'repo'), root = path.join(dir, 'state'), verifier = path.join(dir, 'verifier');
  await fs.mkdir(repo); await fs.mkdir(verifier);
  await fs.writeFile(path.join(repo, 'readme.md'), 'fixture\n');
  command(repo, 'init', '-b', 'main'); command(repo, 'add', '.');
  command(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'fixture');
  const sha = command(repo, 'rev-parse', 'HEAD');
  const profile = path.join(dir, 'profile.edn'); await fs.writeFile(profile, '{:plugins []}');
  const lock = await lockStore(root);
  t.after(async () => { await lock.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
  const task = { schema_version: 1, task_id: 'queued-task', kind: 'docs', goal: 'Improve fixture explanation', base_sha: sha,
    image: 'sha256:' + 'a'.repeat(64), profile_path: profile, verifier_dir: verifier, allowed_files: ['readme.md'],
    red_not_applicable: 'Documentation task', checks: [{ id: 'check', argv: ['node', '-e', ''], timeout_seconds: 10 }] };
  const approval = { role: 'human', reviewer: 'fixture operator', scope: 'candidate-only', task_id: task.task_id, expires_at: '2099-01-01T00:00:00Z' };
  const config = { enabled: true, controller_sha: sha, schedule: { time: '02:00', timezone: 'Asia/Singapore', window_minutes: 60 }, trial_ids: [] };
  return { root, lock, repo, controller: repo, task, policy, budget, approval, config, now: new Date('2026-10-15T18:05:00Z') };
}

test('queue approval pins materials, deduplicates delivery and starts budget only when claimed', async (t) => {
  const f = await fixture(t);
  await enqueue(f); await enqueue(f);
  assert.equal((await readJournal(f.root)).filter((e) => e.type === 'queue/enqueued').length, 1);
  assert.equal((await readJournal(f.root)).some((e) => e.type === 'task/created'), false);
  await assert.rejects(enqueue({ ...f, task: { ...f.task, goal: 'different' } }), /different approved materials/);
  let calls = 0;
  const run = async () => { calls++; return { status: 'review_ready', candidate_sha: 'a'.repeat(40) }; };
  const result = await tick({ ...f, run, qualify: async () => {} });
  assert.equal(result.status, 'review_ready');
  assert.equal((await tick({ ...f, run })).status, 'already-ran'); assert.equal(calls, 1);
});

test('no paid execution without real matched development and held-out qualification', async (t) => {
  const f = await fixture(t); await enqueue(f);
  let calls = 0;
  const result = await tick({ ...f, run: async () => { calls++; } });
  assert.equal(result.status, 'paused'); assert.match(result.reason, /development trial/); assert.equal(calls, 0);
  const again = await tick({ ...f, run: async () => { calls++; } });
  assert.equal(again.status, 'paused');
  assert.equal((await tick(f)).quiet, true);
});

test('modified verifier or controller and expired authorizations stop before execution', async (t) => {
  for (const change of ['verifier', 'controller', 'expiry']) {
    const f = await fixture(t); await enqueue(f);
    if (change === 'verifier') await fs.writeFile(path.join(f.task.verifier_dir, 'changed'), 'x');
    if (change === 'controller') await fs.writeFile(path.join(f.repo, 'readme.md'), 'changed');
    if (change === 'expiry') f.now = new Date('2100-01-01T18:05:00Z');
    let calls = 0;
    const result = await tick({ ...f, run: async () => { calls++; }, qualify: async () => {} });
    assert.equal(result.status, 'paused'); assert.equal(calls, 0);
  }
});

test('disabled and out-of-window ticks are silent; pause works without acquiring the writer lock', async (t) => {
  const f = await fixture(t); await enqueue(f);
  assert.equal((await tick({ ...f, config: { ...f.config, enabled: false } })).quiet, true);
  assert.equal(scheduleSlot(f.config.schedule, new Date('2026-10-15T10:00:00Z')), null);
  await pause(f.root, 'operator-stop');
  assert.equal((await tick(f)).reason, 'operator-stop');
  await resume(f); assert.equal(await fs.stat(path.join(f.root, 'pause.json')).then(() => true, () => false), false);
});

test('scheduled DeepSeek tasks require the dedicated key before qualification and never borrow an OpenAI key', async (t) => {
  const before = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  for (const hasKey of [false, true]) {
    const f = await fixture(t);
    f.budget = { ...f.budget, provider: 'deepseek', model: 'deepseek-flash', effort: 'high' };
    await enqueue(f);
    if (hasKey) { process.env.DEEPSEEK_API_KEY = 'fixture-only'; delete process.env.OPENAI_API_KEY; }
    else { delete process.env.DEEPSEEK_API_KEY; process.env.OPENAI_API_KEY = 'wrong-provider-fixture'; }
    const result = await tick(f);
    assert.equal(result.status, 'paused');
    assert.match(result.reason, hasKey ? /development trial/ : /DEEPSEEK_API_KEY/);
    assert.equal((await readJournal(f.root)).some((e) => e.type === 'budget/reserved' || e.type === 'task/created'), false);
  }
});

test('container recovery verifies ownership and removes the inspected immutable ID', async () => {
  const name = 'qi-maint-' + 'a'.repeat(36), owner = 'b'.repeat(36), id = 'c'.repeat(64), calls = [];
  const run = async (_, args) => { calls.push(args); return args[0] === 'inspect' ?
    { exit_code: 0, stdout: JSON.stringify([{ Id: id, Config: { Labels: { 'qi.maintenance.owner': owner } } }]) } : { exit_code: 0 }; };
  assert.equal((await cleanupContainer(name, owner, run)).status, 'removed');
  assert.deepEqual(calls[1], ['rm', '-f', id]);
  await assert.rejects(cleanupContainer(name, 'd'.repeat(36), run), /ownership mismatch/);
  await assert.rejects(cleanupContainer('other-container', owner, run), /ownership receipt/);
});

test('container recovery pins original host and refuses a replacement engine before inspection',async()=>{
  const name='qi-maint-'+'a'.repeat(36),owner='b'.repeat(36),calls=[];
  const environment={host:'unix:///original.sock',engine:'original',endpoint:digest('unix:///original.sock')};
  let engine='original';
  const run=async(_,args)=>{
    calls.push(args);assert.deepEqual(args.slice(0,2),['--host',environment.host]);
    return args[2]==='info'?{exit_code:0,stdout:engine}:{exit_code:1,stderr:'No such container: original'};
  };
  assert.equal((await cleanupContainer(name,owner,run,environment)).status,'absent');
  assert.deepEqual(calls.map(args=>args[2]),['info','inspect']);
  engine='replacement';calls.length=0;
  await assert.rejects(cleanupContainer(name,owner,run,environment),/Original engine identity/);
  assert.deepEqual(calls.map(args=>args[2]),['info']);
});

test('restart cleans recorded resources, retains uncertainty and never reruns the worker', async (t) => {
  const f = await fixture(t); await enqueue(f);
  await tick({ ...f, qualify: async () => {}, run: async ({ id }) => {
    const created = (await readJournal(f.root)).filter((e) => e.type === 'task/transition').at(-1);
    return transition(f.root, f.lock, id, created.seq, 'implementing', { container: 'qi-maint-' + 'a'.repeat(36), container_owner: 'b'.repeat(36) });
  } });
  const cleaned = [];
  const recovered = await recover({ ...f, cleanup: async (name, owner) => { cleaned.push({ name, owner }); return { status: 'removed', container: name }; } });
  assert.equal(cleaned.length, 1); assert.equal(recovered[0].status, 'uncertain');
  await assert.rejects(resume(f), /acknowledgement/);
  await resume({ ...f, acknowledgement: { role: 'human', reviewer: 'fixture', summary: 'Verified container stopped and no external effect', task_ids: [f.task.task_id] } });
});
