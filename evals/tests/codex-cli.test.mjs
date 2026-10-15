import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startExternalRun } from '../../src/qi/external_cli.mjs';
import { codexDecoder } from '../../src/qi/external_cli_codex.mjs';
const fixture = JSON.parse(await readFile(new URL('../fixtures/codex-exec-0.157.1.documented.json', import.meta.url)));
async function fake(t, events, body = '') {
  const root = await mkdtemp(path.join(tmpdir(), 'qi-codex-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Explicit ESM avoids Node probing the format of an extensionless executable.
  const command = path.join(root, 'codex-replay.mjs');
  const source = `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
    writeFileSync('loaded.json',JSON.stringify({at:Date.now()}));
    const emit=()=>{for(const e of ${JSON.stringify(events)})process.stdout.write(JSON.stringify(e)+'\\n');};
    let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
    writeFileSync('received.json',JSON.stringify({prompt,argv:process.argv.slice(2),home:process.env.HOME,codexHome:process.env.CODEX_HOME,secret:process.env.QI_CODEX_SECRET,key:process.env.OPENAI_API_KEY}));
    ${body || 'emit();'}});\n`;
  await writeFile(command, source, { mode: 0o700 });
  return { root, options: { command: [command], workspaceRoot: root, protocol: 'codex-exec-jsonl-v1',
    cliVersion: '0.157.1', cliSha256: createHash('sha256').update(source).digest('hex'),
    model: 'offline-fixture-model', timeoutMs: 2000 } };
}

test('documented replay preserves scoped tokens, raw prompt, fixed argv and isolated homes', async t => {
  assert.equal(fixture.observed_live_transcript, false);
  const f = await fake(t, fixture.events, "process.stderr.write('fixture stderr');emit();");
  const oldSecret = process.env.QI_CODEX_SECRET;
  process.env.QI_CODEX_SECRET = 'do-not-inherit';
  t.after(() => oldSecret === undefined ? delete process.env.QI_CODEX_SECRET : process.env.QI_CODEX_SECRET = oldSecret);
  const prompt = 'literal $() `text`\nsecond line';
  const h = await startExternalRun(f.options, { prompt }), r = await h.result;
  assert.equal(r.status, 'completed', JSON.stringify({ ...r, fixture_files: await readdir(h.cwd) })); assert.equal(r.output, 'offline bounded answer');
  assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 7, cached_input_tokens: 40, reasoning_output_tokens: 2 });
  assert.equal(r.usage_scope, 'external-turn-reported'); assert.equal(r.total_cost_usd, null);
  assert.equal(r.accounting_complete, false); assert.equal(r.verification, 'not-run');
  assert.equal(r.external_descriptor.multi_turn, false); assert.equal(r.external_descriptor.tool_filter, false);
  assert.equal(r.stderr_tail, 'fixture stderr'); assert.equal(r.progress_count, 3);
  const received = JSON.parse(await readFile(path.join(h.cwd, 'received.json')));
  assert.equal(received.prompt, prompt); assert.equal(received.home, h.home); assert.equal(received.codexHome, h.home);
  assert.equal(received.secret, undefined); assert.equal(received.key, undefined);
  assert.deepEqual(received.argv, ['--ask-for-approval', 'never', 'exec', '--json', '--ephemeral',
    '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check', '--model', 'offline-fixture-model', '-']);
});

test('failed, interrupted, missing, duplicate and nonzero streams cannot become completed', async t => {
  const opening = fixture.events.slice(0, 2);
  for (const [events, body, status, reason] of [
    [[...opening, { type: 'turn.failed', error: { message: 'fixture failure' } }], '', 'failed', 'codex-turn-failed'],
    [[...opening, { type: 'turn.interrupted' }], '', 'cancelled', 'codex-interrupted'],
    [fixture.events.slice(0, -1), '', 'uncertain', 'missing-terminal'],
    [[...fixture.events, fixture.events.at(-1)], '', 'failed', 'invalid-jsonl'],
    [fixture.events, 'emit();process.exitCode=7;', 'failed', 'process-exit'],
    [[{ type: 'error', message: 'startup failure' }], '', 'failed', 'codex-error']
  ]) {
    const f = await fake(t, events, body), r = await (await startExternalRun(f.options)).result;
    assert.equal(r.status, status, JSON.stringify(r)); assert.equal(r.reason, reason);
  }
});

test('unknown raw types and progress stay bounded without inventing a terminal', () => {
  const d = codexDecoder(); fixture.events.slice(0, 2).forEach(d.accept);
  for (let i = 0; i < 100; i++) {
    d.accept({ type: 'future.' + i });
    d.accept({ type: 'item.updated', item: { id: 'item-' + i, type: 'unknown-item-' + i } });
  }
  const m = d.metadata(); assert.equal(m.progress.length, 32); assert.equal(m.progress_count, 100);
  assert.equal(m.unknown_event_types.length, 32); assert.equal(m.unknown_item_types.length, 32);
  assert.equal(m.unknown_types_truncated, true); assert.ok(m.unknown_event_types.includes('future.0'));
});

test('version, executable bytes, model and raw-prompt types gate dispatch', async t => {
  const f = await fake(t, fixture.events);
  for (const change of [{ cliVersion: 'unverified' }, { cliSha256: '0'.repeat(64) }, { model: '' },
    { protocol: 'unknown' }, { command: [...f.options.command, '--unsafe-extra'] }]) {
    await assert.rejects(startExternalRun({ ...f.options, ...change }, { prompt: 'offline' }));
  }
  await assert.rejects(startExternalRun(f.options, { prompt: { invalid: true } }));
  assert.deepEqual(await readdir(f.root), ['codex-replay.mjs']);
});

test('cancel and timeout retain ownership and fence late completed transcripts', async t => {
  const f = await fake(t, fixture.events, "process.on('SIGTERM',()=>{emit();process.exit(0);});process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'ready'})+'\\n');setInterval(()=>{},100);");
  const h = await startExternalRun(f.options);
  for (let n = 0; n < 100; n++) {
    try { await readFile(path.join(h.cwd, 'received.json')); break; } catch { await new Promise(r => setTimeout(r, 5)); }
  }
  assert.equal(h.interrupt(), true); const r = await h.result;
  assert.equal(r.status, 'cancelled'); assert.equal(r.output, '');
  const stuck = await fake(t, fixture.events, "process.on('SIGTERM',()=>{});setInterval(()=>{},100);");
  const timed = await (await startExternalRun({ ...stuck.options, timeoutMs: 200 })).result;
  assert.equal(timed.status, 'uncertain'); assert.equal(timed.reason, 'timeout');
});

test('ordering errors, empty completion, duplicate answers and invalid usage fail conservatively', () => {
  for (const events of [
    [{ type: 'turn.completed' }],
    [...fixture.events.slice(0, 2), { type: 'turn.completed' }],
    [...fixture.events.slice(0, -1), fixture.events.at(-2)],
    [...fixture.events.slice(0, -1), { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 2 } }]
  ]) {
    const d = codexDecoder(); assert.throws(() => events.forEach(d.accept));
  }
});

test('actual Babashka registry forwards the pinned protocol and scoped external outcome', async t => {
  const f = await fake(t, fixture.events), script = path.join(f.root, 'registry.clj');
  await writeFile(script, `(require '[qi.plugin :as p] '[qi.kernel :as k])
    (let [ctx (p/boot! {:plugins [{:ns 'qi.plugins.subagent} {:ns 'qi.plugins.subagent-external-cli :config
      {:enabled true :node ${JSON.stringify(process.execPath)} :workspace-root ${JSON.stringify(f.root)}
       :command [${JSON.stringify(f.options.command[0])}] :protocol :codex-exec-jsonl-v1
       :cli-version "0.157.1" :cli-sha256 "${f.options.cliSha256}" :model "offline-fixture-model"}}]})]
      (try (let [r (k/require-service ctx :subagents/runtime) j ((:start! r) {:provider :external-cli :prompt "offline"})
                 v ((:wait! r) (:id j) 5000)]
        (assert (= :completed (:status v))) (assert (= :not-run (:verification v)))
        (assert (= "external-turn-reported" (:usage_scope v)))
        (assert (= 100 (get-in v [:usage :input_tokens])))
        (assert (false? (get-in v [:external_descriptor :multi_turn])))
        (assert (false? (:accounting_complete v))))
      (finally (k/dispose-all! ctx))))`);
  await promisify(execFile)('bb', ['--classpath', 'src:plugins', script], { timeout: 10000 });
});
