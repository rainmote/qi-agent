import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {startWebHost} from './server.js';

test('closing Host refuses new work while shutdown proof is pending',async()=>{
 const root=await mkdtemp('/tmp/qi-close-gate-');await mkdir(join(root,'project'));
 const host=await startWebHost({port:0,workspace:join(root,'project'),stateDirectory:join(root,'web'),codexAuthFile:join(root,'missing'),token:'test-only'});
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);host.sessions.shutdownDaemon=()=>gate;
 const closing=host.close();
 try{const response=await fetch(`http://127.0.0.1:${host.port}/api/bootstrap`,{headers:{Authorization:'Bearer test-only'}});assert.equal(response.status,503,'closing Host must fence new HTTP requests before waiting for daemon cleanup');}
 finally{release();await closing;await rm(root,{recursive:true,force:true});}
});

test('unknown shutdown retains runtime and closes HTTP without retrying mutation',async()=>{
 const root=await mkdtemp('/tmp/qi-close-unknown-');await mkdir(join(root,'project'));
 const host=await startWebHost({port:0,workspace:join(root,'project'),stateDirectory:join(root,'web'),codexAuthFile:join(root,'missing')});
 const runtime=host.sessions.daemonEnvironment.runtimeDirectory!;await mkdir(runtime,{recursive:true});await writeFile(join(runtime,'evidence'),'UNKNOWN');
 let calls=0;host.sessions.shutdownDaemon=async()=>{calls++;throw new Error('UNKNOWN fixture');};
 const closing=host.close();
 try{assert.equal(host.close(),closing);await assert.rejects(closing,/UNKNOWN fixture/);assert.equal(calls,1);assert.ok((await stat(runtime)).isDirectory());await assert.rejects(fetch(`http://127.0.0.1:${host.port}/health`));}
 finally{await rm(root,{recursive:true,force:true});await rm(runtime,{recursive:true,force:true});}
});
