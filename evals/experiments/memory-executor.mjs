// Optional host executor. Preparing or dry-running a package never loads credentials.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { frozenFixture } from './memory-blind.mjs';
import { digest, encode, durableWrite, lockStore, readJournal } from '../../maintenance/lib/store.mjs';
import { immutableImage, containerCommand } from '../../maintenance/lib/execution.mjs';
import { startBroker } from '../../maintenance/lib/broker.mjs';
import { validateBudget, budgetSnapshot } from '../../maintenance/lib/budget.mjs';
import { providerConfig } from '../../maintenance/lib/provider.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeFiles = { 'src/qi/kernel.clj':'src/qi/kernel.clj', 'src/qi/generation.clj':'src/qi/generation.clj',
  'worker.clj':'evals/experiments/memory_worker.clj', 'relay.mjs':'maintenance/relay.mjs' };
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
async function regular(file, limit = 16 * 1024 * 1024) {
  const handle = await fs.open(file, 'r');
  try { const stat=await handle.stat(); assert.ok(stat.isFile()&&stat.size<=limit,'bounded regular file required');
    assert.ok(!(await fs.lstat(file)).isSymbolicLink(),'symlink input refused');return await handle.readFile(); }
  finally {await handle.close();}
}

export async function freezeMemoryRuntime(output) {
  assert.ok(path.isAbsolute(output));await fs.mkdir(output,{mode:0o700});
  const files={};
  for(const [target,source] of Object.entries(runtimeFiles)){
    const bytes=await regular(path.join(repo,source));files[target]=digest(bytes);
    await durableWrite(path.join(output,target),bytes);
  }
  const manifest={schema_version:1,files,fingerprint:digest(encode(files))};
  await durableWrite(path.join(output,'manifest.json'),encode(manifest));return manifest;
}
async function runtimeIdentity(directory) {
  const manifest=JSON.parse(await regular(path.join(directory,'manifest.json')));
  assert.deepEqual(Object.keys(manifest.files).sort(),Object.keys(runtimeFiles).sort());
  for(const [file,hash] of Object.entries(manifest.files))assert.equal(digest(await regular(path.join(directory,file))),hash,'runtime changed');
  const entries=[];
  async function walk(root,relative='') {for(const item of await fs.readdir(root,{withFileTypes:true})){
    const name=path.join(relative,item.name);assert.ok(!item.isSymbolicLink(),'runtime symlink');
    if(item.isDirectory())await walk(path.join(root,item.name),name);else entries.push(name);
  }}
  await walk(directory);assert.deepEqual(entries.sort(),['manifest.json',...Object.keys(runtimeFiles)].sort(),'unexpected runtime material');
  assert.equal(digest(encode(manifest.files)),manifest.fingerprint);return manifest.fingerprint;
}

export async function executeMemory({ packageRoot, output, live=false, config, authorization,
  execute=containerCommand, brokerFactory=startBroker, signal, evidenceKind='model-experiment' }) {
  const opened=Date.now(),executor_sha256=digest(await regular(fileURLToPath(import.meta.url)));
  assert.ok(path.isAbsolute(packageRoot)&&path.isAbsolute(output));
  packageRoot=await fs.realpath(packageRoot);
  const manifest=JSON.parse(await regular(path.join(packageRoot,'manifest.json')));
  const planBytes=await regular(path.join(packageRoot,'model-inputs/plan.json'));
  assert.equal(manifest.fixture_sha256,frozenFixture);assert.equal(digest(planBytes),manifest.model_inputs_sha256);
  const plan=JSON.parse(planBytes);assert.equal(plan.experiment,'blind-memory-dev-v1');assert.equal(plan.split,'dev');assert.equal(plan.arms.length,40);
  const requests=plan.arms.flatMap(row=>[...row.requests,row.recall]);
  assert.equal(requests.length,120);assert.equal(new Set(requests.map(r=>r.request_id)).size,120);
  const report={status:'DRY_RUN',model_calls:0,model_semantic_recall:null,total_cost_usd:null,executor_sha256,
    input_sha256:digest(planBytes),ledger:requests.map(r=>({request_id:r.request_id,status:'NOT_RUN',usage:null})),
    note:'Execution is separate from semantic grading and invoice reconciliation.'};
  if(!live){await fs.mkdir(output,{mode:0o700});await durableWrite(path.join(output,'report.json'),encode(report));return report;}
  assert.ok(config&&authorization,'explicit model/profile/budget authorization required');
  validateBudget(config.budget);immutableImage(config.image);
  for(const name of ['profile_path','runtime_directory','state_root'])assert.ok(path.isAbsolute(config[name]??''),'absolute '+name+' required');
  const profileBytes=await regular(config.profile_path),profile=JSON.parse(profileBytes);
  assert.equal(digest(profileBytes),config.profile_sha256,'profile changed');assert.equal(profile.schema_version,1);
  assert.equal(profile.model,config.budget.model);assert.equal(profile.effort,config.budget.effort);
  assert.equal(profile.max_retries,0,'automatic retries are disabled');
  for(const [key,max] of Object.entries({max_input_bytes:2*1024*1024,max_output_bytes:32768,max_wall_ms:2700000,max_requests:120}))
    assert.ok(Number.isSafeInteger(profile[key])&&profile[key]>0&&profile[key]<=max,'explicit '+key+' required');
  assert.equal(profile.max_requests,120);assert.equal(config.budget.max_requests,120);
  assert.ok(profile.max_input_bytes<=config.budget.context_window_tokens,'input byte cap must fit the reserved input window');
  assert.ok(config.budget.max_output_tokens>=2048,'planned output allowance missing');
  for(const row of plan.arms)for(const request of row.requests)assert.ok(Buffer.byteLength(JSON.stringify(request.request))<=profile.max_input_bytes,'planned input exceeds byte cap');
  const runtime=await fs.realpath(config.runtime_directory),runtime_sha256=await runtimeIdentity(runtime);
  const stateRoot=await fs.realpath(config.state_root);
  assert.ok((await fs.stat(stateRoot)).isDirectory(),'prepared shared budget state required');
  const budget_sha256=digest(encode(config.budget));
  const identity={model:profile.model,profile_sha256:config.profile_sha256,budget_sha256,
    model_inputs_sha256:report.input_sha256,runtime_sha256,image:config.image,state_root:stateRoot};
  assert.equal(authorization.kind,'blind-memory-model-experiment');assert.equal(authorization.approved,true);
  assert.ok(typeof authorization.evidence==='string'&&authorization.evidence.trim(),'operator evidence required');
  for(const [key,value] of Object.entries(identity))assert.equal(authorization[key],value,'authorization binding '+key);
  assert.ok(['model-experiment','fixture'].includes(evidenceKind));
  assert.ok(!inside(stateRoot,packageRoot)&&!inside(stateRoot,runtime)&&!inside(path.resolve(output),packageRoot));
  if(signal?.aborted)throw new Error('cancelled before dispatch');
  await fs.mkdir(output,{mode:0o700});
  const inputs=path.join(output,'model-inputs');await fs.mkdir(inputs);
  await durableWrite(path.join(inputs,'plan.json'),planBytes);
  await durableWrite(path.join(inputs,'run-config.json'),encode({...profile,profile_sha256:config.profile_sha256,
    provider:providerConfig(config.budget).id,max_output_tokens:config.budget.max_output_tokens}));
  const lock=await lockStore(stateRoot),runId=randomUUID(),taskId='memory-'+digest(encode(identity)).slice(0,32);
  const deadline=opened+profile.max_wall_ms;
  let broker,intent=false;
  const stopped=async()=>signal?.aborted===true||await fs.stat(path.join(output,'pause.json')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
  try {
    const events=await readJournal(stateRoot);
    assert.ok(Date.now()<deadline,'experiment deadline exhausted before dispatch');
    assert.ok(!events.some(e=>e.type==='experiment/intent'&&!events.some(done=>done.type==='experiment/result'&&done.data.run_id===e.data.run_id)),'unknown experiment requires reconciliation');
    assert.equal(budgetSnapshot(events,taskId).uncertain.length,0,'unknown cost requires reconciliation');
    broker=await brokerFactory({root:stateRoot,lock,config:config.budget,taskId,runId,deadline,
      directory:path.join(output,'gateway'),stopped});
    await lock.append('experiment/intent',{run_id:runId,task_id:taskId,...identity,output});intent=true;
    report.status='RUNNING';report.identity=identity;report.started_at=new Date().toISOString();
    await durableWrite(path.join(output,'report.json'),encode(report));
    const execution=await execute({image:config.image,workspace:inputs,readonly:true,network:false,
      mounts:[{source:runtime,target:'/controller'},{source:broker.directory,target:'/gateway',writable:true}],
      argv:['node','/controller/relay.mjs','/gateway','bb','--classpath','/controller/src','/controller/worker.clj'],
      timeoutMs:Math.max(1,deadline-Date.now()),shouldStop:async()=>!!broker.failure()||await stopped()});
    report.broker_failure=await broker.close();broker=null;
    await durableWrite(path.join(output,'execution.json'),encode(execution));
    const rows=execution.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
    const results=rows.filter(r=>r.type==='request-result');
    const known=new Map(report.ledger.map(r=>[r.request_id,r]));
    for(const row of results){assert.ok(known.has(row.request_id),'unexpected experiment result');
      assert.equal(known.get(row.request_id).status,'NOT_RUN','duplicate experiment result');Object.assign(known.get(row.request_id),row);}
    const terminal=rows.filter(r=>r.type==='terminal');
    assert.equal(terminal.length,1,'unique worker terminal required');
    assert.equal(await runtimeIdentity(runtime),runtime_sha256,'runtime changed during execution');
    assert.equal(digest(await regular(config.profile_path)),config.profile_sha256,'profile changed during execution');
    assert.equal(digest(await regular(fileURLToPath(import.meta.url))),executor_sha256,'executor changed during execution');
    const budget=budgetSnapshot(await readJournal(stateRoot),taskId);
    report.budget=budget;report.generation_events=rows.filter(r=>r.type==='generation-event');
    report.status=await stopped()?'CANCELLED':budget.uncertain.length?'UNKNOWN':
      execution.exit_code===0&&!execution.timed_out&&!execution.error&&!execution.signal&&!execution.output_limited&&
      terminal[0].status==='completed'&&report.ledger.every(r=>r.status==='completed')?'COMPLETED':'FAILED';
    report.evidence_kind=evidenceKind;
    if(report.status!=='UNKNOWN')await lock.append('experiment/result',{run_id:runId,task_id:taskId,status:report.status});
  } catch(error){report.status='UNKNOWN';report.error=error.message;report.intent_recorded=intent;}
  finally{await broker?.close();
    try {const events=await readJournal(stateRoot);report.budget=budgetSnapshot(events,taskId);
      report.logical_requests_this_run=events.filter(e=>e.type==='budget/reserved'&&e.data.run_id===runId).length;}
    catch(error){report.budget={status:'UNKNOWN',reason:error.message};report.status='UNKNOWN';}
    report.model_calls=evidenceKind==='fixture'?0:report.logical_requests_this_run??null;
    await lock.close();report.ended_at=new Date().toISOString();
    await durableWrite(path.join(output,'report.json'),encode(report));}
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,...args]=process.argv.slice(2);
  if(command==='freeze-runtime')console.log(encode(await freezeMemoryRuntime(args[0])));
  else {
    const [packageRoot,output,configFile,authorizationFile]=args;
    assert.ok(['dry-run','execute'].includes(command),'dry-run PACKAGE NEW_OUTPUT or execute PACKAGE NEW_OUTPUT CONFIG AUTHORIZATION');
    const report=await executeMemory({packageRoot,output,live:command==='execute',
      config:configFile?JSON.parse(await fs.readFile(configFile)):undefined,
      authorization:authorizationFile?JSON.parse(await fs.readFile(authorizationFile)):undefined});
    console.log(encode(report));if(!['DRY_RUN','COMPLETED'].includes(report.status))process.exitCode=1;
  }
}
