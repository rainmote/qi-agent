import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inspectEnvironment } from '../lib/environment.mjs';

const image = 'sha256:'+'a'.repeat(64);
const owner = { container: 'qi-maint-check-12345678-1234-1234-1234-123456789abc', container_owner: '12345678-1234-1234-1234-123456789abc' };
const result = value => ({exit_code:0,stdout:typeof value==='string'?value:JSON.stringify(value),stderr:'',duration_ms:1});
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qi-environment-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const calls=[];
  let unhealthy=false, ownerUnknown=false, kernel='fixture-kernel';
  const run=async(command,argv,options)=>{
    assert.equal(command,'docker'); assert.ok(options.timeoutMs>0&&options.timeoutMs<=5000);assert.equal(options.maxOutputBytes,65536);
    calls.push(argv);
    if(unhealthy&&argv[0]==='info')return{...result(''),timed_out:true,exit_code:null};
    if(argv[0]==='context')return result(argv[1]==='show'?'fixture':'unix:///fixture/docker.sock');
    if(argv[0]==='version')return result({Server:{Version:'fixture-version'}});
    if(argv[0]==='info')return result({ID:'fixture-engine',KernelVersion:kernel,OperatingSystem:'fixture-vm',Architecture:'arm64',NCPU:2,MemTotal:1024});
    if(argv[0]==='image')return result({Id:image});
    if(argv[0]==='inspect')return ownerUnknown?{...result(''),exit_code:1,stderr:'engine disconnected'}:
      {...result(''),exit_code:1,stderr:'No such container: owned'};
    throw new Error('unreviewed command');
  };
  const options={image,directory,run,env:{},deadline:Date.now()+30000};
  return {options,calls,setUnhealthy:v=>unhealthy=v,setUnknown:v=>ownerUnknown=v,setKernel:v=>kernel=v};
}

test('fingerprints bind engine/kernel/image/resources and bounded raw receipts',async t=>{
  const f=await fixture(t);const a=await inspectEnvironment(f.options);
  assert.equal(a.status,'PASS');assert.equal(a.probes.length,5);
  assert.match(a.fingerprint,/^[a-f0-9]{64}$/);assert.ok(a.probes.every(p=>p.started_at&&p.ended_at&&p.output_sha256));
  assert.equal((await inspectEnvironment(f.options)).fingerprint,a.fingerprint);
  f.setKernel('changed');assert.notEqual((await inspectEnvironment(f.options)).fingerprint,a.fingerprint);
});

test('healthy engine cannot clear shared quarantine while old owner is unknown',async t=>{
  const f=await fixture(t);f.setUnhealthy(true);
  await assert.rejects(inspectEnvironment({...f.options,owners:[owner]}),/environment-unavailable/);
  f.setUnhealthy(false);
  await assert.rejects(inspectEnvironment({...f.options,stateRoot:'another-state'}),/quarantined/);
  f.setUnknown(true);
  await assert.rejects(inspectEnvironment({...f.options,reconcile:true}),/container identity unknown/);
  await assert.rejects(inspectEnvironment(f.options),/quarantined/);
  f.setUnknown(false);
  const recovered=await inspectEnvironment({...f.options,reconcile:true});
  assert.equal(recovered.status,'PASS');assert.ok(recovered.probes.some(p=>p.argv[0]==='inspect'));
  assert.equal((await inspectEnvironment(f.options)).status,'PASS');
  assert.ok(f.calls.every(argv=>!['run','rm','restart','kill','update'].includes(argv[0])));
});

test('unknown cleanup is quarantined even if engine probes succeed',async t=>{
  const f=await fixture(t);
  await assert.rejects(inspectEnvironment({...f.options,owners:[owner],failure:'owned cleanup unknown'}),/owned cleanup unknown/);
  await assert.rejects(inspectEnvironment(f.options),/quarantined/);
});

test('expired deadlines dispatch no probe and endpoint lookup failure blocks another state',async t=>{
  const f=await fixture(t);
  await assert.rejects(inspectEnvironment({...f.options,deadline:Date.now()-1}),/deadline/);
  assert.equal(f.calls.length,0);
  await assert.rejects(inspectEnvironment(f.options),/unresolved endpoint/);
  assert.equal(f.calls.length,0);
  await inspectEnvironment({...f.options,reconcile:true});
});
