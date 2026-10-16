// One host admission per Git common directory; no time-based lock stealing.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { git } from './execution.mjs';
import { digest, encode, durableWrite, lockStore } from './store.mjs';

const read = file => fs.readFile(file, 'utf8').then(JSON.parse, e=>{if(e.code==='ENOENT')return null;throw e;});
export async function repositoryIdentity(repo) {
  const common_dir=await fs.realpath(git(repo,'rev-parse','--path-format=absolute','--git-common-dir'));
  return {common_dir,repository_key:digest(common_dir),directory:path.join(common_dir,'qi-maintenance-admission')};
}
const birth = () => execFileSync('/bin/ps',['-p',String(process.pid),'-o','lstart='],
  {encoding:'utf8',env:{...process.env,LC_ALL:'C'},timeout:2000}).trim();

export async function admitRepository({repo,root,task,contractHash,reopen=false}) {
  const identity=await repositoryIdentity(repo);root=await fs.realpath(root);
  const intent_key=digest(encode([task.base_sha,task.finding_id??task.task_id,contractHash]));
  const file=path.join(identity.directory,'active.json'),history=path.join(identity.directory,'intents',intent_key+'.json');
  const lock=await lockStore(identity.directory);
  try {
    const previous=await read(history),active=await read(file);
    if(previous&&!reopen) {
      if(previous.intent_key!==intent_key||previous.contract_hash!==contractHash)throw new Error('Repository admission history changed');
      return {...previous,reused:true};
    }
    if(active) {
      if(active.intent_key===intent_key&&active.contract_hash===contractHash&&active.task_id===task.task_id)return {...active,reused:true};
      throw new Error('Active repository admission must be reconciled before another task');
    }
    const receipt={schema_version:1,...identity,intent_key,contract_hash:contractHash,task_id:task.task_id,
      base_sha:task.base_sha,state_root:root,owner_token:randomUUID(),pid:process.pid,
      pid_started_at:birth(),hostname:os.hostname(),admitted_at:new Date().toISOString()};
    // A crash after this intent but before task/created never silently rebuilds.
    await durableWrite(file,encode(receipt));
    return receipt;
  }finally{await lock.close();}
}

export async function assertRepositoryAdmission(receipt) {
  if(!receipt||!/^[a-f0-9]{64}$/.test(receipt.repository_key??'')||!receipt.owner_token||
    receipt.directory!==path.join(receipt.common_dir??'','qi-maintenance-admission')||
    digest(await fs.realpath(receipt.common_dir))!==receipt.repository_key)throw new Error('Missing or invalid repository admission identity');
  const lock=await lockStore(receipt.directory);
  try {
    const active=await read(path.join(receipt.directory,'active.json'));
    for(const key of ['owner_token','repository_key','intent_key','contract_hash','task_id','base_sha','state_root'])
      if(!active||active[key]!==receipt[key])throw new Error('Repository admission is stale or unknown');
    if(!Number.isSafeInteger(active.pid)||active.pid<1||!active.pid_started_at||!active.hostname)throw new Error('Unknown repository admission owner');
    return active;
  }finally{await lock.close();}
}

export async function releaseRepositoryAdmission(receipt) {
  await assertRepositoryAdmission(receipt);
  const lock=await lockStore(receipt.directory);
  try {
    const file=path.join(receipt.directory,'active.json');
    const active=await read(file);
    if(active?.owner_token!==receipt.owner_token)throw new Error('Repository admission changed before release');
    const released={...active,released_at:new Date().toISOString()};
    await durableWrite(path.join(receipt.directory,'intents',receipt.intent_key+'.json'),encode(released));
    await fs.unlink(file);
    const directory=await fs.open(receipt.directory,'r');try{await directory.sync();}finally{await directory.close();}
    return released;
  }finally{await lock.close();}
}
