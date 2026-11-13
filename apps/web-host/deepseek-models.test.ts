import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from './providers.js';
test('new model catalog uses canonical Flash and offers Pro without overwriting saved choices',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qi-deepseek-alignment-'));
  try {
    const registry=new ProviderRegistry(root,{codexAuthFile:join(root,'absent-auth')});
    await registry.load();
    const deepseek=(await registry.list()).find(p=>p.id==='deepseek')!;
    assert.deepEqual(deepseek.models.map(m=>m.id),['deepseek-flash','deepseek-v4-pro']);
    await registry.upsert({...deepseek,models:[{id:'my-pinned-model',name:'Pinned'}]});
    await registry.load();
    assert.deepEqual((await registry.list()).find(p=>p.id==='deepseek')!.models.map(m=>m.id),['my-pinned-model']);
  } finally { await rm(root,{recursive:true,force:true}); }
});
