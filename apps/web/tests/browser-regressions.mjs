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
async function fixture(initialCount=2){
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.sources=[];window.EventSource=class extends EventTarget{constructor(url){super();this.url=url;window.sources.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){this.closed=true;}}});
 const controls={holdSnapshot:null,holdOpen:null,holdPolicy:null,holdModels:null,snapshotOverride:null,steers:[],modelCatalog:models,providerSaves:0,providerRetries:0,dropSubmit:false,rejectSubmit:false,uploads:[],submissions:[],operationStatus:"completed",preferenceEvents:{A:[],B:[]},rejectPreference:false};
 const sessionSnapshot=(id,n=2)=>{const value=snapshot(id,n);value.events.push(...controls.preferenceEvents[id]);return value;};
 const provider={id:"mock-provider",name:"Mock Provider",protocol:"openai-completions",baseUrl:"https://example.invalid/v1",apiKeyConfigured:true,authType:"api-key",authStatus:"configured",models:[{id:"mock-model",name:"Mock Model"}]};
 await page.route('**/api/**', async route=>{
  const path=new URL(route.request().url()).pathname; let result; let held;
  if(path==='/api/bootstrap') result={workspaces:[{id:workspaceId,name:'隔离复现',path:'/mock',addedAt:'2026-10-02'}],catalogs:[{workspaceId,sessions}],activeWorkspaceId:workspaceId};
  else if(path.endsWith('/attachments')) {const input=route.request().postDataJSON();controls.uploads.push(input);result={type:'attachment',id:`fixture-upload-${controls.uploads.length}`,workspaceId,name:input.name,mime:input.mime,size:Buffer.from(input.base64,'base64').length};}
  else if(path.endsWith('/files') || path.endsWith('/search')) result={path:'',entries:[{name:'note.md',path:'note.md',kind:'file'},{name:'example.html',path:'example.html',kind:'file'}],truncated:false};
  else if(path.endsWith('/preview')) {const html=new URL(route.request().url()).searchParams.get('path')==='example.html';result={path:html?'example.html':'note.md',name:html?'example.html':'note.md',mime:html?'text/html':'text/markdown',size:200,kind:html?'html':'text',text:html?'<h1>Static fixture</h1><script>parent.fixtureScriptRan=true</script>':'# bounded file fixture'};}
  else if(path.endsWith('/changes')) result={turnId:'fixture-turn',partial:true,files:[{path:'note.md',status:'modified',before:'old',after:'new',diff:'--- a/note.md\n+++ b/note.md\n-old\n+new'}],notice:'Fixture changes only'};
  else if(path.endsWith('/references')) result={files:[{path:'note.md'}],sessions:[sessions[1]]};
  else if(path.endsWith('/resolve-references')) result=route.request().postDataJSON().message+'\n[User-selected source]\nbounded file fixture';
  else if(path==='/api/presets') result=[{id:'standard',name:'Standard',trust:'system'}];
  else if(path==='/api/providers') {
   if(route.request().method()==='GET')result={providers:[provider],presets:[]};
   else{controls.providerSaves++;result={...provider,reload:{scope:'open-web-sessions',applied:[],failures:[{sessionId:'A',sessionName:'会话A',message:'模拟超时'}]}};}
  }
  else if(path==='/api/providers/reload'){controls.providerRetries++;assert.deepEqual(route.request().postDataJSON(),{sessionIds:['A']});result={scope:'open-web-sessions',applied:['A'],failures:[]};}
  else if(path.includes('/operations/')) result={status:controls.operationStatus,result:{accepted:true}};
  else if(path.endsWith('/open')) {const id=path.split('/')[3]; result={session:sessions.find(s=>s.id===id),snapshot:controls.snapshotOverride||sessionSnapshot(id,initialCount),eventCursor:"fixture:0"};if(id===controls.holdOpen?.id)held=controls.holdOpen;}
  else if(path.endsWith('/rpc')){
   const {method}=route.request().postDataJSON(); const id=path.split('/')[3];
   if(method==='trust.status') result={configured:false};
   else if(method==='runtime.status') result={plugins:[],tools:[],commands:[]};
   else if(method==='plugins.ui-slots') result={slots:[]};
   else if(method==='subagent.status') result={providers:[],jobs:[]};
   else if(method==='policy.status') {result=policy;if(id===controls.holdPolicy?.id){held=controls.holdPolicy;result={...policy,mode:'allow'};}}
   else if(method==='turn.submit'){controls.submissions.push(route.request().postDataJSON());if(controls.dropSubmit){controls.dropSubmit=false;await route.abort();return;}if(controls.rejectSubmit){controls.rejectSubmit=false;await route.fulfill({status:400,json:{ok:false,error:{message:'Fixture rejected before acceptance'}}});return;}result={accepted:true};}
   else if(method==='turn.steer'){controls.steers.push(route.request().postDataJSON());result={id:'steer-fixture'};}
   else if(method==='command.execute') result={output:'test-only'};
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
  await page.getByRole('button',{name:'模型：Model A',exact:true}).click();
  await page.getByRole('menuitemradio',{name:'Model B',exact:true}).click();
  await page.getByRole('button',{name:'访问权限：Workspace Write',exact:true}).click();
  await page.getByRole('menuitemradio',{name:/Read Only/}).click();
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
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'模型',exact:true}).click();
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
  await page.getByRole('heading',{name:'今天想完成什么？',exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Agent 模式',exact:true}).inputValue(),'standard');
  await page.getByRole('button',{name:'分析项目',exact:true}).click();
  assert.match(await page.getByRole('textbox',{name:'给代理发送消息',exact:true}).inputValue(),/分析当前项目结构/);
  await page.close();console.log(JSON.stringify({compactNavigation:'passed',cases:['desktop collapse persists','phone drawer restores sessions','vertical session list','session switch','new session','quick start draft']}));
 }
 {
  const {page,controls}=await fixture();
  controls.modelCatalog={current:models.current,providers:[...models.providers,...['C','D','E','F'].map(letter=>({id:`mock-${letter.toLowerCase()}`,model:`Model ${letter}`}))]};
  await page.goto(base);await page.locator('.session-header-title button').waitFor();
  await page.locator('.new-session').click();await page.getByRole('button',{name:'模型：Model A',exact:true}).waitFor();
  const trigger=page.locator('.model-trigger');
  await trigger.click();
  const search=page.getByRole('searchbox',{name:'搜索模型',exact:true});await search.waitFor();
  assert.equal(await search.evaluate(node=>node===document.activeElement),true);
  await search.fill('not-a-model');await page.getByText('没有匹配的模型',{exact:true}).waitFor();
  await search.fill('MODEL f');assert.equal(await page.getByRole('menuitemradio').count(),1);
  await search.dispatchEvent('keydown',{key:'Enter',isComposing:true});
  assert.equal(await trigger.getAttribute('aria-expanded'),'true');
  await search.press('ArrowDown');await page.keyboard.press('Enter');
  assert.equal(await trigger.getAttribute('aria-label'),'模型：Model F');
  assert.equal(await trigger.evaluate(node=>node===document.activeElement),true);
  for(const width of [1440,768,414,375,320]){
   await page.setViewportSize({width,height:840});
   for(const selector of ['.model-trigger','.permission-trigger','.composer-tools > button']){
    const button=page.locator(selector);await button.click();await settle(page);
    const box=await page.locator('.composer-popover').boundingBox();
    assert.ok(box.x>=11&&box.x+box.width<=width-11&&box.y>=11&&box.y+box.height<=840-11,`${width}: ${JSON.stringify(box)}`);
    if(selector==='.model-trigger')assert.equal(await search.inputValue(),'');
    await page.keyboard.press('Escape');assert.equal(await button.evaluate(node=>node===document.activeElement),true);
   }
  }
  await page.locator('.permission-trigger').click();await page.keyboard.press('Home');await page.keyboard.press('Enter');
  assert.equal(await page.locator('.permission-trigger').getAttribute('aria-label'),'访问权限：Read Only');
  await trigger.click();await page.locator('textarea').click();assert.equal(await page.locator('.model-menu').count(),0);
  await page.close();console.log(JSON.stringify({composerSelection:'passed',cases:['search and empty state','IME guard','keyboard selection and focus return','1440/768/414/375/320 bounds','outside focus closes']}));
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
 assert.deepEqual(errors,[]);console.log(JSON.stringify({pageErrors:errors}));
}finally{await browser.close();}
