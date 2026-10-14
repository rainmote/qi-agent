#!/usr/bin/env node
// Exercise the actual Babashka worker, Responses adapter and tool round trip.
// The host provider is a deterministic fixture; no external model is called.
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startBroker } from './lib/broker.mjs';
import { budgetSnapshot } from './lib/budget.mjs';
import { lockStore, readJournal, durableWrite, encode } from './lib/store.mjs';
import { containerCommand, immutableImage, git } from './lib/execution.mjs';

const controller = fileURLToPath(new URL('..', import.meta.url)), output = process.argv[2];
if (!path.isAbsolute(output ?? '')) throw new Error('Usage: QI_MAINTENANCE_IMAGE=sha256:... node maintenance/worker-smoke.mjs ABS_NEW_OUTPUT');
const image = immutableImage(process.env.QI_MAINTENANCE_IMAGE);
await fs.mkdir(output);
const root = path.join(output, 'state'), workspace = path.join(output, 'workspace'), profile = path.join(output, 'profile');
await fs.mkdir(workspace); await fs.mkdir(profile);
const config = { schema_version: 1, model: 'fixture-model', effort: 'medium', task_usd: 1, daily_usd: 2,
  max_requests: 2, context_window_tokens: 100_000, max_output_tokens: 512, input_usd_per_million: 1,
  output_usd_per_million: 2, price_valid_until: '2099-01-01T00:00:00Z', price_source: 'https://example.invalid/fixture' };
const budgetFile = path.join(output, 'budget.json'); await durableWrite(budgetFile, encode(config));
execFileSync(process.execPath, [path.join(controller, 'maintenance/profile.mjs'), config.model, config.effort, path.join(profile, 'agent.edn'), budgetFile]);
const lock = await lockStore(root);
let broker, calls = 0;
try {
  broker = await startBroker({ root, lock, config, taskId: 'worker-fixture', runId: 'worker-fixture-run', deadline: Date.now() + 60000,
    directory: path.join(root, 'gateway'), credential: 'fixture-only-not-a-real-key', fetchImpl: async (_, options) => {
      calls++;
      const reservation = (await readJournal(root)).at(-1);
      assert.equal(reservation.type, 'budget/reserved');
      assert.match(reservation.data.logical_request_id, /^[a-f0-9-]{36}$/);
      assert.match(reservation.data.native_run_id, /^[a-f0-9-]{36}$/);
      assert.equal(reservation.data.purpose, 'main');
      const body = JSON.parse(options.body);
      assert.equal(body.tools.some((tool) => tool.name === 'write'), true);
      assert.ok(calls <= 2);
      if (calls === 2) assert.equal(body.input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_fixture' && typeof item.output === 'string'), true);
      return Response.json({ id: 'resp_fixture_' + calls, status: 'completed', model: config.model, service_tier: 'default',
        usage: { input_tokens: 100, output_tokens: 20 }, output: calls === 1 ? [
          { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'write', status: 'completed',
            arguments: JSON.stringify({ path: 'probe.txt', content: 'verified native worker\n' }) },
        ] : [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] }] });
    } });
  const result = await containerCommand({ image, workspace, readonly: false, timeoutMs: 50000,
    mounts: [{ source: controller, target: '/controller' }, { source: profile, target: '/profile' }, { source: broker.directory, target: '/gateway', writable: true }],
    argv: ['node', '/controller/maintenance/relay.mjs', '/gateway', 'bb', '--classpath', '/controller/src:/controller/plugins',
      '/controller/maintenance/worker.clj', '/profile/agent.edn', 'Write the supplied fixture content to probe.txt, then finish.'] });
  await broker.close();
  await durableWrite(path.join(output, 'execution.json'), encode(result));
  assert.equal(result.exit_code, 0, result.stderr + result.stdout);
  const terminal = result.stdout.split('\n').filter(Boolean).map(JSON.parse).filter((event) => event.type === 'result').at(-1);
  assert.equal(terminal?.ok, true); assert.equal(terminal.result.status, 'completed');
  assert.equal(terminal.result['request-usage'].requests, 2);
  assert.equal(terminal.result['request-usage']['known-input-tokens'], 200);
  assert.equal(terminal.result['request-usage']['known-output-tokens'], 40);
  assert.equal(await fs.readFile(path.join(workspace, 'probe.txt'), 'utf8'), 'verified native worker\n');
  const budget = budgetSnapshot(await readJournal(root), 'worker-fixture');
  assert.equal(calls, 2); assert.equal(budget.requests, 2); assert.equal(budget.uncertain.length, 0);
  const report = { status: 'PASS', mode: 'native-worker-with-host-fake-provider', model_calls: 0, fake_provider_calls: calls,
    source_sha: git(controller, 'rev-parse', 'HEAD'), image, terminal, budget };
  await durableWrite(path.join(output, 'report.json'), encode(report)); console.log(encode(report));
} catch (error) {
  await durableWrite(path.join(output, 'failure.json'), encode({ status: 'FAIL', reason: error.message, model_calls: 0, fake_provider_calls: calls }));
  throw error;
} finally { await broker?.close(); await lock.close(); }
