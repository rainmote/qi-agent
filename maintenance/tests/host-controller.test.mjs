import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git } from '../lib/execution.mjs';

test('host launcher preflight never refreshes or replaces the non-root controller index', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'qi-host-preflight-')));
  try {
    const repo=path.join(root,'repo'), bin=path.join(root,'bin'), marker=path.join(root,'inspected');
    await fs.mkdir(repo); await fs.mkdir(bin);
    const source=path.join(repo,'source.txt');await fs.writeFile(source,'fixture\n');
    git(repo,'init','-b','main');git(repo,'add','.');
    git(repo,'-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','fixture');
    const sha=git(repo,'rev-parse','HEAD'), index=path.join(repo,'.git/index');
    const before=await fs.readFile(index);
    await fs.utimes(source,new Date(Date.now()+60000),new Date(Date.now()+60000));
    await fs.writeFile(path.join(bin,'docker'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)));process.exit(78);\n`,{mode:0o755});
    const launcher=fileURLToPath(new URL('../host-controller.sh',import.meta.url));
    const result=spawnSync('sh',[launcher,root,sha,'sha256:'+'a'.repeat(64),'broker-smoke'],{
      env:{...process.env,PATH:bin+path.delimiter+process.env.PATH},encoding:'utf8',timeout:10000});
    assert.notEqual(result.status,0);
    assert.equal(JSON.parse(await fs.readFile(marker,'utf8'))[0],'image','preflight must reach image inspection');
    assert.deepEqual(await fs.readFile(index),before,'preflight must not rewrite the index using the caller identity');
    const actualGit=spawnSync('which',['git'],{encoding:'utf8'}).stdout.trim();
    await fs.writeFile(path.join(bin,'git'),`#!${process.execPath}\nif(process.argv.includes('status'))process.exit(128);process.stdout.write(require('node:child_process').execFileSync(${JSON.stringify(actualGit)},process.argv.slice(2)));\n`,{mode:0o755});
    await fs.unlink(marker);
    const failed=spawnSync('sh',[launcher,root,sha,'sha256:'+'a'.repeat(64),'broker-smoke'],{
      env:{...process.env,PATH:bin+path.delimiter+process.env.PATH},encoding:'utf8',timeout:10000});
    assert.notEqual(failed.status,0);
    assert.equal(await fs.stat(marker).then(()=>true,()=>false),false,'failed Git inspection must stop before Docker');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
