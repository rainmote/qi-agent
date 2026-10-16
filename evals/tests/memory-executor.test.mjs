import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import path from 'node:path';import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {writePackage} from '../experiments/memory-blind.mjs';
import {executeMemory,freezeMemoryRuntime} from '../experiments/memory-executor.mjs';
import {startBroker} from '../../maintenance/lib/broker.mjs';
import {digest,encode,readJournal} from '../../maintenance/lib/store.mjs';
import {runProcess} from '../lib/core.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'qi-memory-executor-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const packageRoot=path.join(root,'package'),runtime_directory=path.join(root,'runtime');
  const manifest=await writePackage(packageRoot,path.join(repo,'evals/experiments/memory-cases.json'));
  const runtime=await freezeMemoryRuntime(runtime_directory);
  const profile={schema_version:1,model:'fixture-model',effort:'low',max_input_bytes:128000,max_output_bytes:32768,max_wall_ms:30000,max_requests:120,max_retries:0};
  const profile_path=path.join(root,'profile.json');await fs.writeFile(profile_path,encode(profile));
  const budget={schema_version:1,model:profile.model,effort:profile.effort,task_usd:1,daily_usd:2,input_usd_per_million:1,output_usd_per_million:1,
    context_window_tokens:128000,max_output_tokens:2048,max_requests:120,price_valid_until:'2027-01-01T00:00:00Z',price_source:'https://example.invalid/offline-fixture-prices'};
  const config={profile_path,profile_sha256:digest(encode(profile)),budget,image:'sha256:'+'a'.repeat(64),runtime_directory,state_root:path.join(root,'budget')};
  const authorization={kind:'blind-memory-model-experiment',approved:true,evidence:'offline fixture authorization, no real provider',model:profile.model,
    profile_sha256:config.profile_sha256,budget_sha256:digest(encode(budget)),model_inputs_sha256:manifest.model_inputs_sha256,runtime_sha256:runtime.fingerprint,image:config.image};
  let calls=0;
  const brokerFactory=options=>startBroker({...options,credential:'offline-fixture',fetchImpl:async(_url,request)=>{
    calls++;const events=await readJournal(config.state_root);const reservation=events.filter(e=>e.type==='budget/reserved').at(-1);
    assert.match(reservation.data.logical_request_id,/^[a-f0-9-]{36}$/);assert.match(reservation.data.native_run_id,/^[a-f0-9-]{36}$/);
    const body=JSON.parse(request.body);assert.equal(body.model,profile.model);assert.equal(body.tools.length,0);assert.equal(body.max_output_tokens,2048);
    return Response.json({id:'fixture-'+calls,status:'completed',model:profile.model,service_tier:'default',usage:{input_tokens:10,output_tokens:5},
      output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]});
  }});
  const execute=async options=>{
    assert.deepEqual((await fs.readdir(options.workspace)).sort(),['plan.json','run-config.json']);assert.equal(options.network,false);
    assert.equal(options.readonly,true);assert.equal(options.mounts.length,2);assert.ok(!options.mounts.some(m=>m.source.includes('verifier')));
    const argv=options.argv.map(a=>a.replace(/^\/controller/,runtime_directory).replace(/^\/gateway/,options.mounts[1].source));
    return runProcess(process.execPath,argv.slice(1),{cwd:options.workspace,timeoutMs:options.timeoutMs,
      env:{PATH:process.env.PATH,HOME:root,TMPDIR:root,NO_COLOR:'1'}});
  };
  return {root,packageRoot,config,authorization,brokerFactory,execute,calls:()=>calls};
}
test('default dry run admits no provider, and incomplete authorization or budgets refuse dispatch',async t=>{
  const f=await fixture(t);let dispatched=0;const execute=()=>{dispatched++;throw new Error('must not execute');};
  const dry=await executeMemory({packageRoot:f.packageRoot,output:path.join(f.root,'dry'),execute});
  assert.equal(dry.status,'DRY_RUN');assert.equal(dry.ledger.length,120);assert.ok(dry.ledger.every(r=>r.status==='NOT_RUN'));
  for(const change of [{config:undefined},{authorization:undefined},{config:{...f.config,profile_sha256:'0'.repeat(64)}},
    {authorization:{...f.authorization,budget_sha256:'0'.repeat(64)}},{config:{...f.config,budget:{...f.config.budget,input_usd_per_million:null}}}]){
    await assert.rejects(executeMemory({...f,...change,output:path.join(f.root,'refused'),live:true,execute}));
  }
  const abort=new AbortController();abort.abort();
  await assert.rejects(executeMemory({...f,output:path.join(f.root,'cancelled'),live:true,execute,signal:abort.signal}),/cancelled/);
  assert.equal(dispatched,0);assert.equal(f.calls(),0);
});
test('native generation UUIDs reach the reserve-before-dispatch broker for all 120 planned requests',async t=>{
  const f=await fixture(t);const result=await executeMemory({...f,output:path.join(f.root,'run'),live:true,evidenceKind:'fixture'});
  assert.equal(result.status,'COMPLETED',JSON.stringify({error:result.error,budget:result.budget,ledger:result.ledger.slice(0,2)}));
  assert.equal(f.calls(),120);assert.equal(result.model_calls,0);assert.equal(result.model_semantic_recall,null);assert.equal(result.total_cost_usd,null);
  const events=await readJournal(f.config.state_root),reserved=events.filter(e=>e.type==='budget/reserved');
  const generated=result.generation_events.filter(r=>r.event.data.status==='started');
  assert.equal(generated.length,120);assert.deepEqual(new Set(reserved.map(e=>e.data.logical_request_id)),new Set(generated.map(r=>r.event.data.request_id)));
  assert.equal(result.budget.uncertain.length,0);assert.ok(result.ledger.every(r=>r.native_request_id&&r.status==='completed'));
});
test('unknown provider failure settles conservatively and never replays the experiment',async t=>{
  const f=await fixture(t);let calls=0;
  const brokerFactory=options=>startBroker({...options,credential:'offline-fixture',fetchImpl:async()=>{calls++;throw new Error('fixture lost response');}});
  const result=await executeMemory({...f,brokerFactory,output:path.join(f.root,'lost'),live:true,evidenceKind:'fixture'});
  assert.equal(result.status,'UNKNOWN');assert.equal(calls,1);assert.equal(result.budget.uncertain.length,1);
  assert.equal(result.ledger.filter(r=>r.status==='NOT_RUN').length,119);
  const again=await executeMemory({...f,brokerFactory,output:path.join(f.root,'blocked'),live:true,evidenceKind:'fixture'});
  assert.equal(again.status,'UNKNOWN');assert.match(again.error,/reconciliation/);assert.equal(calls,1);
});
test('insufficient configured cost cap prevents even the first upstream call',async t=>{
  const f=await fixture(t),budget={...f.config.budget,task_usd:0.00001};
  const config={...f.config,budget},authorization={...f.authorization,budget_sha256:digest(encode(budget))};
  const result=await executeMemory({...f,config,authorization,output:path.join(f.root,'capped'),live:true,evidenceKind:'fixture'});
  assert.equal(result.status,'FAILED');assert.equal(result.broker_failure,'cost-budget');assert.equal(f.calls(),0);
  assert.equal(result.budget.requests,0);assert.equal(result.ledger.filter(r=>r.status==='NOT_RUN').length,119);
});
