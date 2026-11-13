// Mocked API browser regression; real runtime continuation is covered in interaction-e2e.test.ts.
import assert from 'node:assert/strict';
import { browser,base,fixture,snapshot,errors } from './browser-fixture.mjs';
const failed=()=>{const s=snapshot('A',0);s.events=[
 ['message',{message:{role:'user',content:'Check this workspace'}}],
 ['context/snapshot',{content:'Workspace instructions\nUse existing tests.\nSkills: inspect first.'}],
 ['agent/run/end',{'run-id':'failed-run',status:'failed',reason:'provider-error',verification:'not-run',error:'Connection interrupted'}]
].map(([type,data],i)=>({id:`e${i}`,type,data,seq:i+1,at:'2026-11-13T08:00:00Z'}));return s;};
try {
 const {page,controls}=await fixture(0);controls.snapshotOverride=failed();
 await page.goto(base);await page.locator('.session-header-title button').waitFor();
 assert.equal(await page.getByRole('button',{name:'继续生成',exact:true}).count(),1,'provider failure needs a continuation action');
 await page.getByText('本轮指令',{exact:true}).click();
 await page.locator('.context-snapshot pre').waitFor();
 assert.match(await page.locator('.context-snapshot').innerText(),/Workspace instructions/);
 await page.locator('textarea').fill('Keep my draft');
 await page.getByRole('button',{name:'继续生成',exact:true}).evaluate(el=>{el.click();el.click();});
 await page.waitForFunction(()=>!document.querySelector('button[aria-label="继续生成"]'));
 assert.equal(controls.submissions.length,1);
 assert.equal(controls.submissions[0].params.options['continuation-of'],'failed-run');
 assert.equal(await page.locator('textarea').inputValue(),'Keep my draft');
 if(process.env.QI_AGENT_BROWSER_ARTIFACTS) await page.screenshot({path:`${process.env.QI_AGENT_BROWSER_ARTIFACTS}/harness-continued.png`,fullPage:true});
 await page.close();
 for(const status of ['uncertain','cancelled','completed']) {
   const {page,controls}=await fixture(0);const s=failed();s.events.at(-1).data.status=status;controls.snapshotOverride=s;
   await page.goto(base);await page.locator('.session-header-title button').waitFor();
   assert.equal(await page.getByRole('button',{name:'继续生成',exact:true}).count(),0,status);
   await page.close();
 }
 for (const mode of ['reject', 'unknown']) {
   const {page,controls}=await fixture(0); controls.snapshotOverride=failed();
   await page.goto(base); await page.locator('.session-header-title button').waitFor();
   await page.getByLabel('选择附件').setInputFiles({name:'draft.txt',mimeType:'text/plain',buffer:Buffer.from('unsent attachment')});
   await page.getByRole('list',{name:'待发送附件'}).getByText('draft.txt',{exact:true}).waitFor();
   await page.locator('textarea').fill('Keep draft and attachment');
   if (mode==='reject') controls.rejectSubmit=true; else controls.dropSubmit=true;
   await page.getByRole('button',{name:'继续生成',exact:true}).click();
   if (mode==='unknown') {
     await page.getByRole('button',{name:'核对结果',exact:true}).waitFor();
     assert.equal(await page.getByRole('button',{name:'继续生成',exact:true}).isDisabled(),true);
     assert.equal(controls.submissions.length,1);
     controls.operationStatus='failed';
     await page.getByRole('button',{name:'核对结果',exact:true}).click();
     await page.getByRole('button',{name:'核对结果',exact:true}).waitFor({state:'hidden'});
   } else {
     await page.getByText('Fixture rejected before acceptance',{exact:true}).waitFor();
     await page.waitForFunction(()=>!document.querySelector('button[aria-label="继续生成"]').disabled);
   }
   assert.equal(await page.locator('textarea').inputValue(),'Keep draft and attachment');
   assert.equal(await page.getByRole('list',{name:'待发送附件'}).getByText('draft.txt',{exact:true}).count(),1);
   assert.equal(controls.submissions.length,1,'no automatic replay');
   await page.close();
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASS',cases:['context disclosure','continue failed model','double click once','preserve draft and attachments','refusal and unknown delivery reconcile without replay','no continuation for unknown/cancelled/completed'],externalModelCalls:0}));
} finally {await browser.close();}
