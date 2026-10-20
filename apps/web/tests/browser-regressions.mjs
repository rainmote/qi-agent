// Uses only mocked API data. Start Vite, then run npm run test:web-browser.
// QI_AGENT_PLAYWRIGHT_MODULE can select an existing Playwright installation.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.QI_AGENT_PLAYWRIGHT_MODULE || 'playwright');
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
try{
 {
  const {page,controls}=await fixture();
  await page.addInitScript(({workspaceId})=>{
   const replace=history.replaceState.bind(history);
   history.replaceState=(data,title,url)=>{
    replace(data,title,url);
    const target=new URL(String(url),location.href);
    if(!window.bootstrapHistoryRace&&target.hash==='#workspace='+workspaceId){
     window.bootstrapHistoryRace=true;
     // A real popstate can arrive after bootstrap chose a route and before
     // the first subscription. Force that scheduling gap without timers.
     target.hash='workspace='+workspaceId+'&session=B';
     replace(null,'',target);
     dispatchEvent(new PopStateEvent('popstate'));
    }
   };
  },{workspaceId});
  await page.goto(base+'/#workspace='+workspaceId+'&session=missing-bootstrap-route');
  await page.waitForFunction(()=>window.bootstrapHistoryRace===true);
  try{
   await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor({timeout:5000});
  }catch(error){
   console.log(JSON.stringify({bootstrapHistoryRace:'failed',state:await page.evaluate(()=>({hash:location.hash,text:document.body.innerText.slice(0,500)}))}));throw error;
  }
  assert.match(page.url(),/session=B/);assert.equal(controls.submissions.length,0);
  await page.close();console.log(JSON.stringify({bootstrapHistoryRace:'passed',cases:['popstate before first route subscription','allowed session restoration','no submission']}));
 }
 for(const target of ['B','A']){
  const {page,controls}=await fixture();const held=gate('A');controls.holdOpen=held;
  await page.addInitScript(({workspaceId,target})=>{
   const request=window.fetch.bind(window);window.historyPushes=0;
   const push=history.pushState.bind(history);history.pushState=(...args)=>{window.historyPushes++;return push(...args)};
   window.fetch=(input,init)=>{
    const pending=request(input,init);
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    if(!window.bootstrapOpenRace&&url.pathname==='/api/sessions/A/open'){
     window.bootstrapOpenRace=true;
     history.replaceState(null,'',target==='A'?'#session=A&workspace='+workspaceId:'#workspace='+workspaceId+'&session=B');
     dispatchEvent(new PopStateEvent('popstate'));
    }
    return pending;
   };
  },{workspaceId,target});
  await page.goto(base+'/#workspace='+workspaceId+'&session=A');await held.seen.promise;
  try{if(target==='B')await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();}
  finally{held.release.resolve()}
  await held.done.promise;await page.locator('.session-header-title button').filter({hasText:'会话'+target}).waitFor();await settle(page);
  assert.equal(await page.locator('.session-header-title button').innerText(),'会话'+target,'startup response respects the current allowed route');
  assert.match(page.url(),new RegExp('session='+target));assert.equal(await page.evaluate(()=>window.historyPushes),0);assert.equal(controls.submissions.length,0);
  await page.close();console.log(JSON.stringify({bootstrapLateOpen:'passed',target,cases:['A open held','navigation before initial subscription','release A','URL and visible allowed session preserved','semantic hash order','zero pushes or submissions']}));
 }
 {
  const {page,controls}=await fixture();
  const opens=[];page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/open'))opens.push(request.url())});
  await page.addInitScript(({workspaceId})=>{
   const replace=history.replaceState.bind(history);
   history.replaceState=(data,title,url)=>{
    replace(data,title,url);
    if(!window.bootstrapInvalidRace&&new URL(String(url),location.href).hash==='#workspace='+workspaceId){
     window.bootstrapInvalidRace=true;
     replace(null,'','#workspace='+workspaceId+'&session=another-missing-route');
     dispatchEvent(new PopStateEvent('popstate'));
    }
   };
  },{workspaceId});
  await page.goto(base+'/#workspace='+workspaceId+'&session=missing-bootstrap-route');await page.waitForFunction(()=>window.bootstrapInvalidRace===true);
  await page.waitForURL(url=>url.hash==='#workspace='+workspaceId);await page.locator('.new-session-center').waitFor();
  assert.equal(opens.length,0,'unlisted history IDs never open');assert.equal(controls.submissions.length,0);
  await page.close();console.log(JSON.stringify({bootstrapInvalidRoute:'passed',cases:['same parsed route with missing id','canonical URL restored','unlisted id never requested']}));
 }
 {
  const {page,controls}=await fixture();await page.goto(base);await page.locator('.session-header-title button').waitFor();
  const trigger=page.getByRole('button',{name:'更多操作',exact:true});await trigger.click();
  const menu=page.getByRole('menu',{name:'会话操作',exact:true});await menu.waitFor();
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(),['重命名','创建分支','归档']);
  await page.keyboard.press('Escape');assert.equal(await menu.count(),0);assert.equal(await trigger.evaluate(node=>document.activeElement===node),true);
  await trigger.click();const prompt=page.waitForEvent('dialog');const choosing=menu.getByRole('menuitem',{name:'重命名',exact:true}).click();
  await (await prompt).dismiss();await choosing;await settle(page);
  assert.equal(await menu.count(),0);assert.equal(await trigger.evaluate(node=>document.activeElement===node),true);
  assert.match(page.url(),/session=A/);assert.equal(controls.submissions.length,0);
  await page.close();console.log(JSON.stringify({headerSessionActions:'passed',cases:['existing callbacks exposed','Escape restores focus','rename cancellation','no navigation or submission']}));
 }
 {
  const {page,controls}=await fixture();await page.goto(base);await page.locator('.session-header-title button').waitFor();
  const footer=page.getByRole('button',{name:'设置',exact:true});await footer.click();
  await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(()=>document.activeElement.tagName),'A','arrow keys visit the feedback link');
  await page.keyboard.press('Escape');assert.equal(await footer.evaluate(e=>e===document.activeElement),true);
  await footer.click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();
  let settings=page.getByRole('dialog',{name:'设置',exact:true});
  const fontSize=settings.getByRole('spinbutton',{name:'会话字号',exact:true});await fontSize.fill('15');
  await settings.getByRole('button',{name:'增大会话字号',exact:true}).click();assert.equal(await fontSize.inputValue(),'16');
  assert.equal(await page.evaluate(()=>localStorage.getItem('qi-agent.content-font-size')),'16');
  await settings.getByRole('button',{name:'减小会话字号',exact:true}).click();assert.equal(await fontSize.inputValue(),'15');
  await fontSize.fill('');await settings.getByRole('button',{name:'通用设置',exact:true}).focus();assert.equal(await fontSize.inputValue(),'15','invalid drafts restore the last valid size');
  await fontSize.fill('22');assert.equal(await settings.getByRole('button',{name:'增大会话字号',exact:true}).isDisabled(),true);
  await fontSize.fill('10');assert.equal(await settings.getByRole('button',{name:'减小会话字号',exact:true}).isDisabled(),true);
  await fontSize.fill('14');
  const language=settings.getByRole('button',{name:'语言：中文',exact:true});await language.click();await page.getByRole('menuitemradio',{name:'中文',exact:true}).click();assert.equal(await language.evaluate(e=>e===document.activeElement),true,'supported language selection returns focus');
  for(const key of ['Tab','Shift+Tab']){
   await language.click();await page.keyboard.press(key);await settle(page);
   assert.equal(await page.getByRole('menu',{name:'语言',exact:true}).count(),0,'Tab dismisses a portaled menu');
   assert.equal(await settings.evaluate(node=>node.contains(document.activeElement)),true,'Tab keeps focus inside settings');
   assert.equal(controls.policySelections.length,0,'tab navigation never changes access');
  }
  let access=settings.locator('.permission-trigger');
  await access.click();await page.keyboard.press('Escape');
  assert.equal(await settings.isVisible(),true,'Escape closes only the nested access menu');
  assert.equal(await access.evaluate(e=>e===document.activeElement),true);
  for(const cancel of ['button','escape']){
   await access.click();await page.getByRole('menuitemradio',{name:/完全权限/}).click();
   const risk=page.getByRole('dialog',{name:'确认启用 Full Access？',exact:true});await risk.waitFor();
   assert.equal(await page.getByRole('dialog').count(),1,'only the risk dialog remains mounted');
   assert.equal(await page.getByRole('button',{name:'启用 Full Access',exact:true}).isDisabled(),true);
   if(cancel==='button')await page.getByRole('button',{name:'取消',exact:true}).click();else await page.keyboard.press('Escape');
   settings=page.getByRole('dialog',{name:'设置',exact:true});await settings.waitFor();access=settings.locator('.permission-trigger');
   await settle(page);assert.equal(await access.evaluate(e=>e===document.activeElement),true);
   assert.equal(controls.policySelections.length,0,'cancel cannot select policy');
  }
  controls.rejectPolicy=true;
  await access.click();await page.getByRole('menuitemradio',{name:/完全权限/}).click();
  await page.getByRole('checkbox',{name:'我已了解风险，并愿意继续'}).check();
  await page.getByRole('button',{name:'启用 Full Access',exact:true}).click();
  await page.getByText('Fixture policy rejected',{exact:true}).waitFor();
  settings=page.getByRole('dialog',{name:'设置',exact:true});await settings.waitFor();access=settings.locator('.permission-trigger');
  assert.equal(await access.getAttribute('aria-label'),'访问权限：Workspace Write','rejection restores the actual policy');
  await access.click();await page.getByRole('menuitemradio',{name:/完全权限/}).click();
  await page.getByRole('dialog',{name:'确认启用 Full Access？',exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog').count(),1,'retry uses the same confirmation path');
  await page.getByRole('checkbox',{name:'我已了解风险，并愿意继续'}).check();
  await page.getByRole('button',{name:'启用 Full Access',exact:true}).evaluate(e=>{e.click();e.click()});
  await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();await settle(page);
  assert.equal(controls.policySelections.length,2,'one rejected write and one retry; repeated confirm does not duplicate');
  assert.equal(controls.submissions.length,0,'presentation and policy controls never submit a turn');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#root').evaluate(e=>e.inert),false);
  await page.locator('textarea').fill('focus after risk dialog');assert.equal(await page.locator('textarea').inputValue(),'focus after risk dialog');
  await page.close();console.log(JSON.stringify({settingsRiskAndMenu:'passed',cases:['nested Escape','link keyboard navigation','cancel button','cancel Escape','one modal','risk acknowledgment','policy rejection and confirmed retry','double click once','root restored']}));
 }
 {
  const {page}=await fixture(2,{locale:'zh-CN',colorScheme:'light',reducedMotion:'reduce'});await page.goto(base);await page.locator('.session-header-title button').waitFor();await page.locator('.new-session').click();
  for(const [width,height,x,y,w] of [[1440,1000,469.296875,493,774.390625],[1024,844,296,415,705],[768,844,72,415,673],[390,844,72,415,295],[320,844,72,447,225]]){
   await page.setViewportSize({width,height});await page.waitForTimeout(350);await settle(page);const card=await page.locator('.composer').boundingBox();
   for(const [key,expected] of Object.entries({x,y,width:w,height:114}))assert.ok(Math.abs(card[key]-expected)<0.1,`${width}: ${key}: ${card[key]} != official ${expected}; ${JSON.stringify(await page.locator(".new-session-view").evaluate(e=>({padding:getComputedStyle(e).padding,scrollLeft:e.scrollLeft,client:e.clientWidth,rect:e.getBoundingClientRect().toJSON()})))}`);
   assert.equal((await page.locator('.send-button').boundingBox()).width,34);
  }
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'深色',exact:true}).click();await page.keyboard.press('Escape');
  assert.equal((await page.locator('.composer').boundingBox()).height,114,'theme and overlay round trip keep the empty input floor');
  await page.close();console.log(JSON.stringify({harnessGeometry:'passed',reference:'687f282',viewports:[1440,390,320],toleranceCssPixels:0.1}));
 }
 {
  const {page,controls}=await fixture(0);await page.goto(base);await page.locator('.session-header-title button').waitFor();
  const ends=['completed','failed','cancelled','uncertain'].map((status,index)=>({id:`outcome-${status}`,seq:100+index,at:'2026-10-15T00:00:00Z',type:'agent/run/end',data:{'run-id':`native-${status}`,status,reason:status==='uncertain'?'restored':status,verification:'not-run',...(status==='failed'?{error:'Offline provider fixture'}:{})}}));
  const dispatch=async(events)=>page.evaluate(events=>{const source=window.sources.findLast(source=>!source.closed);for(const event of events)source.dispatchEvent(new MessageEvent('worker',{data:JSON.stringify(event)}));},events);
  await dispatch(ends.flatMap(event=>[{type:'event',event:'agent.run/end',data:event.data},{type:'event',event:event.type,data:event.data,durable:true,event_id:event.id,seq:event.seq}]));
  await page.getByText(/结果未确认 · 需要核对/).waitFor();
  assert.equal(await page.locator('.run-outcome').count(),4);
  assert.equal(await page.locator('.run-outcome').filter({hasText:'尚未验收'}).count(),4);
  assert.equal(await page.locator('.inline-error').count(),0);
  controls.snapshotOverride={...snapshot('A',0),events:ends,state:{phase:'idle','last-outcome':ends.at(-1).data,revision:5}};
  await page.reload();await page.getByText(/结果未确认 · 需要核对/).waitFor();
  assert.equal(await page.locator('.run-outcome').count(),4);
  for(const width of [1440,375]){
   await page.setViewportSize({width,height:1000});await settle(page);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   if(process.env.QI_AGENT_BROWSER_ARTIFACTS)await page.screenshot({path:`${process.env.QI_AGENT_BROWSER_ARTIFACTS}/run-outcomes-${width}.png`,fullPage:true,animations:'disabled'});
  }
  await dispatch([{type:'event',event:'agent/state',data:{phase:'compacting','run-id':'active',revision:6,compaction:{'compaction-id':'c','completed-chunks':2,'total-chunks':6,'elapsed-ms':500,status:'progress'}}}]);
  await page.getByRole('status').filter({hasText:'整理上下文 2/6'}).waitFor();
  await page.locator('textarea').fill('Change the next step');
  await page.getByRole('button',{name:'下一步引导',exact:true}).click();
  await page.getByText('已接收，下一模型请求前生效',{exact:true}).waitFor();
  assert.equal(controls.steers.length,1);
  await dispatch([{type:'event',event:'agent/state',data:{phase:'idle',revision:7}}]);
  await page.getByRole('button',{name:'发送消息',exact:true}).waitFor();
  assert.equal(await page.locator('.composer-hint.has-run').count(),0);
  await page.close();
  console.log(JSON.stringify({nativeOutcomesAndCompactionProgress:'passed',cases:['four outcomes','live and durable deduplication','reload','375px','steer receipt','progress closes']}));
 }
 for(const returnToA of [false,true]){
  const {page,controls}=await fixture();const held=gate('A');controls.holdSnapshot=held;
  await page.goto(base);await page.locator('.session-header-title button').waitFor();
  await page.locator('textarea').fill('/probe');await page.getByRole('button',{name:'发送消息',exact:true}).click();await held.seen.promise;
  await open(page,'B');if(returnToA)await open(page,'A');held.release.resolve();await held.done.promise;await settle(page);
  assert.doesNotMatch(await page.locator('.timeline').innerText(),/STALE-SNAPSHOT/);
  assert.match(await page.locator('.timeline').innerText(),new RegExp(`${returnToA?'A':'B'}-controlled-message`));
  // Reopening the same session must also reconnect its event subscription.
  await open(page,returnToA?'A':'B');await settle(page);
  await page.evaluate(()=>{const source=window.sources.findLast(source=>!source.closed);source.dispatchEvent(new MessageEvent('worker',{data:JSON.stringify({type:'event',event:'message',event_id:'live-after-reopen',seq:99,durable:true,data:{message:{role:'assistant',content:'LIVE-AFTER-REOPEN'}}})}));});
  await page.getByText('LIVE-AFTER-REOPEN',{exact:true}).waitFor();
  await page.close();
 }
 {
  const {page,controls}=await fixture();await page.goto(base);await page.locator('.session-header-title button').waitFor();
  const held=gate('B');controls.holdOpen=held;
  await page.locator('.session-link').filter({hasText:'会话B'}).click();await held.seen.promise;
  await open(page,'A');held.release.resolve();await held.done.promise;await settle(page);
  assert.equal(await page.locator('.session-header-title button').innerText(),'会话A');await page.close();
 }
 {
  const {page,controls}=await fixture();const held=gate('A');controls.holdPolicy=held;
  await page.goto(base);await held.seen.promise;await open(page,'B');held.release.resolve();await held.done.promise;await settle(page);
  assert.equal(await page.getByRole('button',{name:'访问权限：Workspace Write',exact:true}).count(),1);await page.close();
 }
 {
  const {page,controls}=await fixture();await page.goto(base);await page.locator('.session-header-title button').waitFor();
  const held=gate('A');controls.holdModels=held;
  await page.locator('.new-session').click();await held.seen.promise;
  await page.getByRole('button',{name:'模型：Model A',exact:true}).click();await page.locator('.model-root-cell[data-pane=model]').click();
  await page.getByRole('menuitemradio',{name:'Model B',exact:true}).click();
  await page.getByRole('button',{name:'访问权限：Workspace Write',exact:true}).click();
  await page.getByRole('menuitemradio',{name:/仅可查看/}).click();
  held.release.resolve();await held.done.promise;await settle(page);
  assert.equal(await page.getByRole('button',{name:'模型：Model B',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'访问权限：Read Only',exact:true}).count(),1);await page.close();
 }
 for(const outcome of ['completed','not_found']){
  const {page,controls}=await fixture();controls.dropSubmit=true;controls.operationStatus=outcome;
  await page.goto(base);await page.locator('.session-header-title button').waitFor();
  assert.match(await page.evaluate(()=>window.sources.findLast(source=>!source.closed).url),/after=fixture%3A0/);
  await page.locator('textarea').fill('只执行一次');await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await page.getByRole('button',{name:'核对结果',exact:true}).waitFor();
  assert.equal(await page.locator('textarea').inputValue(),'');
  assert.equal(controls.submissions.length,1);
  await page.reload();await page.getByRole('button',{name:'核对结果',exact:true}).waitFor();
  await page.getByRole('button',{name:'核对结果',exact:true}).click();
  if(outcome==='not_found'){
   await page.getByRole('button',{name:'使用原编号重试',exact:true}).click();
   await page.getByRole('button',{name:'核对结果',exact:true}).waitFor({state:'hidden'});
   assert.deepEqual(controls.submissions[0],controls.submissions[1]);
  }else{
   await page.getByRole('button',{name:'核对结果',exact:true}).waitFor({state:'hidden'});
   assert.equal(controls.submissions.length,1);
  }
  await page.close();
 }
 console.log(JSON.stringify({submissionRecovery:'passed',cases:['response lost','page reload','completed without resend','not found retry with original identity','snapshot cursor handoff']}));
 console.log(JSON.stringify({sessionRaces:'passed',cases:['late snapshot','leave and return','reversed opens','late permissions','same-session SSE reconnect','draft choices survive late defaults']}));
 {
  const {page}=await fixture();await page.goto(base);await page.locator('.session-header-title button').waitFor();
  await page.evaluate(()=>{
   const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=900;
   const context=canvas.getContext('2d');context.fillStyle='#123456';context.fillRect(0,0,1200,900);
   context.fillStyle='#ffffff';context.font='48px sans-serif';context.fillText('Offline screenshot preview',50,80);
   const images=[{type:'image',url:canvas.toDataURL('image/png'),detail:'auto'},
    {type:'image',url:'https://untrusted.invalid/tracking.png'}];
   const source=window.sources.findLast(source=>!source.closed);
   const events=[['step/start',{}],['tool/call',{'call-id':'screen',name:'computer',arguments:{action:'screenshot'}}],
    ['tool/result',{'call-id':'screen',ok:true,content:'Screenshot captured',images}],
    ['message',{message:{role:'tool',tool_call_id:'screen',content:'Screenshot captured',images}}],['step/end',{}]];
   events.forEach(([event,data],i)=>source.dispatchEvent(new MessageEvent('worker',{data:JSON.stringify({
    type:'event',event,event_id:`screen-${i}`,seq:3+i,durable:true,data})})));
  });
  await page.locator('.tool-summary').click();
  const image=page.getByRole('img',{name:'工具返回的屏幕截图 1'});await image.waitFor();
  await image.evaluate(image=>image.decode());
  assert.equal(await page.locator('.tool-result-images img').count(),1);
  assert.ok((await image.boundingBox()).height<=240);
  assert.doesNotMatch(await page.locator('.timeline').innerText(),/data:image|base64|untrusted/);
  const expand=page.getByRole('button',{name:'放大截图 1',exact:true});await expand.click();
  const preview=page.getByRole('region',{name:'屏幕截图 1 原尺寸预览'});await preview.waitFor();
  assert.equal(await page.getByRole('button',{name:'收起截图 1',exact:true}).getAttribute('aria-expanded'),'true');
  await page.setViewportSize({width:320,height:840});await settle(page);
  const bounds=await preview.evaluate(element=>({width:element.clientWidth,scrollWidth:element.scrollWidth,height:element.clientHeight}));
  assert.ok(bounds.width<=320 && bounds.scrollWidth===1200 && bounds.height<=588,JSON.stringify(bounds));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await preview.focus();await page.keyboard.press('ArrowRight');
  await page.getByRole('button',{name:'收起截图 1',exact:true}).click();
  assert.ok((await image.boundingBox()).height<=240);
  await page.close();
  console.log(JSON.stringify({computerScreenshotPreview:'passed',cases:['streamed output','embedded raster only','bounded thumbnail','original size scroll preview','320px viewport','tool message deduplication']}));
 }
 for(const count of [2000,8000]){
  const {page}=await fixture(count);await page.goto(base);await page.locator('.session-header-title button').waitFor();
  const start=performance.now();await page.getByRole('tab',{name:'轨迹',exact:true}).click();await page.locator('.trajectory-record').first().waitFor();await settle(page);
  const elapsed=Math.round(performance.now()-start);const rows=await page.locator('.trajectory-record').count();const buttons=await page.locator('.trajectory-span').count();
  assert.ok(rows<80);assert.ok(buttons<=360);
  const heights=await page.locator('.trajectory-record').evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().height));assert.ok(heights.every(height=>height===32),JSON.stringify(heights));
  await page.getByRole('searchbox',{name:'搜索轨迹'}).fill(`A-controlled-message-${count-1}`);
  await page.waitForFunction(()=>document.querySelectorAll('.trajectory-span[data-match="true"]').length===1);
  await page.locator('.trajectory-span[data-match="true"]').click();await page.locator(`#trajectory-A-${count-1}`).waitFor();
  assert.equal(await page.locator('.trajectory-detail-row').count(),1);
  assert.equal(await page.locator('.trajectory-detail-row').evaluate(row=>row.getBoundingClientRect().height),272);
  await page.getByRole('searchbox',{name:'搜索轨迹'}).fill('');
  await page.getByRole('button',{name:'Collapse turns',exact:true}).click();await settle(page);
  assert.equal(await page.locator('.trajectory-table').getAttribute('aria-rowcount'),String(count/2));
  await page.getByRole('button',{name:'Expand turns',exact:true}).click();await settle(page);
  for(const width of [390,320]){await page.setViewportSize({width,height:840});await settle(page);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await page.locator('.trajectory-record').count()<80);}
  console.log(JSON.stringify({trajectoryEvents:count,mountedRows:rows,overviewButtons:buttons,tabSwitchMs:elapsed,searchJumpCollapseAndNarrowWidths:'passed'}));
  await page.close();
 }
 {
  const {page,controls}=await fixture();await page.goto(base);await page.locator('.session-header-title button').waitFor();
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'模型',exact:true}).click();
  await page.getByRole('button',{name:'编辑 Mock Provider (mock-provider)',exact:true}).click();
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByText('配置已保存，1 个 Web 会话尚未生效。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'重试未生效会话',exact:true}).click();
  await page.getByText('配置已保存，已更新 1 个 Web 会话。',{exact:true}).waitFor();
  assert.equal(controls.providerSaves,1);assert.equal(controls.providerRetries,1);await page.close();
  console.log(JSON.stringify({providerPartialFailureAndRetry:'passed',configurationWrites:1}));
 }
 {
  const {page,controls}=await fixture();await page.goto(base);await page.locator('.session-header-title button').waitFor();
  await page.getByRole('button',{name:'添加附件与工具',exact:true}).click();
  await page.getByRole('menuitem',{name:'文件与变更',exact:true}).click();
  await page.locator('.workspace-file-list').getByRole('button',{name:'example.html',exact:true}).click();
  await page.frameLocator('iframe[title="example.html 静态预览"]').getByRole('heading',{name:'Static fixture'}).waitFor();
  assert.equal(await page.evaluate(()=>window.fixtureScriptRan),undefined);
  for(const width of [1440,768,414,375,320]){await page.setViewportSize({width,height:900});await settle(page);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`workbench overflow ${width}`);}
  await page.getByRole('button',{name:'本轮变更',exact:true}).click();
  await page.getByLabel('本轮结果摘要').waitFor();assert.equal(await page.getByLabel('本轮结果摘要').locator('p').count(),3);
  assert.match(await page.getByLabel('本轮结果摘要').innerText(),/部分记录[\s\S]*尚未关联[\s\S]*核对遗漏/);
  assert.equal(await page.locator('.workspace-diff').getAttribute('open'),'');assert.match(await page.locator('.workspace-diff pre').innerText(),/\+new/);
  await page.getByLabel('结果详略',{exact:true}).selectOption('short');await page.waitForFunction(()=>document.querySelector('select[aria-label="结果详略"]').value==='short');
  assert.equal(await page.locator('.workspace-diff').getAttribute('open'),null);assert.equal(await page.locator('.workspace-capture-scope').getAttribute('open'),'');
  controls.rejectPreference=true;await page.getByLabel('结果详略',{exact:true}).selectOption('detailed');await page.getByRole('alert').filter({hasText:'Fixture preference not saved'}).waitFor();assert.equal(await page.getByLabel('结果详略',{exact:true}).inputValue(),'short');
  await page.getByLabel('结果详略',{exact:true}).selectOption('detailed');await page.waitForFunction(()=>document.querySelector('select[aria-label="结果详略"]').value==='detailed');assert.equal(await page.locator('.workspace-diff').getAttribute('open'),'');
  for (const status of ['PASS','UNKNOWN','NOT_RUN']) {
   controls.verification={status,checks:[{id:'acceptance',status:'PASS'}]};
   await page.getByRole('button',{name:'刷新',exact:true}).click();
   const summary=page.getByLabel('本轮结果摘要');
   await page.getByRole('button',{name:'刷新',exact:true}).waitFor({state:'visible'});
   if(status==='PASS') await summary.getByText(/独立验收通过/).waitFor();
   else if(status==='UNKNOWN') await summary.getByText(/验收结果未确认/).waitFor();
   else await summary.getByText(/尚未关联本轮文件指纹/).waitFor();
  }

  await page.reload();await page.getByRole('button',{name:'添加附件与工具',exact:true}).click();await page.getByRole('menuitem',{name:'文件与变更',exact:true}).click();assert.equal(await page.getByLabel('结果详略',{exact:true}).inputValue(),'detailed');
  await page.screenshot({path:process.env.QI_U3_SCREENSHOT||'/tmp/qi-u3-result-summary.png',fullPage:true});
  await page.getByRole('button',{name:'关闭文件面板',exact:true}).click();
  await page.getByLabel('选择附件').setInputFiles({name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('attachment fixture')});
  await page.getByRole('list',{name:'待发送附件'}).getByText('note.txt',{exact:true}).waitFor();
  await page.locator('textarea').fill('@file:note');await page.getByRole('button',{name:'文件 · note.md',exact:true}).click();
  controls.rejectSubmit=true;await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await page.getByText('Fixture rejected before acceptance',{exact:true}).waitFor();
  assert.match(await page.locator('textarea').inputValue(),/@file:"note.md"/);
  await page.getByRole('list',{name:'待发送附件'}).getByText('note.txt',{exact:true}).waitFor();
  assert.equal(controls.uploads.length,1);
  assert.equal(controls.submissions[0].params.message[1].type,'attachment');
  assert.match(controls.submissions[0].params.message[0].text,/bounded file fixture/);
  assert.doesNotMatch(JSON.stringify(controls.submissions[0]),/YXR0YWNobWVudCBmaXh0dXJl/);
  controls.dropSubmit=true;controls.operationStatus='failed';await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await page.getByRole('button',{name:'核对结果',exact:true}).waitFor();await page.reload();await page.getByRole('button',{name:'核对结果',exact:true}).click();
  await page.getByRole('list',{name:'待发送附件'}).getByText('note.txt',{exact:true}).waitFor();assert.match(await page.locator('textarea').inputValue(),/bounded file fixture/);
  await page.close();console.log(JSON.stringify({workspaceTools:'passed',cases:['sandbox HTML','text diff','1440/768/414/375/320px','attachment IDs only','actual selected reference payload','definitive failure restores draft','unknown then failed restores after reload']}));
 }
 {
  const {page}=await fixture();await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(base);await page.locator('.session-header-title button').waitFor();
  await page.getByRole('button',{name:'收起侧边栏',exact:true}).click();
  await page.setViewportSize({width:375,height:840});await page.reload();
  await page.getByRole('button',{name:'打开导航',exact:true}).click();
  const navigation=page.getByRole('navigation',{name:'会话列表',exact:true});await navigation.waitFor();
  const rows=await navigation.locator('.session-row').evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().toJSON()));
  assert.equal(rows.length,2);assert.equal(rows[0].x,rows[1].x);assert.ok(rows[1].y>=rows[0].bottom);
  await navigation.locator('.session-link').filter({hasText:'会话B'}).click();
  await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();
  await page.getByRole('button',{name:'打开导航',exact:true}).click();
  await page.locator('.sidebar .new-session').click();
  await page.getByRole('heading',{name:'探索未至之境',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Agent 模式',exact:true}).getAttribute('data-preset-id'),'standard');
  await page.getByRole('button',{name:'添加附件与工具',exact:true}).click();await page.getByRole('menuitem',{name:'分析项目',exact:true}).click();
  assert.match(await page.getByRole('textbox',{name:'给代理发送消息',exact:true}).inputValue(),/分析当前项目结构/);
  await page.close();console.log(JSON.stringify({compactNavigation:'passed',cases:['desktop collapse persists','phone drawer restores sessions','vertical session list','session switch','new session','quick start draft']}));
 }
 for(const width of [1440,320]){
  const {page,controls}=await fixture();
  controls.presetCatalog=[{id:'standard',name:'标准模式',trust:'system',description:'标准任务说明'},
   {id:'creator',name:'创造模式',trust:'system',description:'真实创造模式说明'}];
  await page.setViewportSize({width,height:844});await page.goto(base);await page.locator('.session-header-title button').waitFor();
  if(width===320)await page.getByRole('button',{name:'打开导航',exact:true}).click();
  await page.locator('.new-session').click();const trigger=page.getByRole('button',{name:'Agent 模式',exact:true});
  await trigger.click();let menu=page.getByRole('menu',{name:'Agent 模式',exact:true});
  assert.equal(await menu.getByRole('menuitemradio').count(),2);await menu.getByText('真实创造模式说明',{exact:true}).waitFor();
  await page.keyboard.press('Escape');assert.equal(await menu.count(),0);assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
  assert.equal(await trigger.getAttribute('data-preset-id'),'standard');
  await trigger.click();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  assert.equal(await trigger.getAttribute('data-preset-id'),'creator');assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
  await trigger.click();await page.keyboard.press('Tab');assert.equal(await menu.count(),0);
  assert.equal(await trigger.getAttribute('data-preset-id'),'creator');assert.equal(controls.submissions.length,0);
  await trigger.click();await menu.locator('[data-preset-id="standard"]').dblclick();await settle(page);
  assert.equal(await trigger.getAttribute('data-preset-id'),'standard');assert.equal(controls.submissions.length,0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.close();console.log(JSON.stringify({presetMenu:'passed',width,cases:['real descriptions','Escape cancellation','arrow and Enter selection','focus return','Tab dismisses without mutation','double click does not create or submit','no horizontal overflow']}));
 }
 {
  const {page,controls}=await fixture();
  controls.modelCatalog={current:models.current,providers:[...models.providers,...['C','D','E','F'].map(letter=>({id:`mock-${letter.toLowerCase()}`,model:`Model ${letter}`}))]};
  await page.goto(base);await page.locator('.session-header-title button').waitFor();
  await page.locator('.new-session').click();await page.getByRole('button',{name:'模型：Model A',exact:true}).waitFor();
  const trigger=page.locator('.model-trigger');
  await trigger.click();await page.locator('.model-root-cell[data-pane=model]').click();
  const search=page.getByRole('searchbox',{name:'搜索模型',exact:true});await search.waitFor();
  assert.equal(await search.evaluate(node=>node===document.activeElement),true);
  await search.fill('not-a-model');await page.getByText('没有匹配的模型',{exact:true}).waitFor();
  await search.fill('MODEL f');assert.equal(await page.getByRole('menuitemradio').count(),1);
  await search.dispatchEvent('keydown',{key:'Enter',isComposing:true});
  assert.equal(await trigger.getAttribute('aria-expanded'),'true');
  await search.press('ArrowDown');assert.equal(await search.evaluate(e=>e===document.activeElement),true,'search arrows keep input focus');await page.keyboard.press('Enter');
  assert.equal(await trigger.getAttribute('aria-label'),'模型：Model F');
  await trigger.click();await page.keyboard.press('Tab');await search.waitFor();await search.fill('Model E');await search.press('Tab');assert.equal(await trigger.getAttribute('aria-label'),'模型：Model E','Tab accepts the highlighted search result');
  await trigger.click();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await page.locator('.model-root-cell[data-pane=model]').waitFor();await page.keyboard.press('Shift+Tab');assert.equal(await trigger.getAttribute('aria-expanded'),'false','Shift+Tab from root closes the model menu');assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
  assert.equal(await trigger.evaluate(node=>node===document.activeElement),true);
  for(const width of [1440,768,414,375,320]){
   await page.setViewportSize({width,height:840});
   for(const selector of ['.model-trigger','.permission-trigger','.composer-tools > button']){
    const button=page.locator(selector);await button.click();await settle(page);
    const box=await page.locator('.composer-popover').boundingBox();
    assert.ok(box.x>=11&&box.x+box.width<=width-11&&box.y>=11&&box.y+box.height<=840-11,`${width}: ${JSON.stringify(box)}`);
    if(selector==='.model-trigger'){await page.locator('.model-root-cell[data-pane=model]').click();assert.equal(await search.inputValue(),'');await page.keyboard.press('Escape');}
    await page.keyboard.press('Escape');assert.equal(await button.evaluate(node=>node===document.activeElement),true);
   }
  }
  await page.locator('.permission-trigger').click();await page.keyboard.press('Home');await page.keyboard.press('Enter');
  assert.equal(await page.locator('.permission-trigger').getAttribute('aria-label'),'访问权限：Read Only');
  // The centered hero's upward menu may cover the textarea's center on a phone.
  // Test the focus-out contract without targeting a point covered by the open menu.
  await trigger.click();await page.locator('textarea').focus();assert.equal(await page.locator('.model-menu').count(),0);
  await page.close();console.log(JSON.stringify({composerSelection:'passed',cases:['search and empty state','IME guard','keyboard selection and focus return','1440/768/414/375/320 bounds','outside focus closes']}));
 }
 {
  const {page,controls}=await fixture();controls.modelCatalog={current:models.current,providers:[models.current]};
  await page.goto(base);await page.locator('.session-header-title button').waitFor();await page.locator('.new-session').click();
  const trigger=page.locator('.model-trigger');
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:844});await settle(page);await trigger.focus();await page.keyboard.press('Enter');
   const summary=page.locator('.model-root-cell[data-pane=model]');await summary.waitFor();
   assert.equal(await summary.evaluate(e=>e===document.activeElement),true,'initial focus skips hidden options');
   await page.keyboard.press('Enter');const option=page.getByRole('menuitemradio',{name:'Model A',exact:true});await option.waitFor();await settle(page);
   assert.equal(await option.evaluate(e=>e===document.activeElement),true);
   let box=await page.locator('.harness-model-menu').boundingBox();
   assert.ok(box.x>=11&&box.x+box.width<=width-11&&box.y>=11&&box.y+box.height<=844-11,`single ${width}: ${JSON.stringify(box)}`);
   await page.keyboard.press('Escape');assert.equal(await summary.evaluate(e=>e===document.activeElement),true,'Escape backs out to the root cell');
   await page.keyboard.press('Escape');assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
   await trigger.click();await summary.click();await option.waitFor();box=await page.locator('.harness-model-menu').boundingBox();
   assert.ok(box.x>=11&&box.x+box.width<=width-11,`hover single ${width}: ${JSON.stringify(box)}`);
   await option.click();assert.equal(await trigger.getAttribute('aria-expanded'),'false');
  }
  await page.close();console.log(JSON.stringify({singleModelMenu:'passed',viewports:[1440,390,320],cases:['visible initial focus','keyboard drill','pointer drill','bounds','Escape backs then closes','selection close']}));
 }
 {
  const {page}=await fixture();await page.goto(base);await page.locator('.session-header-title button').waitFor();
  await page.evaluate(()=>{
   const events=[['step/start',{step:1}],
    ['tool/call',{'call-id':'a',name:'read',arguments:{path:'sample-a.ts'}}],
    ['tool/result',{'call-id':'a',ok:true,content:'FIRST-DETAIL'}],
    ['tool/call',{'call-id':'b',name:'grep',arguments:{query:'needle'}}],
    ['tool/result',{'call-id':'b',ok:false,error:'Search permission denied'}],['step/end',{}],
    ['step/start',{step:2}],['tool/call',{'call-id':'c',name:'bash',arguments:{command:'offline-command'}}],['step/end',{}]];
   const source=window.sources.findLast(source=>!source.closed);
   events.forEach(([event,data],i)=>source.dispatchEvent(new MessageEvent('worker',{data:JSON.stringify({type:'event',event,data,event_id:`compact-${i}`,seq:3+i,durable:true})})));
  });
  await page.getByText('Search permission denied',{exact:false}).waitFor();
  const groups=page.locator('.tool-batch');assert.equal(await groups.count(),2);
  assert.equal(await page.locator('.tool-batch-row').count(),0);
  assert.match(await groups.last().innerText(),/结果未确认/);assert.doesNotMatch(await groups.last().getAttribute('class'),/is-running|is-success/);
  await groups.first().locator('.tool-summary').click();assert.equal(await page.locator('.tool-batch-row').count(),2);
  await page.getByRole('button',{name:/read sample-a.ts/}).click();await page.getByText('FIRST-DETAIL',{exact:true}).waitFor();
  assert.equal(await page.locator('.tool-details').count(),1);
  await groups.first().locator('.tool-summary').click();await groups.first().locator('.tool-summary').click();
  assert.equal(await page.getByText('FIRST-DETAIL',{exact:true}).count(),1,'Expansion survives hiding the group');
  await page.setViewportSize({width:320,height:840});await settle(page);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.close();console.log(JSON.stringify({compactToolGroups:'passed',cases:['collapsed summary','failure stays visible','stopped call is unconfirmed','independent details','expansion retained','320px viewport']}));
 }
 {
  const {page,controls}=await fixture();
  const data=[['message',{message:{role:'user',content:'检查文件'}}],['tool/call',{'call-id':'harness-read',name:'read',arguments:{path:'README.md'}}],
   ['tool/result',{'call-id':'harness-read',ok:true,content:'HARNESS-TOOL-DETAIL'}],
   ['message',{message:{role:'assistant',content:'HARNESS-FINAL-ANSWER',reasoning_content:'HARNESS-REASONING'}}],
   ['agent/run/end',{'run-id':'harness-ui',status:'completed',verification:'not-run'}]];
  controls.snapshotOverride={...snapshot('A',0),events:data.map(([type,data],i)=>({id:`harness-${i}`,seq:i+1,at:'2026-10-19T00:00:00Z',type,data}))};
  controls.jobs=[{id:'child-1',label:'离线子任务',provider:'fixture',status:'completed',result:'HARNESS-CHILD-RESULT'}];
  await page.goto(base);await page.getByText('HARNESS-FINAL-ANSWER',{exact:true}).waitFor();
  assert.equal(await page.locator('.tool-summary').count(),0,'settled process starts folded');
  await page.getByRole('button',{name:/工作步骤 ·/}).click();await page.locator('.tool-summary').waitFor();
  await page.locator('.reasoning-row > summary').click();await page.locator('.reasoning-content > summary').click();await page.locator('.reasoning-row[open] .markdown-content').getByText('HARNESS-REASONING',{exact:true}).waitFor();
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();
  assert.equal(await page.locator('#root').evaluate(e=>e.inert),true);
  await page.getByRole('combobox',{name:'工作步骤展示'}).selectOption('verbose');
  await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'设置',exact:true}).waitFor({state:'hidden'});
  assert.equal(await page.getByRole('button',{name:'设置',exact:true}).evaluate(e=>e===document.activeElement),true);
  assert.equal(await page.locator('.tool-summary').count(),0,'verbose removes group headers');
  await page.locator('.tool-batch-row').click();await page.getByText('HARNESS-TOOL-DETAIL',{exact:true}).waitFor();
  assert.equal(controls.submissions.length,0,'presentation controls cannot submit a command');
  await page.reload();await page.locator('.tool-batch-row').waitFor();
  await page.locator('.session-subagents-trigger').click();await page.locator('.session-subagents .subagent-disclosure summary').first().click();await page.getByText('HARNESS-CHILD-RESULT',{exact:true}).waitFor();
  for(const width of [768,390,320]){
   await page.setViewportSize({width,height:844});await settle(page);
   await page.getByRole('button',{name:'打开导航',exact:true}).click();
   await page.getByRole('dialog',{name:'导航',exact:true}).waitFor();
   assert.equal(await page.locator('main').evaluate(e=>e.inert),true);
   await page.locator('.session-link').filter({hasText:'会话B'}).click();await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();
   await page.getByRole('button',{name:'打开导航',exact:true}).click();
   await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();
   const navigation=await page.locator('.settings-layout > nav').boundingBox();
   for(const button of await page.locator('.settings-layout > nav > button').all()){
    const box=await button.boundingBox();assert.ok(box.y>=navigation.y&&box.y+box.height<=navigation.y+navigation.height,'settings labels cannot be vertically clipped');
   }
   await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'设置',exact:true}).waitFor({state:'hidden'});
   await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'导航',exact:true}).waitFor({state:'hidden'});
  }
  await page.close();console.log(JSON.stringify({harnessPresentation:'passed',cases:['settled process and reasoning','verbose tools','no mutation','persisted mode','subtask result','768/390/320 session access','modal focus return','settings labels fit']}));
 }
 {
  const {page,controls}=await fixture(0);
  await page.addInitScript(()=>localStorage.setItem('qi-agent.transcript-view','detailed'));
  controls.snapshotOverride={...snapshot('A',0),state:{phase:'tool',revision:2},events:[
   {id:'focus-user',seq:1,type:'message',at:'2026-10-19T00:00:00Z',data:{message:{role:'user',content:'焦点验收'}}},
   {id:'focus-call',seq:2,type:'tool/call',at:'2026-10-19T00:00:00Z',data:{name:'read','call-id':'focus-read',arguments:{path:'README.md'}}}]};
  await page.goto(base);const tool=page.locator('.tool-batch-row');await tool.waitFor();await tool.focus();
  await page.evaluate(()=>{
   const source=window.sources.findLast(source=>!source.closed);
   for(const event of [
    {type:'event',event:'tool/result',event_id:'focus-result',seq:3,durable:true,data:{'call-id':'focus-read',ok:true,content:'FOCUS-RESULT'}},
    {type:'event',event:'agent/run/end',event_id:'focus-end',seq:4,durable:true,data:{'run-id':'focus-run',status:'completed',verification:'not-run'}},
    {type:'event',event:'agent/state',data:{phase:'idle',revision:3}}])source.dispatchEvent(new MessageEvent('worker',{data:JSON.stringify(event)}));
  });
  await page.locator('.run-outcome').waitFor();
  assert.equal(await tool.isVisible(),true,'settlement must not unmount the focused detailed tool');
  assert.equal(await tool.evaluate(e=>e===document.activeElement),true,'settlement preserves the exact focused control');
  const fold=page.getByRole('button',{name:/工作步骤 ·/});await fold.click();await fold.click();
  await page.locator('.tool-summary').waitFor();assert.equal(await page.locator('.tool-details').count(),0,'whole-turn collapse resets child expansion');
  const summary=page.locator('.tool-summary'),header=await summary.elementHandle();await summary.focus();await settle(page);
  assert.equal(await header.evaluate(e=>e.isConnected&&e===document.activeElement),true,'focusing a settled group must preserve the grouped header');
  await summary.click();assert.equal(await summary.getAttribute('aria-expanded'),'true');await page.getByText('FOCUS-RESULT',{exact:true}).waitFor();
  await summary.click();assert.equal(await summary.getAttribute('aria-expanded'),'false');
  await page.close();console.log(JSON.stringify({detailedSettlementFocus:'passed'}));
 }
 {
  const {page}=await fixture(0,{reducedMotion:'reduce'});await page.goto(base);await page.locator('.session-header-title button').waitFor();const input=page.locator('textarea');await input.waitFor();
  for(const width of [390,320]){
   await page.setViewportSize({width,height:844});await settle(page);
   const placeholder = page.locator('.composer-placeholder');
   assert.equal(await placeholder.isVisible(),true);
   assert.equal(await placeholder.evaluate(e => getComputedStyle(e).whiteSpace), 'nowrap', 'docked empty hint stays a single truncated line');
   assert.equal(await input.evaluate(e=>e.clientHeight),36,'empty docked input does not grow to fit placeholder text');
  }
  await page.setViewportSize({width:1440,height:1000});await input.fill('响应式输入 '.repeat(30));
  await page.setViewportSize({width:390,height:844});await settle(page);
  assert.equal(await input.evaluate(e=>e.scrollHeight<=e.clientHeight||getComputedStyle(e).overflowY==='auto'),true,'wrapped drafts remain visible or scrollable after a width change');
  await page.close();console.log(JSON.stringify({composerResize:'passed'}));
 }
 for(const width of [1440,390]){
  const {page,controls}=await fixture();await page.setViewportSize({width,height:width===1440?1000:844});
  const choose=async id=>{
   if(width===390)await page.getByRole('button',{name:'打开导航',exact:true}).click();
   await open(page,id);
  };
  await page.goto(base);await page.locator('.session-header-title button').filter({hasText:'会话A'}).waitFor();
  await choose('B');await page.goBack();await settle(page);
  assert.equal(await page.locator('.session-header-title button').count(),1,'browser Back must stay in the recorded session history');
  await page.locator('.session-header-title button').filter({hasText:'会话A'}).waitFor();
  assert.equal(await page.locator('.session-header-title button').innerText(),'会话A','browser Back must return to the prior session');
  await page.goForward();await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();
  if(width===390)await page.getByRole('button',{name:'打开导航',exact:true}).click();
  await page.locator('.new-session').click();await page.locator('.new-session-center').waitFor();
  await page.goBack();await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();
  await page.goForward();await page.locator('.new-session-center').waitFor();
  await page.reload();await page.locator('.new-session-center').waitFor();
  await page.goBack();await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();
  await page.reload();await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();
  await page.route('**/history-away',route=>route.fulfill({contentType:'text/html',body:'<title>Local history fixture</title><p>Local history fixture</p>'}));
  await page.goto(`${base}/history-away`);await page.goBack();await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();
  await page.goForward();assert.equal(await page.title(),'Local history fixture');
  await page.goBack();await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();
  assert.equal(controls.submissions.length,0,'browser history must never replay a submission');
  assert.equal(await page.locator('main').evaluate(e=>e.inert),false);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.QI_AGENT_BROWSER_ARTIFACTS)await page.screenshot({path:`${process.env.QI_AGENT_BROWSER_ARTIFACTS}/browser-history-return-${width}.png`,animations:'disabled'});
  await page.close();console.log(JSON.stringify({browserHistory:'passed',width,cases:['session Back/Forward','new-session Back/Forward','reload selected session and new view','leave page and return selected session','no submission replay']}));
 }
 for(const width of [1440,390]){
  const {page,controls}=await fixture();const held=gate('catalog');controls.holdCatalog=held;
  await page.setViewportSize({width,height:width===1440?1000:844});await page.goto(base);await page.locator('.session-header-title button').waitFor();
  if(width===390)await page.getByRole('button',{name:'打开导航',exact:true}).click();
  await page.getByRole('button',{name:'会话操作: 会话A',exact:true}).click();await page.getByRole('menuitem',{name:'创建分支',exact:true}).click();
  await page.locator('.session-header-title button').filter({hasText:'会话C'}).waitFor();await held.seen.promise;
  try{
   await page.goBack();await page.locator('.session-header-title button').filter({hasText:'会话A'}).waitFor();
   await page.goForward();await settle(page);
   assert.equal(await page.locator('.session-header-title button').count(),1,'a confirmed fork must remain in history while catalog refresh is pending');
   await page.locator('.session-header-title button').filter({hasText:'会话C'}).waitFor();
   assert.equal(new URL(page.url()).hash.includes('session=C'),true);assert.equal(controls.forks,1);assert.equal(controls.submissions.length,0);
  }finally{held.release.resolve();await held.done.promise;}
  await page.close();console.log(JSON.stringify({browserHistoryPendingCatalog:'passed',width,forkRequests:controls.forks}));
 }
 {
  const {page,controls}=await fixture();const old=gate('old-catalog'),latest=gate('new-catalog');controls.catalogGates=[old,latest];
  await page.goto(base);await page.locator('.session-header-title button').waitFor();
  await page.getByRole('button',{name:'会话操作: 会话A',exact:true}).click();page.once('dialog',dialog=>dialog.accept('会话A renamed'));
  await page.getByRole('menuitem',{name:'重命名',exact:true}).click();await old.seen.promise;
  await page.getByRole('button',{name:'会话操作: 会话A',exact:true}).click();await page.getByRole('menuitem',{name:'创建分支',exact:true}).click();
  await page.locator('.session-header-title button').filter({hasText:'会话C'}).waitFor();await latest.seen.promise;
  try{
   old.release.resolve();await old.done.promise;await settle(page);
   await page.goBack();await page.locator('.session-header-title button').filter({hasText:'会话A'}).waitFor();
   await page.goForward();await settle(page);
   assert.equal(await page.locator('.session-header-title button').count(),1,'a stale catalog response must not erase a confirmed session history entry');
   await page.locator('.session-header-title button').filter({hasText:'会话C'}).waitFor();assert.equal(controls.forks,1);assert.equal(controls.submissions.length,0);
  }finally{old.release.resolve();latest.release.resolve();await Promise.all([old.done.promise,latest.done.promise]);}
  await page.close();console.log(JSON.stringify({browserHistoryStaleCatalog:'passed',width:1440,forkRequests:controls.forks}));
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({pageErrors:errors}));
}finally{await browser.close();}
