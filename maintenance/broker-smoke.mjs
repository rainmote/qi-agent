#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startBroker } from './lib/broker.mjs';
import { budgetSnapshot } from './lib/budget.mjs';
import { lockStore, readJournal, durableWrite, encode } from './lib/store.mjs';
import { containerCommand, immutableImage, git } from './lib/execution.mjs';

const controller = fileURLToPath(new URL('..', import.meta.url));
const output = process.argv[2];
if (!path.isAbsolute(output ?? '')) throw new Error('Usage: QI_MAINTENANCE_IMAGE=sha256:... node maintenance/broker-smoke.mjs ABS_NEW_OUTPUT');
const image = immutableImage(process.env.QI_MAINTENANCE_IMAGE);
await fs.mkdir(output);
const root = path.join(output, 'state'), workspace = path.join(output, 'workspace'); await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, 'request.mjs'), `import assert from 'node:assert/strict'; import net from 'node:net';
assert.equal(process.env.OPENAI_API_KEY,undefined);
const network=await new Promise(resolve=>{const s=net.connect({host:'192.0.2.1',port:443});s.on('error',e=>resolve(e.code));s.on('connect',()=>{s.destroy();resolve('CONNECTED')});s.setTimeout(500,()=>{s.destroy();resolve('TIMEOUT')})});
assert.equal(network,'ENETUNREACH');
const response=await fetch(process.env.QI_MAINTENANCE_BROKER_URL+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture-model',input:[{role:'user',content:'hello'}]})});
assert.equal(response.status,200);assert.equal((await response.json()).status,'completed');
console.log(JSON.stringify({network,key_absent:true,broker:'PASS'}));\n`);
const config = { schema_version: 1, model: 'fixture-model', effort: 'medium', task_usd: 1, daily_usd: 2,
  max_requests: 2, context_window_tokens: 4096, max_output_tokens: 512, input_usd_per_million: 1,
  output_usd_per_million: 2, price_valid_until: '2099-01-01T00:00:00Z', price_source: 'https://example.invalid/fixture' };
const lock = await lockStore(root);
let broker, calls = 0;
try {
  broker = await startBroker({ root, lock, config, taskId: 'fixture', runId: 'fixture-run', deadline: Date.now() + 30000,
    directory: path.join(root, 'gateway'), credential: 'fixture-only-not-a-real-key', fetchImpl: async () => {
      calls++;
      assert.equal((await readJournal(root)).at(-1).type, 'budget/reserved');
      return Response.json({ id: 'resp_fixture', status: 'completed', model: config.model, service_tier: 'default', usage: { input_tokens: 10, output_tokens: 5 }, output: [] });
    } });
  const result = await containerCommand({ image, workspace, timeoutMs: 20000,
    mounts: [{ source: controller, target: '/controller' }, { source: broker.directory, target: '/gateway', writable: true }],
    argv: ['node', '/controller/maintenance/relay.mjs', '/gateway', 'node', '/work/request.mjs'] });
  await broker.close();
  const report = { status: result.exit_code === 0 && calls === 1 ? 'PASS' : 'FAIL',
    mode: 'disconnected-container-and-host-fake-provider', model_calls: 0, fake_provider_calls: calls,
    source_sha: git(controller, 'rev-parse', 'HEAD'), image, result, budget: budgetSnapshot(await readJournal(root), 'fixture') };
  await durableWrite(path.join(output, 'report.json'), encode(report));
  console.log(encode(report)); assert.equal(report.status, 'PASS');
} finally { await broker?.close(); await lock.close(); }
