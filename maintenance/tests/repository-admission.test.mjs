import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { admitRepository, assertRepositoryAdmission, releaseRepositoryAdmission, repositoryIdentity } from '../lib/repository-admission.mjs';

async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'qi-repository-admission-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo'),one=path.join(root,'one'),two=path.join(root,'two');
  await fs.mkdir(repo);await fs.mkdir(one);await fs.mkdir(two);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','main');await fs.writeFile(path.join(repo,'value'),'original');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base');
  const task={task_id:'finding-one',base_sha:git('rev-parse','HEAD')};
  return {repo,one,two,root,task,contractHash:'a'.repeat(64),git};
}
test('cross-state and worktree aliases serialize one repository and preserve exact intent',async t=>{
  const f=await fixture(t);const first=await admitRepository({...f,root:f.one});
  assert.ok(first.pid_started_at);assert.ok(first.owner_token);
  const duplicate=await admitRepository({...f,root:f.two});assert.equal(duplicate.state_root,f.one);assert.equal(duplicate.owner_token,first.owner_token);
  await assert.rejects(admitRepository({...f,root:f.two,contractHash:'b'.repeat(64)}),/Active repository admission/);
  const worktree=path.join(f.root,'worktree');f.git('worktree','add','--detach',worktree,f.task.base_sha);
  assert.equal((await repositoryIdentity(worktree)).repository_key,first.repository_key);
  await assert.rejects(admitRepository({...f,repo:worktree,root:f.two,task:{...f.task,task_id:'other'}}),/Active repository admission/);
  await assertRepositoryAdmission(first);await releaseRepositoryAdmission(first);
  const historical=await admitRepository({...f,root:f.two});assert.equal(historical.state_root,f.one);assert.ok(historical.released_at);
  const reopened=await admitRepository({...f,root:f.one,reopen:true});assert.notEqual(reopened.owner_token,first.owner_token);
  await assert.rejects(assertRepositoryAdmission(first),/stale/);await assertRepositoryAdmission(reopened);
});
test('unknown/dead owner and orphaned creation intent never expire into new admission',async t=>{
  const f=await fixture(t);const first=await admitRepository({...f,root:f.one});
  const file=path.join(first.directory,'active.json');const old=JSON.parse(await fs.readFile(file));
  old.pid=99999999;old.pid_started_at='unknown historical birth';old.admitted_at='2000-01-01T00:00:00Z';await fs.writeFile(file,JSON.stringify(old));
  await assert.rejects(admitRepository({...f,root:f.two,task:{...f.task,task_id:'another'}}),/Active repository admission/);
  assert.equal(JSON.parse(await fs.readFile(file)).owner_token,first.owner_token);
});
