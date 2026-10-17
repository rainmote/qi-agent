import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startExternalRun } from '../../src/qi/external_cli.mjs';

const exec = promisify(execFile);
async function fixture(t, source, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'qi-external-test-'));
  const script = path.join(root, 'fake.mjs'); await writeFile(script, source);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, options: { workspaceRoot: root, command: [process.execPath, script], timeoutMs: 2000, ...options } };
}
const terminal = value => `process.stdout.write(JSON.stringify(${JSON.stringify({ type: 'result', status: 'completed', output: 'ok', ...value })})+'\\n');`;

test('CLI JSONL success requires process exit and keeps credentials and verification isolated', async t => {
  const f = await fixture(t, `process.stdin.resume(); process.stdin.once('data', text => {
    const start=JSON.parse(text); process.stdout.write(JSON.stringify({type:'progress',step:1})+'\\n');
    process.stdout.write(JSON.stringify({type:'result',status:'completed',output:JSON.stringify({cwd:process.cwd(),home:process.env.HOME,secret:process.env.QI_EXTERNAL_SECRET,prompt:start.prompt}),verification:'verified',accounting_complete:true,usage:{input_tokens:3,output_tokens:-1}})+'\\n'); });`);
  process.env.QI_EXTERNAL_SECRET = 'must-not-cross'; t.after(() => delete process.env.QI_EXTERNAL_SECRET);
  const first = await startExternalRun(f.options, { prompt: 'literal $() `text`' });
  const result = await first.result, output = JSON.parse(result.output);
  assert.equal(result.status, 'completed'); assert.equal(result.verification, 'not-run');
  assert.equal(result.accounting_complete, false); assert.equal(result.total_cost_usd, null);
  assert.deepEqual(result.usage, { input_tokens: 3 }); assert.equal(output.secret, undefined);
  assert.equal(output.cwd, first.cwd); assert.equal(output.home, first.home);
  assert.equal(output.prompt, 'literal $() `text`');
  const second = await startExternalRun(f.options); assert.notEqual(first.cwd, second.cwd); await second.result;
});

test('nonzero exit, absent terminal and malformed JSONL never become completed', async t => {
  for (const [source, status, reason] of [
    [terminal({}) + 'process.exitCode=7;', 'failed', 'process-exit'],
    ['', 'uncertain', 'missing-terminal'],
    ["process.stdout.write('not json\\n'); setInterval(()=>{},100);", 'failed', 'invalid-jsonl'],
    [terminal({}) + terminal({}), 'failed', 'invalid-jsonl']
  ]) {
    const f = await fixture(t, source), result = await (await startExternalRun(f.options)).result;
    assert.equal(result.status, status); assert.equal(result.reason, reason);
  }
});

test('output is bounded and stderr retains only a bounded tail', async t => {
  const f = await fixture(t, "process.stderr.write('prefix'+'.'.repeat(5000)+'END');" + terminal({}), { stderrBytes: 32 });
  const result = await (await startExternalRun(f.options)).result;
  assert.equal(Buffer.byteLength(result.stderr_tail), 32); assert.ok(result.stderr_tail.endsWith('END'));
  const flood = await fixture(t, "process.stdout.write('x'.repeat(10000));setInterval(()=>{},10);", { maxOutputBytes: 128 });
  assert.equal((await (await startExternalRun(flood.options)).result).reason, 'output-limit');
});

test('interrupt and stop fence late completed events', async t => {
  for (const method of ['interrupt', 'stop']) {
    const f = await fixture(t, `process.on('SIGTERM',()=>{${terminal({})}process.exit(0);});process.stdout.write(JSON.stringify({type:'progress'})+'\\n');setInterval(()=>{},100);`);
    const run = await startExternalRun(f.options);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(run[method](), true); assert.equal(run[method](), false);
    const result = await run.result;
    assert.equal(result.status, 'cancelled'); assert.equal(result.reason, method === 'stop' ? 'stopped' : 'cancelled');
    assert.equal(result.output, '');
  }
});

test('deadline reclaims an uncooperative process group including its child', async t => {
  const f = await fixture(t, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},100)"],{stdio:'inherit'});
    writeFileSync('child.pid',String(child.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100);`, { timeoutMs: 400 });
  const run = await startExternalRun(f.options), result = await run.result;
  assert.equal(result.status, 'uncertain'); assert.equal(result.reason, 'timeout');
  const pid = Number(await readFile(path.join(run.cwd, 'child.pid'), 'utf8'));
  // A killed grandchild may briefly remain as a zombie until its parent reaps it.
  let alive = true;
  for (let attempt = 0; attempt < 50 && alive; attempt++) {
    try { const { stdout } = await exec('ps', ['-o', 'stat=', '-p', String(pid)]); alive = !stdout.trim().startsWith('Z'); }
    catch { alive = false; }
    if (alive) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(alive, false, `grandchild ${pid} survived cleanup`);
  assert.ok(result.elapsed_ms < 2000);
});

test('invalid argv and limits are rejected before any child starts', async t => {
  const f = await fixture(t, terminal({}));
  await assert.rejects(startExternalRun({ ...f.options, command: ['node', 'x'] }), /absolute/);
  await assert.rejects(startExternalRun({ ...f.options, timeoutMs: 0 }), /limit/);
  await assert.rejects(startExternalRun({ ...f.options, stderrBytes: 10000000 }), /limit/);
});

test('Babashka registry exposes start wait interrupt stop through the opt-in bridge', async t => {
  const f = await fixture(t, terminal({}));
  const script = path.join(f.root, 'registry.clj');
  await writeFile(script, `(require '[qi.plugin :as p] '[qi.kernel :as k])
    (let [ctx (p/boot! {:plugins [{:ns 'qi.plugins.subagent} {:ns 'qi.plugins.subagent-external-cli :config
      {:enabled true :node ${JSON.stringify(process.execPath)} :workspace-root ${JSON.stringify(f.root)} :command [${f.options.command.map(JSON.stringify).join(' ')}]}}]})]
      (try (let [r (k/require-service ctx :subagents/runtime) j ((:start! r) {:provider :external-cli :prompt "fake"}) v ((:wait! r) (:id j) 5000)]
        (assert (= :completed (:status v))) (assert (= :not-run (:verification v)))
        (assert (false? (:accounting_complete v))) (assert ((:stop! r) (:id j))))
      (finally (k/dispose-all! ctx))))`);
  await exec('bb', ['--classpath', 'src:plugins', script], { timeout: 10000 });
});
