import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const { WorkspaceFiles } = await import(pathToFileURL(join(process.cwd(),'apps/web-host/workspace-files.ts')).href);
const { WorkspaceRegistry } = await import(pathToFileURL(join(process.cwd(),'apps/web-host/workspaces.ts')).href);
const sha = (v:string) => createHash('sha256').update(v).digest('hex');
const controller = 'a0b74ad310aa0e0978f747369c41315560aa6dd3';
test('only the independent receipt for the complete unchanged workspace can display PASS',async()=>{
 const root=await realpath(await mkdtemp('/tmp/qvr-'));
 try{
  const project=join(root,'project'), store=join(root,'receipts');await mkdir(project);await mkdir(store,{mode:0o700});
  execFileSync('/usr/bin/git',['init','-q',project]);await writeFile(join(project,'code.txt'),'before');execFileSync('/usr/bin/git',['-C',project,'add','code.txt']);
  const registry=new WorkspaceRegistry(join(root,'web'));await registry.load(project);const workspace=registry.list()[0];
  const files=new WorkspaceFiles(registry,{verification:{directory:store,controllerSha:controller}});
  const turn='0123456789abcdef';await files.beginTurn(workspace.id,turn,'session');await writeFile(join(project,'code.txt'),'after');await files.finishTurn(workspace.id,turn);await files.recordSessionTurn(workspace.id,'session',turn);
  const receipt={schema_version:1,status:'PASS',workspace_path:project,turn_id:turn,candidate_sha:'1'.repeat(40),created_at:new Date().toISOString(),source_files:[{file:'code.txt',mode:'100644',sha256:sha('after')}],bindings:{controller_sha:controller,contract_sha256:'2'.repeat(64),material_sha256:'3'.repeat(64),profile_sha256:'4'.repeat(64),verifier_sha256:'5'.repeat(64),image:'sha256:'+'6'.repeat(64)},required_checks:['repository-suite','acceptance'],checks:[{id:'repository-suite',status:'PASS'},{id:'acceptance',status:'PASS'}]};
  const receiptFile=join(store,sha(JSON.stringify([project,turn]))+'.json');await writeFile(receiptFile,JSON.stringify(receipt),{mode:0o600});
  const result=()=>files.sessionChanges(workspace.id,'session');
  assert.equal((await result()).verification?.status,'PASS','an exact independent receipt must reach the existing changes API');
  await writeFile(join(project,'code.txt'),'later');assert.equal((await result()).verification.status,'UNKNOWN');await writeFile(join(project,'code.txt'),'after');
  await writeFile(join(project,'extra.txt'),'new');assert.equal((await result()).verification.status,'UNKNOWN');await rm(join(project,'extra.txt'));
  await chmod(join(project,'code.txt'),0o755);assert.equal((await result()).verification.status,'UNKNOWN');await chmod(join(project,'code.txt'),0o644);
  for(const status of ['SKIP','NOT_RUN','UNKNOWN','FAIL','CANCELLED','TIMEOUT']){await writeFile(receiptFile,JSON.stringify({...receipt,checks:[{id:'repository-suite',status},{id:'acceptance',status:'PASS'}]}));assert.equal((await result()).verification.status,'UNKNOWN')}
  await writeFile(receiptFile,JSON.stringify({...receipt,bindings:{...receipt.bindings,controller_sha:'f'.repeat(40)}}));assert.equal((await result()).verification.status,'UNKNOWN');
  await writeFile(receiptFile,JSON.stringify(receipt));assert.equal((await result()).verification.status,'PASS');
  await rm(join(project,'code.txt'));assert.equal((await result()).verification.status,'UNKNOWN');await writeFile(join(project,'code.txt'),'after');
  const withoutTrust = new WorkspaceFiles(registry);
  const snapshot = join(files.snapshotDirectory,workspace.id+'-'+turn+'.changes.json');
  const stored = JSON.parse(await (await import('node:fs/promises')).readFile(snapshot,'utf8'));
  await writeFile(snapshot,JSON.stringify({...stored,verification:{status:'PASS'}}));
  assert.equal((await withoutTrust.sessionChanges(workspace.id,'session')).verification,undefined);
  await writeFile(receiptFile,'{');assert.equal((await result()).verification.status,'UNKNOWN');await rm(receiptFile);assert.equal((await result()).verification.status,'NOT_RUN');
 }finally{await rm(root,{recursive:true,force:true})}
});


test('full source proof includes hidden and binary files and refuses symbolic links',async()=>{
 const { workspaceManifest } = await import('../shared/workspace-verification.mjs');
 const { symlink } = await import('node:fs/promises');
 const root=await realpath(await mkdtemp('/tmp/qvr-source-'));
 try {
  execFileSync('/usr/bin/git',['init','-q',root]);await writeFile(join(root,'.settings'),'hidden');await writeFile(join(root,'image.bin'),Buffer.from([0,1,2]));
  const files=await workspaceManifest(root);assert.deepEqual(files.map(file=>file.file),['.settings','image.bin']);assert.equal(files[0].sha256,sha('hidden'));
  await symlink('image.bin',join(root,'linked.bin'));await assert.rejects(workspaceManifest(root),/symlink/);
 }finally{await rm(root,{recursive:true,force:true})}
});
