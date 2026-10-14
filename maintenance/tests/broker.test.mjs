import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lockStore, readJournal, durableWrite } from '../lib/store.mjs';
import { startBroker, providerBody } from '../lib/broker.mjs';

const config = { schema_version: 1, model: 'fixture-model', effort: 'medium', task_usd: 1, daily_usd: 2,
  max_requests: 3, context_window_tokens: 4096, max_output_tokens: 512, input_usd_per_million: 1,
  output_usd_per_million: 2, price_valid_until: '2099-01-01T00:00:00Z', price_source: 'https://example.invalid/ceiling' };
const input = { model: config.model, input: [{ role: 'user', content: 'repair the fixture' }], tools: [] };
async function fixture(t, fetchImpl) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-broker-')), lock = await lockStore(root);
  const directory = path.join(root, 'mailbox');
  const broker = await startBroker({ root, lock, config, taskId: 'task', runId: 'run', deadline: Date.now() + 10_000,
    directory, credential: 'fixture-credential', fetchImpl: (...args) => fetchImpl({ root, ...args }, args) });
  t.after(async () => { await broker.close(); await lock.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, lock, directory, broker };
}
async function request(f, body = input, route = '/v1/responses') {
  const id = randomUUID();
  await durableWrite(path.join(f.directory, id + '.request.json'), JSON.stringify({ method: 'POST', path: route, body }));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(path.join(f.directory, id + '.response.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('broker fixture timed out: ' + f.broker.failure());
}
test('host broker durably reserves before network and never forwards candidate credentials or higher limits', async (t) => {
  const f = await fixture(t, async ({ root }, [url, options]) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const events = await readJournal(root); assert.equal(events.at(-1).type, 'budget/reserved');
    const body = JSON.parse(options.body);
    assert.equal(body.max_output_tokens, 512); assert.equal(body.stream, false); assert.equal(body.store, false);
    assert.equal(body.service_tier, 'default'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer fixture-credential');
    return Response.json({ id: 'resp_fixture', model: config.model, service_tier: 'default', status: 'completed', usage: { input_tokens: 100, output_tokens: 20 }, output: [] });
  });
  assert.equal((await request(f, { ...input, max_output_tokens: 999999, service_tier: 'priority' })).status, 200);
  const raw = await fs.readFile(path.join(f.root, 'events.jsonl'), 'utf8');
  assert.equal(raw.includes('fixture-credential'), false); assert.equal(raw.includes('repair the fixture'), false);
});

test('provider errors preserve unknown charge and stop the broker without retrying', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('socket closed'); });
  assert.equal((await request(f)).status, 503);
  assert.equal(calls, 1); assert.equal(f.broker.failure(), 'unknown-cost');
  assert.equal((await readJournal(f.root)).at(-1).data.uncertain, true);
});

test('candidate requests cannot access other routes, hosted tools, remote content or provider state', async (t) => {
  for (const body of [{ ...input, model: 'expensive' }, { ...input, tools: [{ type: 'web_search' }] },
    { ...input, previous_response_id: 'resp_secret' }, { ...input, input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://host' }] }] },
    { ...input, input: [{ type: 'function_call_output', output: [{ type: 'input_image' }] }] }]) assert.throws(() => providerBody(body, config));
  let calls = 0;
  const f = await fixture(t, async () => { calls++; });
  assert.equal((await request(f, input, '/v1/files')).status, 503); assert.equal(calls, 0);
});

test('symlink requests cannot read host files or reach the provider', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; });
  await fs.symlink('/etc/passwd', path.join(f.directory, randomUUID() + '.request.json'));
  for (let i = 0; i < 100 && !f.broker.failure(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(f.broker.failure()); assert.equal(calls, 0);
});
