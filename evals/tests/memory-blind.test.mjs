import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepare, assembleRecall, references, grade, budget, writePackage } from '../experiments/memory-blind.mjs';

const fixture = JSON.parse(await readFile('evals/experiments/memory-cases.json'));
const plan = await prepare(fixture);
const completed = (request_id, text) => ({ request_id, status: 'completed', finish_reason: 'stop', text });

test('blind compaction captures full original histories in both actual compressor arms', () => {
  assert.equal(plan.arms.length, 40);
  for (const [index, item] of fixture.cases.entries()) {
    const [checkpoint, layered] = plan.arms.slice(index * 2, index * 2 + 2);
    const content = arm => arm.requests.map(row => row.request.messages[0].content).join('');
    assert.equal(content(checkpoint), content(layered));
    for (const message of item.history) assert.ok(content(checkpoint).includes(message.content));
    assert.notEqual(checkpoint.requests[0].request['system-prompt'], layered.requests[0].request['system-prompt']);
    assert.ok(checkpoint.requests.length >= 2);
  }
  assert.equal(plan.model_calls, 0); assert.equal(plan.model_semantic_recall, null);
});

test('blind inputs never depend on hidden answers, annotations or descriptive case IDs', async () => {
  const changed = structuredClone(fixture);
  for (const item of changed.cases) { item.id = 'SECRET'; item.annotations = ['SECRET']; item.expected = { secret: 'SECRET' }; }
  assert.deepEqual(await prepare(changed), plan);
  assert.ok(!JSON.stringify(plan).includes('SECRET'));
});

test('recall waits for all complete unique chunks and never reads hidden answers', () => {
  const summaries = plan.arms.flatMap(arm => arm.requests.map(row => completed(row.request_id, 'summary')));
  const recall = assembleRecall(plan, summaries);
  assert.equal(recall.length, 40);
  assert.ok(recall[0].request.messages[0].content.endsWith('summary\n\nsummary'));
  assert.throws(() => assembleRecall(plan, summaries.slice(1)), /missing request outputs/);
  assert.throws(() => assembleRecall(plan, [...summaries, summaries[0]]), /duplicate/);
  for (const change of [{ status: 'failed' }, { finish_reason: 'length' }, { text: '' }, { request_id: 'unknown' }]) {
    assert.throws(() => assembleRecall(plan, [{ ...summaries[0], ...change }, ...summaries.slice(1)]));
  }
});

test('independent scorer distinguishes missing, stale, false and zero and counts prohibitions', () => {
  const refs = references(fixture);
  const outputs = plan.arms.map(arm => completed(arm.recall.request_id,
    JSON.stringify(Object.fromEntries(refs.find(row => row.case_id === arm.case_id).constraints.map(row => [row.key, row.value])))));
  const perfect = grade(plan, refs, outputs);
  assert.ok(perfect.arms.every(row => row.matched === 20 && row.target_met));
  const bad = structuredClone(outputs);
  for (const row of bad) row.text = '{}';
  const missing = grade(plan, refs, bad);
  assert.ok(missing.arms.every(row => row.matched === 0 && row.prohibition_omissions === 4));
  const boolean = bad.find(row => row.request_id === 'c15-checkpoint-recall');
  boolean.text = '{"enabled":0}';
  const zero = bad.find(row => row.request_id === 'c16-checkpoint-recall');
  zero.text = '{"retries":false}';
  assert.equal(grade(plan, refs, bad).arms[0].matched, 0);
  assert.equal(perfect.model_semantic_recall, null);
  assert.throws(() => grade(plan, refs, outputs.slice(1)), /missing/);
});

test('cost plans require explicit model, profile and positive price ceilings', () => {
  assert.equal(budget(plan).planned_upper_bound_usd, null);
  const config = { model: 'offline-fixture', profile_sha256: 'a'.repeat(64), max_input_tokens: 128000,
    max_output_tokens: 2048, input_usd_per_million: 1, output_usd_per_million: 4 };
  const value = budget(plan, config);
  assert.equal(value.requests, 120); assert.equal(value.planned_upper_bound_usd, 16.34304);
  assert.equal(value.cost_usd, null); assert.equal(value.status, 'declaration-only-no-live-transport');
  assert.throws(() => budget(plan, { ...config, input_usd_per_million: 0 }));
  assert.throws(() => budget(plan, { ...config, profile_sha256: null }));
});

test('package separates private verifier answers, fingerprints and NOT_RUN ledger without overwriting', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'qi-blind-package-'));
  const output = path.join(temp, 'first');
  try {
    const manifest = await writePackage(output, 'evals/experiments/memory-cases.json');
    assert.equal(manifest.ledger.length, 120);
    assert.ok(manifest.ledger.every(row => row.status === 'NOT_RUN' && row.usage === null));
    assert.equal(manifest.model_semantic_recall, null);
    assert.ok(!JSON.stringify(JSON.parse(await readFile(path.join(output, 'model-inputs/plan.json')))).includes('annotations'));
    assert.equal(JSON.parse(await readFile(path.join(output, 'verifier/answers.json'))).length, 20);
    await assert.rejects(() => writePackage(output, 'evals/experiments/memory-cases.json'), { code: 'EEXIST' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
