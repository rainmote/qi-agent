import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBroker, providerBody } from '../lib/broker.mjs';
import { validateBudget, reserveRequest, settleRequest, budgetSnapshot } from '../lib/budget.mjs';
import { lockStore, readJournal, durableWrite, encode } from '../lib/store.mjs';
import { runProcess } from '../../evals/lib/core.mjs';

const controller = fileURLToPath(new URL('../..', import.meta.url));
const config = { schema_version: 1, provider: 'deepseek', model: 'deepseek-flash', effort: 'high',
  task_usd: 20, daily_usd: 20, max_requests: 64, context_window_tokens: 1048576, max_output_tokens: 8192,
  input_usd_per_million: 0.3, output_usd_per_million: 1.2,
  price_valid_until: '2099-01-01T00:00:00Z', price_source: 'https://example.invalid/test-only-price' };
const reasoning = { id: 'rs_fixture', type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Fixture tool context.' }] };
const input = { model: config.model, input: [{ role: 'user', content: 'fixture task' }], tools: [] };
const response = { id: 'resp_fixture', model: config.model, status: 'completed',
  usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 90 },
    output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 120 }, output: [] };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-deepseek-')), lock = await lockStore(root);
  t.after(async () => { await lock.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, lock, config, taskId: 'fixture', runId: 'fixture-run', deadline: Date.now() + 60_000 };
}

test('provider selection rejects ambiguous model routing, arbitrary hosts and unsupported DeepSeek effort', () => {
  assert.equal(validateBudget(config), config);
  for (const patch of [{ provider: 'unreviewed' }, { provider: 'openai' }, { provider: undefined },
    { provider: 'https://other.invalid' }, { model: 'deepseek-v4.1-flash' }, { model: 'other' }, { effort: 'medium' }]) {
    assert.throws(() => validateBudget({ ...config, ...patch }), /provider|DeepSeek|deepseek/i);
  }
});

test('DeepSeek stateless tool rounds retain plaintext reasoning and omit unsupported OpenAI controls', () => {
  const body = providerBody({ ...input, input: [reasoning,
    { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'write', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_fixture', output: 'written' }],
    service_tier: 'priority', max_output_tokens: 999999 }, config);
  assert.deepEqual(body.input[0], reasoning);
  assert.equal(body.reasoning.effort, 'high'); assert.equal(body.max_output_tokens, 8192);
  for (const key of ['include', 'service_tier', 'background', 'truncation']) assert.equal(key in body, false);
  assert.equal(body.stream, false);
  for (const item of [
    { ...reasoning, encrypted_content: 'unsupported-ciphertext' },
    { ...reasoning, summary: [{ type: 'summary_text', text: 'would be silently discarded' }] },
    { ...reasoning, content: [{ type: 'input_image', image_url: 'https://other.invalid' }] },
    { ...reasoning, content: undefined }, { type: 'item_reference', id: 'rs_other' },
  ]) assert.throws(() => providerBody({ ...input, input: [item] }, config));
});

test('DeepSeek usage without service tier settles at peak uncached rates, including reasoning tokens', async (t) => {
  const f = await fixture(t), reservation = await reserveRequest({ ...f, requestId: 'first' });
  assert.equal(reservation.reserved_microusd, 324404);
  const settled = await settleRequest({ ...f, reservation, response });
  assert.equal(settled.known, true); assert.equal(settled.charged_microusd, 54);
  const events = await readJournal(f.root);
  assert.equal(events.at(-1).data.provider, 'deepseek');
  assert.equal(budgetSnapshot(events, 'fixture').invoice_cost_usd, null);
  assert.deepEqual(budgetSnapshot(events, 'fixture').uncertain, []);
});

test('DeepSeek unknown tiers, models and missing or oversized usage cannot release the reservation', async (t) => {
  for (const patch of [{ service_tier: 'priority' }, { model: 'other' }, { usage: null },
    { usage: { input_tokens: 1, output_tokens: 8193 } }, { usage: { input_tokens: 1048577, output_tokens: 1 } }]) {
    const f = await fixture(t), reservation = await reserveRequest({ ...f, requestId: 'bad' });
    assert.equal((await settleRequest({ ...f, reservation, response: { ...response, ...patch } })).known, false);
    await assert.rejects(reserveRequest({ ...f, requestId: 'next' }), /unknown-cost/);
  }
});

test('DeepSeek broker selects only its dedicated credential and fixed endpoint after durable reservation', async (t) => {
  const f = await fixture(t), directory = path.join(f.root, 'gateway');
  const old = { deepseek: process.env.DEEPSEEK_API_KEY, openai: process.env.OPENAI_API_KEY };
  t.after(() => {
    for (const [key, value] of [['DEEPSEEK_API_KEY', old.deepseek], ['OPENAI_API_KEY', old.openai]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.OPENAI_API_KEY = 'wrong-provider-fixture'; delete process.env.DEEPSEEK_API_KEY;
  await assert.rejects(startBroker({ ...f, directory }), /DEEPSEEK_API_KEY/);
  process.env.DEEPSEEK_API_KEY = 'deepseek-fixture';
  let calls = 0;
  const broker = await startBroker({ ...f, directory, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/responses');
    assert.equal(options.headers.authorization, 'Bearer deepseek-fixture');
    assert.equal(options.redirect, 'error');
    assert.equal((await readJournal(f.root)).at(-1).type, 'budget/reserved');
    return Response.json(response);
  } });
  try {
    const id = randomUUID(), reply = path.join(directory, id + '.response.json');
    await durableWrite(path.join(directory, id + '.request.json'), encode({ method: 'POST', path: '/v1/responses', body: input }));
    let result;
    for (let i = 0; i < 300 && !result; i++) {
      result = await fs.readFile(reply, 'utf8').then(JSON.parse, (e) => { if (e.code !== 'ENOENT') throw e; });
      if (!result) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(result?.status, 200); assert.equal(calls, 1); assert.equal(broker.failure(), null);
  } finally { await broker.close(); }
});

test('native worker and relay preserve DeepSeek reasoning through a real tool round trip without a provider key', async (t) => {
  const f = await fixture(t), profile = path.join(f.root, 'agent.edn'), budget = path.join(f.root, 'budget.json');
  await fs.writeFile(budget, encode(config));
  execFileSync(process.execPath, [path.join(controller, 'maintenance/profile.mjs'), config.model, config.effort, profile, budget]);
  const generated = await fs.readFile(profile, 'utf8');
  assert.match(generated, /QI_MAINTENANCE_BROKER_ONLY/);
  await fs.writeFile(profile, generated.replaceAll('"/work"', JSON.stringify(f.root)));
  let calls = 0;
  const broker = await startBroker({ ...f, directory: path.join(f.root, 'gateway'), credential: 'fixture-only', fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/responses');
    const body = JSON.parse(options.body);
    assert.ok(calls <= 2); assert.equal(body.model, 'deepseek-flash');
    const event = (await readJournal(f.root)).at(-1);
    assert.equal(event.type, 'budget/reserved'); assert.equal(event.data.purpose, 'main');
    assert.match(event.data.logical_request_id, /^[a-f0-9-]{36}$/);
    if (calls === 2) {
      assert.deepEqual(body.input.find((i) => i.type === 'reasoning'), reasoning);
      const toolOutput = body.input.find((i) => i.type === 'function_call_output' && i.call_id === 'call_fixture');
      assert.ok(toolOutput);
      assert.equal(await fs.readFile(path.join(f.root, 'probe.txt'), 'utf8').catch(() => toolOutput.output), 'native DeepSeek fixture verified\n');
    }
    return Response.json({ ...response, id: 'resp_fixture_' + calls, output: calls === 1 ? [reasoning,
      { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'write', arguments: JSON.stringify({
        path: 'probe.txt', content: 'native DeepSeek fixture verified\n' }) }]
      : [{ id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }] });
  } });
  try {
    const env = { PATH: process.env.PATH, HOME: f.root, TMPDIR: os.tmpdir() };
    const run = await runProcess(process.execPath, [path.join(controller, 'maintenance/relay.mjs'), broker.directory,
      'bb', '--classpath', path.join(controller, 'src') + ':' + path.join(controller, 'plugins'),
      path.join(controller, 'maintenance/worker.clj'), profile, 'Write the fixture file, then finish.'],
    { cwd: f.root, timeoutMs: 15_000, env });
    assert.equal(run.exit_code, 0, run.stderr + run.stdout);
    const terminal = run.stdout.split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.type === 'result').at(-1);
    assert.equal(terminal?.ok, true); assert.equal(terminal.result.status, 'completed');
    assert.equal(terminal.result['request-usage'].requests, 2);
    assert.equal(terminal.result['request-usage']['known-output-tokens'], 40);
    const usageEvents = run.stdout.split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.event === 'usage/request');
    assert.ok(usageEvents.length > 0); assert.ok(usageEvents.every((e) => e.data.provider === 'deepseek'));
    assert.equal(await fs.readFile(path.join(f.root, 'probe.txt'), 'utf8'), 'native DeepSeek fixture verified\n');
    assert.equal(calls, 2); assert.equal(broker.failure(), null);
    assert.equal(budgetSnapshot(await readJournal(f.root), 'fixture').task_microusd, 108);
  } finally { await broker.close(); }
});
