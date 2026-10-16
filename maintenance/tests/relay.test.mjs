import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockStore } from '../lib/store.mjs';
import { startBroker } from '../lib/broker.mjs';
import { runProcess } from '../../evals/lib/core.mjs';

const relay = fileURLToPath(new URL('../relay.mjs', import.meta.url));
const config = { schema_version: 1, model: 'fixture-model', effort: 'medium', task_usd: 1, daily_usd: 2,
  max_requests: 4, context_window_tokens: 4096, max_output_tokens: 512, input_usd_per_million: 1,
  output_usd_per_million: 2, price_valid_until: '2099-01-01T00:00:00Z', price_source: 'https://example.invalid/test' };
const response = { model: config.model, service_tier: 'default', status: 'completed',
  usage: { input_tokens: 1, output_tokens: 1 }, output: [] };
const workerPrelude = `const fs=require('node:fs/promises');
const url=process.env.QI_MAINTENANCE_BROKER_URL+'/responses';
const options={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture-model',input:[{role:'user',content:'fixture'}]})};
const status=async r=>{await r.arrayBuffer();return r.status};
`;

async function fixture(t, fetchImpl) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-relay-')), lock = await lockStore(root);
  const broker = await startBroker({ root, lock, config, taskId: 'fixture', runId: 'fixture-run',
    deadline: Date.now() + 30000, directory: path.join(root, 'gateway'), credential: 'fixture-only', fetchImpl });
  t.after(async () => { await broker.close(); await lock.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, broker, run: (script, preload = []) => runProcess(process.execPath,
    [...preload, relay, broker.directory, process.execPath, '-e', workerPrelude + script],
    { cwd: root, timeoutMs: 10000, env: { PATH: process.env.PATH, HOME: root, TMPDIR: os.tmpdir() } }) };
}

test('a completed relay response admits the next sequential tool round despite slow receipt cleanup', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return Response.json(response); });
  const preload = path.join(f.root, 'slow-unlink.mjs');
  await fs.writeFile(preload, `import {promises as fs} from 'node:fs';
const unlink=fs.unlink.bind(fs);fs.unlink=async file=>{
 if(String(file).endsWith('.response.json'))await new Promise(r=>setTimeout(r,150));
 return unlink(file);
};\n`);
  const result = await f.run(`(async()=>{
 const statuses=[];for(let i=0;i<2;i++)statuses.push(await status(await fetch(url,options)));
 console.log(JSON.stringify(statuses));
})().catch(e=>{console.error(e);process.exitCode=1});`, ['--import', preload]);
  assert.equal(result.exit_code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [200, 200]);
  assert.equal(calls, 2); assert.equal(f.broker.failure(), null);
});

test('relay still rejects overlapping requests and unapproved routes', async t => {
  let root;
  const f = await fixture(t, async () => {
    await fs.writeFile(path.join(root, 'in-flight'), '');
    for (let i=0;i<500;i++) {
      if (await fs.stat(path.join(root, 'release')).then(()=>true,()=>false)) return Response.json(response);
      await new Promise(r=>setTimeout(r,5));
    }
    throw new Error('Fixture release deadline');
  });
  root = f.root;
  const result = await f.run(`(async()=>{
 const first=fetch(url,options);for(let i=0;i<500;i++){
  if(await fs.stat('in-flight').then(()=>true,()=>false))break;
  await new Promise(r=>setTimeout(r,5));
 }
 const overlapping=await status(await fetch(url,options));
 const wrongRoute=await status(await fetch(url));
 await fs.writeFile('release','');
 console.log(JSON.stringify([overlapping,wrongRoute,await status(await first)]));
})().catch(e=>{console.error(e);process.exitCode=1});`);
  assert.equal(result.exit_code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [403, 403, 200]);
  assert.equal(f.broker.failure(), null);
});
