// Uses only mocked API data. Start Vite, then run npm run test:web-browser.
// QI_AGENT_PLAYWRIGHT_MODULE can select an existing Playwright installation.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.QI_AGENT_PLAYWRIGHT_MODULE || '../qi-agent/node_modules/playwright/index.mjs');
const browser = await chromium.launch({headless:true,...(process.env.QI_AGENT_BROWSER_CHANNEL ? {channel:process.env.QI_AGENT_BROWSER_CHANNEL} : {})});
const base = process.env.QI_AGENT_WEB_TEST_URL || 'http://127.0.0.1:4179';
const errors=[];
const workspaceId='1234567890abcdef';
const sessions=['A','B'].map(id=>({id,workspaceId,path:`/mock/${id}.jsonl`,name:`会话${id}`,label:null,eventCount:2,messageCount:2,updatedAt:'2026-10-02T01:00:00Z',presetId:'standard'}));
const policy={mode:'ask',modes:[{id:'deny',label:'Read Only'},{id:'ask',label:'Workspace Write'},{id:'allow',label:'Full Access'}]};
const models={current:{id:'mock-a',model:'Model A'},providers:[{id:'mock-a',model:'Model A'},{id:'mock-b',model:'Model B'}]};
function snapshot(id,n=2){return {session_id:id,path:`/mock/${id}.jsonl`,cursor:{generation:1,sequence:n},events:Array.from({length:n},(_,i)=>({id:`${id}-${i}`,seq:i+1,at:'2026-10-02T01:00:00Z',type:'message',data:{message:{role:i%2?'assistant':'user',content:`${id}-controlled-message-${i}`}}})),state:{phase:'idle',revision:2},models,policy,interactions:[],interactions_revision:0};}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function fixture(initialCount=2, pageOptions={}){
 const page=await browser.newPage({viewport:{width:1440,height:1000},...pageOptions});
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.sources=[];window.EventSource=class extends EventTarget{constructor(url){super();this.url=url;window.sources.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){this.closed=true;}}});
 const controls={policySelections:[],rejectPolicy:false,holdSnapshot:null,holdOpen:null,holdPolicy:null,holdModels:null,holdCatalog:null,catalogGates:[],additionalSessions:[],forks:0,snapshotOverride:null,steers:[],modelCatalog:models,providerSaves:0,providerRetries:0,dropSubmit:false,rejectSubmit:false,uploads:[],submissions:[],operationStatus:"completed",preferenceEvents:{A:[],B:[]},rejectPreference:false,verification:undefined};
 const sessionSnapshot=(id,n=2)=>{const value=snapshot(id,n);value.events.push(...controls.preferenceEvents[id]);return value;};
 const provider={id:"mock-provider",name:"Mock Provider",protocol:"openai-completions",baseUrl:"https://example.invalid/v1",apiKeyConfigured:true,authType:"api-key",authStatus:"configured",models:[{id:"mock-model",name:"Mock Model"}]};
 await page.route('**/api/**', async route=>{
  const path=new URL(route.request().url()).pathname; let result; let held;
  if(path==='/api/bootstrap') result={workspaces:[{id:workspaceId,name:'隔离复现',path:'/mock',addedAt:'2026-10-02'}],catalogs:[{workspaceId,sessions:[...sessions,...controls.additionalSessions]}],activeWorkspaceId:workspaceId};
  else if(path==='/api/sessions'&&route.request().method()==='GET'){result=[...sessions,...controls.additionalSessions];held=controls.catalogGates.shift()||controls.holdCatalog;}
  else if(path.endsWith('/fork')){
   controls.forks++;const session={...sessions[0],id:'C',name:'会话C',path:'/mock/C.jsonl'};
   controls.additionalSessions.push(session);controls.preferenceEvents.C=[];result={session,snapshot:sessionSnapshot('C'),eventCursor:'fixture:0'};
  }
  else if(path.endsWith('/attachments')) {const input=route.request().postDataJSON();controls.uploads.push(input);result={type:'attachment',id:`fixture-upload-${controls.uploads.length}`,workspaceId,name:input.name,mime:input.mime,size:Buffer.from(input.base64,'base64').length};}
  else if(path.endsWith('/files') || path.endsWith('/search')) result={path:'',entries:[{name:'note.md',path:'note.md',kind:'file'},{name:'example.html',path:'example.html',kind:'file'}],truncated:false};
  else if(path.endsWith('/preview')) {const html=new URL(route.request().url()).searchParams.get('path')==='example.html';result={path:html?'example.html':'note.md',name:html?'example.html':'note.md',mime:html?'text/html':'text/markdown',size:200,kind:html?'html':'text',text:html?'<h1>Static fixture</h1><script>parent.fixtureScriptRan=true</script>':'# bounded file fixture'};}
  else if(path.endsWith('/changes')) result={turnId:'fixture-turn',partial:!controls.verification,verification:controls.verification,files:[{path:'note.md',status:'modified',before:'old',after:'new',diff:'--- a/note.md\n+++ b/note.md\n-old\n+new'}],notice:'Fixture changes only'};
  else if(path.endsWith('/references')) result={files:[{path:'note.md'}],sessions:[sessions[1]]};
  else if(path.endsWith('/resolve-references')) result=route.request().postDataJSON().message+'\n[User-selected source]\nbounded file fixture';
  else if(path==='/api/presets') result=controls.presetCatalog || [{id:'standard',name:'Standard',trust:'system'}];
  else if(path==='/api/providers') {
   if(route.request().method()==='GET')result={providers:[provider],presets:[]};
   else{controls.providerSaves++;result={...provider,reload:{scope:'open-web-sessions',applied:[],failures:[{sessionId:'A',sessionName:'会话A',message:'模拟超时'}]}};}
  }
  else if(path==='/api/providers/reload'){controls.providerRetries++;assert.deepEqual(route.request().postDataJSON(),{sessionIds:['A']});result={scope:'open-web-sessions',applied:['A'],failures:[]};}
  else if(path.includes('/operations/')) result={status:controls.operationStatus,result:{accepted:true}};
  else if(path.endsWith('/open')) {const id=path.split('/')[3]; result={session:[...sessions,...controls.additionalSessions].find(s=>s.id===id),snapshot:controls.snapshotOverride||sessionSnapshot(id,initialCount),eventCursor:"fixture:0"};if(id===controls.holdOpen?.id)held=controls.holdOpen;}
  else if(path.endsWith('/rpc')){
   const {method}=route.request().postDataJSON(); const id=path.split('/')[3];
   if(method==='trust.status') result={configured:false};
   else if(method==='runtime.status') result={plugins:[],tools:[],commands:[]};
   else if(method==='plugins.ui-slots') result={slots:[]};
   else if(method==='subagent.status') result={providers:[],jobs:controls.jobs || []};
   else if(method==='policy.status') {result=policy;if(id===controls.holdPolicy?.id){held=controls.holdPolicy;result={...policy,mode:'allow'};}}
   else if(method==='policy.select') {controls.policySelections.push(route.request().postDataJSON());if(controls.rejectPolicy){controls.rejectPolicy=false;await route.fulfill({status:400,json:{ok:false,error:{message:'Fixture policy rejected'}}});return;}result={mode:route.request().postDataJSON().params.mode};}
   else if(method==='turn.submit'){controls.submissions.push(route.request().postDataJSON());if(controls.dropSubmit){controls.dropSubmit=false;await route.abort();return;}if(controls.rejectSubmit){controls.rejectSubmit=false;await route.fulfill({status:400,json:{ok:false,error:{message:'Fixture rejected before acceptance'}}});return;}result={accepted:true};}
   else if(method==='turn.steer'){controls.steers.push(route.request().postDataJSON());result={id:'steer-fixture'};}
   else if(method==='command.execute') result={output:'test-only'};
   else if(method==='session.rename') result={renamed:true};
   else if(method==='session.preferences.set') {if(controls.rejectPreference){controls.rejectPreference=false;await route.fulfill({status:400,json:{ok:false,error:{message:'Fixture preference not saved'}}});return;}const {response_detail}=route.request().postDataJSON().params;assert.ok(['short','auto','detailed'].includes(response_detail));const events=controls.preferenceEvents[id];const event={id:`preference-${id}-${events.length}`,seq:10000+events.length,at:'2026-10-15T15:00:00Z',type:'session/preferences',data:{response_detail}};events.push(event);result={response_detail,event};}
   else if(method==='session.snapshot') {result=sessionSnapshot(id);if(id===controls.holdSnapshot?.id){held=controls.holdSnapshot;result.events[1].data.message.content='STALE-SNAPSHOT';}}
   else if(method==='context.status') result=null;
   else if(method==='model.list') {result=controls.modelCatalog;if(id===controls.holdModels?.id)held=controls.holdModels;}
   else throw new Error(`Unmocked ${method}`);
  }else throw new Error(`Unmocked ${path}`);
  if(held){held.seen.resolve();await held.release.promise;}
  await route.fulfill({json:{ok:true,result}});
  held?.done.resolve();
 });
 return {page,controls};
}
const gate=(id)=>({id,seen:deferred(),release:deferred(),done:deferred()});
const settle=(page)=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const open=async(page,id)=>{await page.locator('.session-link').filter({hasText:`会话${id}`}).click();await page.locator('.session-header-title button').filter({hasText:`会话${id}`}).waitFor();};
try {
 for(let run=0;run<8;run++){
 {
  const {page,controls}=await fixture();await page.goto(base);await page.locator('.session-header-title button').waitFor();
  await page.locator('.new-session').click();
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:844});
   const files=page.getByRole('button',{name:'文件与变更',exact:true});
   for(let i=0;i<2;i++){
    await files.click();await page.getByRole('complementary',{name:'工作区文件',exact:true}).waitFor();
    await page.locator('.workspace-file-list').getByRole('button',{name:'note.md',exact:true}).waitFor();
    await page.getByRole('button',{name:'关闭文件面板',exact:true}).click();
    assert.equal(await files.evaluate(el=>el===document.activeElement),true,'closing the panel restores its opener');
   }
   await files.focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'关闭文件面板',exact:true}).waitFor();
   await page.keyboard.press('Escape');await page.locator('.workbench-drawer').waitFor({state:'hidden'});
   assert.equal(await files.evaluate(el=>el===document.activeElement),true,'keyboard open and immediate Escape restore focus');
   if(width<=600){
    await files.press('Enter');await page.getByRole('dialog',{name:'工作台',exact:true}).waitFor();
    assert.equal(await page.locator('main').evaluate(el=>el.inert),true);
    for(let i=0;i<16;i++){
     await page.keyboard.press('Tab');const inside=await page.locator('.workbench-drawer').evaluate(el=>el.contains(document.activeElement));
     if(!inside){console.log(JSON.stringify({draftFilesFocusFailure:{width,tab:i,state:await page.evaluate(()=>({active:document.activeElement?.outerHTML,controls:[...document.querySelectorAll('.workbench-drawer button,.workbench-drawer input')].map(el=>({html:el.outerHTML,visible:!!el.getClientRects().length,disabled:el.disabled,tabIndex:el.tabIndex})),text:document.querySelector('.workbench-drawer')?.textContent}))}}));if(process.env.QI_AGENT_BROWSER_ARTIFACTS)await page.screenshot({path:`${process.env.QI_AGENT_BROWSER_ARTIFACTS}/draft-files-tab-failure-${width}.png`});}
     assert.equal(inside,true,`mobile workbench focus escaped at Tab ${i}`);
    }
    await page.keyboard.press('Escape');assert.equal(await page.locator('main').evaluate(el=>el.inert),false);
   }
   const box=await files.boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2,{clickCount:2});
   if(await page.getByRole('button',{name:'关闭文件面板',exact:true}).isVisible())await page.getByRole('button',{name:'关闭文件面板',exact:true}).click();
   assert.equal(controls.submissions.length,0);assert.doesNotMatch(page.url(),/session=/);
  }
  await page.setViewportSize({width:1440,height:300});
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();
  const workspaces=page.getByRole('button',{name:'工作区',exact:true});await workspaces.scrollIntoViewIfNeeded();await workspaces.click();
  await page.locator('.workspace-row').getByText('隔离复现',{exact:true}).waitFor();
  assert.equal(await page.locator('.settings-layout > nav').evaluate(el=>el.scrollHeight>el.clientHeight&&el.scrollTop>0),true);
  await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  await page.close();console.log(JSON.stringify({draftFilesEntry:'passed',cases:['1440/390/320','real workspace listing','repeated open/close','double click','keyboard immediate Escape and return','mobile Tab boundary and inert cleanup','1440x300 settings navigation scroll','no session creation or submission']}));
 }
 console.log(JSON.stringify({focusedRepeat:run+1}));}
} finally{await browser.close();}
