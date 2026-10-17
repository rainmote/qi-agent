import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lockStore, readJournal } from '../lib/store.mjs';
import { validateBudget, reserveRequest, settleRequest, budgetSnapshot, reconcileBudget } from '../lib/budget.mjs';

export const config = { schema_version: 1, model: 'fixture-model', effort: 'medium', task_usd: 1, daily_usd: 2,
  max_requests: 3, context_window_tokens: 4096, max_output_tokens: 512, input_usd_per_million: 1,
  output_usd_per_million: 2, price_valid_until: '2099-01-01T00:00:00Z', price_source: 'https://example.invalid/reviewed-ceiling' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-budget-'));
  const lock = await lockStore(root);
  t.after(async () => { await lock.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { root, lock, config, taskId: 'task', runId: 'run', deadline: Date.now() + 60000 };
}
const response = { id: 'resp_fixture', model: 'fixture-model', service_tier: 'default', status: 'completed', usage: { input_tokens: 100, output_tokens: 20 } };

test('empty budget admits a first bounded request and settles conservative cost without claiming an invoice', async (t) => {
  const f = await fixture(t);
  const reservation = await reserveRequest({ ...f, requestId: 'first' });
  assert.equal(reservation.reserved_microusd, 5120);
  await assert.rejects(reserveRequest({ ...f, requestId: 'next' }), /unknown-cost/);
  await settleRequest({ ...f, reservation, response });
  const usage = budgetSnapshot(await readJournal(f.root), 'task');
  assert.equal(usage.task_microusd, 140); assert.equal(usage.invoice_cost_usd, null);
  assert.deepEqual(usage.uncertain, []);
  await assert.rejects(reserveRequest({ ...f, requestId: 'first' }), /duplicate-request/);
});

test('request, task and rolling daily limits are enforced before provider admission', async (t) => {
  const f = await fixture(t);
  await assert.rejects(reserveRequest({ ...f, config: { ...config, task_usd: 0.005 }, requestId: 'over' }), /cost-budget/);
  assert.equal((await readJournal(f.root)).length, 0);
  for (let i = 0; i < 3; i++) {
    const reservation = await reserveRequest({ ...f, requestId: 'call-' + i });
    await settleRequest({ ...f, reservation, response });
  }
  await assert.rejects(reserveRequest({ ...f, requestId: 'fourth' }), /request-budget/);
  await assert.rejects(reserveRequest({ ...f, taskId: 'another', config: { ...config, task_usd: .0053, daily_usd: .0053 }, requestId: 'daily' }), /cost-budget/);
  const expired = { ...f, deadline: Date.now() - 1 };
  await assert.rejects(reserveRequest({ ...expired, requestId: 'late' }), /wall-budget/);
});

test('missing, wrong-model, wrong-tier and oversized usage retain reservations and block later tasks', async (t) => {
  for (const bad of [null, { ...response, usage: null }, { ...response, model: 'other' }, { ...response, service_tier: 'priority' },
    { ...response, usage: { input_tokens: 5000, output_tokens: 20 } }]) {
    const f = await fixture(t), reservation = await reserveRequest({ ...f, requestId: 'unknown' });
    await settleRequest({ ...f, reservation, response: bad });
    const usage = budgetSnapshot(await readJournal(f.root), 'task');
    assert.equal(usage.task_microusd, 5120); assert.equal(usage.uncertain.length, 1);
    await assert.rejects(reserveRequest({ ...f, taskId: 'new', requestId: 'next' }), /unknown-cost/);
  }
});

test('a restarted controller retains an in-flight reservation even outside the daily window', async (t) => {
  const f = await fixture(t); await reserveRequest({ ...f, requestId: 'interrupted' });
  const events = await readJournal(f.root);
  const after = budgetSnapshot(events, 'task', Date.now() + 2 * 86400_000);
  assert.equal(after.daily_microusd, 5120); assert.deepEqual(after.uncertain, ['interrupted']);
});

test('concurrent controller and broker journal writes preserve every event in one hash chain', async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 32 }, (_, i) => f.lock.append('test/event', { i })));
  const events = await readJournal(f.root);
  assert.equal(events.length, 32);
  assert.deepEqual(events.map((e) => e.data.i), Array.from({ length: 32 }, (_, i) => i));
});

test('unconfigured, expired and unsafe budget values fail closed', () => {
  for (const bad of [{ ...config, task_usd: null }, { ...config, context_window_tokens: NaN },
    { ...config, price_valid_until: '2020-01-01' }, { ...config, input_usd_per_million: -1 },
    { ...config, daily_usd: 0.1 }, { ...config, task_usd: 1e30, daily_usd: 1e30 }]) assert.throws(() => validateBudget(bad));
});

test('racing reservations cannot both spend the same remaining budget', async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled(['one', 'two'].map((requestId) => reserveRequest({ ...f, requestId })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await readJournal(f.root)).filter((e) => e.type === 'budget/reserved').length, 1);
});

test('uncertain costs require a provider receipt and cannot be silently reset or reconciled twice', async (t) => {
  const f = await fixture(t); const reservation = await reserveRequest({ ...f, requestId: 'lost' });
  await settleRequest({ ...f, reservation, response: null });
  await assert.rejects(reconcileBudget({ ...f, receipt: { request_id: 'lost' } }), /provider receipt/);
  const receipt = { request_id: 'lost', role: 'human', reviewer: 'fixture', summary: 'Confirmed final charge',
    provider_receipt: 'fixture-receipt-1', charged_microusd: 180 };
  await reconcileBudget({ ...f, receipt });
  assert.deepEqual(budgetSnapshot(await readJournal(f.root), 'task').uncertain, []);
  assert.equal(budgetSnapshot(await readJournal(f.root), 'task').task_microusd, 180);
  await assert.rejects(reconcileBudget({ ...f, receipt }), /No uncertain request/);
});
