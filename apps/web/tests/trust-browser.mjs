// Controlled browser tests exercise production UI; they never trust a host project.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browser, base, errors, fixture, settle, gate, sessions, workspaceId } from './browser-fixture.mjs';

const artifacts=process.env.QI_AGENT_BROWSER_ARTIFACTS;
const allowed={configured:true,root:'/mock/project-a',decision:'allow','explicit?':true,'matched-root':'/mock/project-a',source:'user-store',mutable:true};
const restricted={...allowed,decision:'deny'};
const undecided={...restricted,'explicit?':false,'matched-root':null};
const manager=page=>page.getByRole('dialog',{name:'项目信任',exact:true});
const initial=page=>page.getByRole('dialog',{name:'是否信任这个项目？',exact:true});
const input=page=>page.getByRole('textbox',{name:'给代理发送消息',exact:true});
const entry=page=>page.locator('.composer-trust').getByRole('button',{name:'管理项目信任',exact:true});
const settingsEntry=page=>page.getByRole('dialog',{name:'设置',exact:true}).getByRole('button',{name:'管理项目信任',exact:true});
const shot=async(page,name)=>{
 if(!artifacts)return;await fs.mkdir(artifacts,{recursive:true});await settle(page);
 await page.screenshot({path:`${artifacts}/trust-${name}.png`,animations:'disabled',fullPage:true});
 const state=await page.evaluate(()=>({dpr:devicePixelRatio,locale:document.documentElement.lang,theme:document.body.dataset.theme,
  bodyFont:getComputedStyle(document.body).fontFamily,dialogs:[...document.querySelectorAll('[role="dialog"]')].map(el=>({label:el.getAttribute('aria-label'),rect:el.getBoundingClientRect().toJSON()})),exclusionMasks:[]}));
 await fs.writeFile(`${artifacts}/trust-${name}.json`,JSON.stringify({capturedAt:new Date().toISOString(),browser:browser.version(),viewport:page.viewportSize(),state},null,2)+'\n');
};
const ready=async page=>{await page.goto(base);await page.locator('.session-header-title button').waitFor();await settle(page);};
const openManager=async page=>{await entry(page).click();await manager(page).waitFor();await manager(page).getByText('当前项目',{exact:true}).waitFor();};
const settings=async page=>{await page.locator('.sidebar-settings').click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();};
const noDispatch=controls=>assert.equal(controls.submissions.length+controls.followUps.length+controls.steers.length+controls.policySelections.length,0);
async function setup(state=allowed){
 const {page,controls}=await fixture(2,{locale:'zh-CN',timezoneId:'UTC',deviceScaleFactor:1,reducedMotion:'reduce'});page.setDefaultTimeout(6_000);
 controls.trustStates={A:{...state},B:{...allowed,root:'/mock/project-b','matched-root':'/mock/project-b'}};
 const h={reads:[],writes:[],readGates:[],writeGates:[],failRead:false,failWrite:false,dropWrite:false};
 await page.route('**/api/sessions/*/rpc',async route=>{
  const call=route.request().postDataJSON(),id=new URL(route.request().url()).pathname.split('/')[3];
  const read=call.method==='trust.status',write=call.method==='command.execute'&&/^\/trust (allow|deny)$/.test(call.params.command);
  if(!read&&!write){await route.fallback();return;}
  if(read){
   h.reads.push(id);const value=structuredClone(controls.trustStates[id]);
   if(h.failRead){h.failRead=false;await route.fulfill({status:503,json:{ok:false,error:{message:'Fixture trust read failed'}}});return;}
   const index=h.readGates.findIndex(g=>g.id===id);const held=index<0?null:h.readGates.splice(index,1)[0];
   if(held){held.seen.resolve();await held.release.promise;}
   await route.fulfill({json:{ok:true,result:value}});held?.done.resolve();return;
  }
  h.writes.push({id,...call});
  if(h.failWrite){h.failWrite=false;await route.fulfill({status:503,json:{ok:false,error:{message:'Fixture trust write failed'}}});return;}
  const decision=call.params.command.split(' ')[1],before=controls.trustStates[id];
  controls.trustStates[id]={...before,decision,'explicit?':true,'matched-root':before.root};
  const index=h.writeGates.findIndex(g=>g.id===id);const held=index<0?null:h.writeGates.splice(index,1)[0];
  if(held){held.seen.resolve();await held.release.promise;}
  if(h.dropWrite===true||h.dropWrite===call.commandId){h.dropWrite=false;await route.abort();held?.done.resolve();return;}
  await route.fulfill({json:{ok:true,result:{output:'Fixture trust saved'}}});held?.done.resolve();
 });
 return {page,controls,h};
}
const reviewCase=process.env.QI_AGENT_TRUST_REVIEW_CASE;
try{
 if(!reviewCase){
 {
  const {page,controls,h}=await setup();await ready(page);await shot(page,'trusted-1440');
  assert.equal(await entry(page).count(),1,'trusted projects must expose a trust review and revocation entry');
  assert.match(await page.locator('.composer-trust').innerText(),/项目已信任/);
  await input(page).fill('管理信任不应发送的草稿');await settings(page);await shot(page,'settings-1440');await settingsEntry(page).click();
  await manager(page).getByText('/mock/project-a',{exact:true}).waitFor();await shot(page,'manage-trusted-1440');
  assert.equal(await manager(page).getByRole('button',{name:'返回',exact:true}).evaluate(el=>el===document.activeElement),true,'safe return action gets initial focus');
  await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();
  assert.equal(await settingsEntry(page).evaluate(el=>el===document.activeElement),true,'return restores the settings opener');
  await page.keyboard.press('Escape');assert.equal(await input(page).inputValue(),'管理信任不应发送的草稿');assert.equal(h.writes.length,0);noDispatch(controls);
  await entry(page).focus();await page.keyboard.press('Enter');await manager(page).getByText('/mock/project-a',{exact:true}).waitFor();
  const held=gate('A');h.writeGates.push(held);
  await manager(page).getByRole('button',{name:'撤销信任',exact:true}).evaluate(button=>{button.click();button.click();});await held.seen.promise;
  assert.equal(h.writes.length,1);assert.ok(h.writes[0].commandId.startsWith('web-'));await shot(page,'saving-1440');
  assert.equal(await manager(page).getByRole('button',{name:'正在确认…',exact:true}).isDisabled(),true);await page.keyboard.press('Escape');assert.equal(await manager(page).count(),1);
  held.release.resolve();await held.done.promise;await manager(page).waitFor({state:'hidden'});assert.match(await page.locator('.composer-trust').innerText(),/项目受限/);
  await page.reload();await page.locator('.session-header-title button').waitFor();assert.match(await page.locator('.composer-trust').innerText(),/项目受限/);assert.equal(await initial(page).count(),0);
  await openManager(page);await shot(page,'restricted-1440');await manager(page).getByRole('button',{name:'信任项目',exact:true}).click();await manager(page).waitFor({state:'hidden'});
  assert.deepEqual(h.writes.map(write=>write.params.command),['/trust deny','/trust allow']);noDispatch(controls);
  await page.close();console.log(JSON.stringify({trustManagement:'passed',cases:['trusted entry','scope and safe initial focus','settings return focus','draft preserved','one command_id for double click','saving cannot dismiss','revoke via existing deny','refresh persistence','re-trust without dispatch']}));
 }
 {
  const {page,controls,h}=await setup(undecided);await ready(page);await initial(page).waitFor();await shot(page,'first-entry-1440');
  assert.match(await initial(page).innerText(),/尚未运行任务/);await initial(page).getByRole('button',{name:'取消',exact:true}).click();noDispatch(controls);assert.equal(h.writes.length,0);
  await input(page).fill('受限模式中的草稿');await input(page).press('Enter');await initial(page).waitFor();assert.match(await initial(page).innerText(),/取消会保留草稿/);
  await page.keyboard.press('Escape');assert.equal(await input(page).inputValue(),'受限模式中的草稿');assert.equal(h.writes.length,0);noDispatch(controls);
  await input(page).press('Enter');await initial(page).getByRole('button',{name:'保持受限',exact:true}).click();await initial(page).waitFor({state:'hidden'});
  assert.equal(controls.trustStates.A.decision,'deny');assert.equal(controls.trustStates.A['explicit?'],true);assert.equal(controls.submissions.length,1,'the original explicit send continues under restricted mode');
  assert.equal(h.writes[0].params.command,'/trust deny');await page.close();console.log(JSON.stringify({trustFirstEntry:'passed',cases:['first entry before dispatch','cancel does not save','send cancel preserves draft','deny persists','only requested send continues']}));
 }
 {
  const {page,controls,h}=await setup();await ready(page);
  h.failRead=true;await entry(page).click();await manager(page).getByRole('alert').filter({hasText:'Fixture trust read failed'}).waitFor();await shot(page,'read-error-1440');
  assert.equal(await manager(page).getByRole('button',{name:'撤销信任',exact:true}).count(),0);await manager(page).getByRole('button',{name:'重新读取',exact:true}).click();await manager(page).getByText('当前项目',{exact:true}).waitFor();
  h.failWrite=true;await manager(page).getByRole('button',{name:'撤销信任',exact:true}).click();await manager(page).getByRole('alert').filter({hasText:'Fixture trust write failed'}).waitFor();await shot(page,'write-error-1440');assert.equal(controls.trustStates.A.decision,'allow');
  // An external change must be reviewed again, not silently overwritten by the old choice.
  controls.trustStates.A={...restricted,'matched-root':'/mock',root:'/mock/project-a'};
  await manager(page).getByRole('button',{name:'撤销信任',exact:true}).click();await manager(page).getByRole('alert').filter({hasText:'项目信任状态已变化'}).waitFor();assert.equal(h.writes.length,1);await shot(page,'changed-review-1440');
  h.dropWrite=true;await manager(page).getByRole('button',{name:'信任项目',exact:true}).click();await manager(page).getByRole('alert').filter({hasText:'操作结果尚未确认'}).waitFor();assert.equal(h.writes.length,2);
  controls.operationStatus='pending';await manager(page).getByRole('button',{name:'信任项目',exact:true}).click();await manager(page).getByRole('alert').filter({hasText:'上次确认的结果尚不明确'}).waitFor();assert.equal(h.writes.length,2);
  controls.operationStatus='completed';await manager(page).getByRole('button',{name:'信任项目',exact:true}).click();await manager(page).waitFor({state:'hidden'});assert.equal(h.writes.length,2,'lost response reconciliation must not write twice');noDispatch(controls);
  controls.trustStates.A={configured:true,decision:'allow'};await entry(page).click();await manager(page).getByRole('alert').filter({hasText:'无法确认项目的信任状态'}).waitFor();assert.equal(await manager(page).getByRole('button',{name:'撤销信任',exact:true}).count(),0);await page.keyboard.press('Escape');
  await page.close();console.log(JSON.stringify({trustRecovery:'passed',cases:['read error with retry','definitive save failure','changed state requires re-review','unknown does not retry','completed receipt reconciles without new ID','malformed trust cannot mutate']}));
 }
 {
  const {page,controls,h}=await setup();await ready(page);const old=gate('A');h.readGates.push(old);await entry(page).click();await old.seen.promise;
  await manager(page).getByRole('status').filter({hasText:'正在核对'}).waitFor();await shot(page,'loading-1440');await page.keyboard.press('Escape');
  await page.locator('.session-link').filter({hasText:'会话B'}).click();await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();
  const newer=gate('B');h.readGates.push(newer);await entry(page).click();await newer.seen.promise;old.release.resolve();await old.done.promise;await settle(page);
  assert.equal(await manager(page).getByRole('status').filter({hasText:'正在核对'}).count(),1,'late old read must not end new request loading');assert.equal(await manager(page).getByText('/mock/project-a',{exact:true}).count(),0);
  newer.release.resolve();await newer.done.promise;await manager(page).getByText('/mock/project-b',{exact:true}).waitFor();await page.keyboard.press('Escape');
  // Navigate A -> B -> A while A's write response is late. The old completion must not unlock a new write.
  await page.locator('.session-link').filter({hasText:'会话A'}).click();await page.locator('.session-header-title button').filter({hasText:'会话A'}).waitFor();await openManager(page);
  const write=gate('A');h.writeGates.push(write);await manager(page).getByRole('button',{name:'撤销信任',exact:true}).click();await write.seen.promise;
  await page.goBack();await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();assert.equal(await manager(page).count(),0);
  await page.goForward();await page.locator('.session-header-title button').filter({hasText:'会话A'}).waitFor();await openManager(page);
  const second=gate('A');h.writeGates.push(second);
  // The old write is already recorded in the store, but its receipt is still unknown to this tab.
  controls.operationStatus='pending';await manager(page).getByRole('button',{name:'信任项目',exact:true}).click();await manager(page).getByRole('alert').filter({hasText:'上次确认的结果尚不明确'}).waitFor();assert.equal(h.writes.length,1);
  write.release.resolve();await write.done.promise;await settle(page);assert.equal(await manager(page).count(),1,'late old completion cannot close a newly opened review');
  await manager(page).getByRole('button',{name:'信任项目',exact:true}).click();await second.seen.promise;
  await manager(page).getByRole('button',{name:'正在确认…',exact:true}).evaluate(button=>button.click());assert.equal(h.writes.length,2,'new write remains locked after old completion');
  second.release.resolve();await second.done.promise;await manager(page).waitFor({state:'hidden'});noDispatch(controls);await page.close();
  console.log(JSON.stringify({trustNavigationRaces:'passed',cases:['cancel read','late A read while B loads','browser back during write','return same session with new review','unknown old write blocks new choice','old completion cannot dismiss new review','new writer retains its lock']}));
 }
 {
  const {page,controls,h}=await setup({...allowed,root:'/mock/非常长的项目目录/'.repeat(5)+'child','matched-root':'/mock/parent'});
  controls.workspaces=[{id:workspaceId,name:'项目 A',path:'/mock/project-a',addedAt:'2026-10-02'},{id:'abcdef1234567890',name:'项目 B',path:'/mock/project-b',addedAt:'2026-10-02'}];
  controls.sessions=[sessions[0],{...sessions[1],workspaceId:'abcdef1234567890'}];await ready(page);await openManager(page);assert.match(await manager(page).innerText(),/继承自父目录/);await shot(page,'inherited-1440');
  for(const width of [390,320]){
   await page.setViewportSize({width,height:844});await settle(page);await shot(page,`inherited-${width}`);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'essential path must wrap without horizontal page overflow');
   const rect=await manager(page).boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=width);
   for(const button of await manager(page).getByRole('button').all())assert.ok((await button.boundingBox()).height>=44,'trust actions retain 44px touch targets');
   assert.equal(await page.locator('#root').evaluate(el=>el.inert),true);
  }
  await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('combobox',{name:'工作区',exact:true}).selectOption('abcdef1234567890');await page.locator('.session-link').filter({hasText:'会话B'}).click();await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();
  await openManager(page);await manager(page).getByText('/mock/project-b',{exact:true}).waitFor();assert.equal(await manager(page).getByText('/mock/parent',{exact:true}).count(),0);noDispatch(controls);assert.equal(h.writes.length,0);
  await page.close();console.log(JSON.stringify({trustResponsiveAndProjects:'passed',cases:['inherited scope','full long paths','390px and 320px bounds','44px actions','modal inertness','switch actual workspace and session']}));
 }
 {
  const {page,controls,h}=await setup({...allowed,mutable:false,source:'profile-compatibility'});await ready(page);await openManager(page);await manager(page).getByText('当前配置固定了信任状态，无法在这里修改。',{exact:true}).waitFor();assert.equal(await manager(page).getByRole('button',{name:'撤销信任',exact:true}).count(),0);await shot(page,'fixed-profile-1440');await page.keyboard.press('Escape');
  controls.trustStates.A={configured:false};await page.reload();await page.locator('.session-header-title button').waitFor();assert.equal(await page.locator('.composer-trust').count(),0);await settings(page);await settingsEntry(page).click();await manager(page).getByText('当前运行配置未提供项目信任管理。请以实际会话权限和审批要求为准。',{exact:true}).waitFor();await shot(page,'unavailable-1440');assert.equal(h.writes.length,0);noDispatch(controls);await page.close();
  console.log(JSON.stringify({trustCapabilityBoundaries:'passed',cases:['fixed profile is read only','absent capability not invented','no trust writes or dispatch']}));
 }
 }
 if(!reviewCase||reviewCase==='completed-choice'){
  const {page,controls,h}=await setup(restricted);await ready(page);await openManager(page);
  h.dropWrite=true;await manager(page).getByRole('button',{name:'信任项目',exact:true}).click();await manager(page).getByRole('alert').filter({hasText:'操作结果尚未确认'}).waitFor();
  controls.trustStates.A={...restricted,'matched-root':'/mock'};controls.operationStatus='completed';
  await manager(page).getByRole('button',{name:'信任项目',exact:true}).click();await settle(page);
  assert.equal(h.writes.length,1,'a completed old choice must not overwrite a later external revocation');
  await manager(page).getByRole('alert').filter({hasText:'项目信任状态已变化'}).waitFor();await shot(page,'completed-choice-changed-1440');
  assert.equal(controls.trustStates.A.decision,'deny');await page.keyboard.press('Escape');noDispatch(controls);await page.close();
  console.log(JSON.stringify({trustCompletedChoiceChanged:'passed'}));
 }
 if(!reviewCase||reviewCase==='late-journal'){
  const {page,controls,h}=await setup();await ready(page);
  await page.locator('.session-link').filter({hasText:'会话B'}).click();await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();
  await page.locator('.session-link').filter({hasText:'会话A'}).click();await page.locator('.session-header-title button').filter({hasText:'会话A'}).waitFor();await openManager(page);
  const old=gate('A');h.writeGates.push(old);await manager(page).getByRole('button',{name:'撤销信任',exact:true}).click();await old.seen.promise;
  await page.goBack();await page.locator('.session-header-title button').filter({hasText:'会话B'}).waitFor();await page.goForward();await page.locator('.session-header-title button').filter({hasText:'会话A'}).waitFor();await openManager(page);
  controls.operationStatus='completed';const newer=gate('A');h.writeGates.push(newer);await manager(page).getByRole('button',{name:'信任项目',exact:true}).click();await newer.seen.promise;
  const newId=h.writes[1].commandId;h.dropWrite=newId;old.release.resolve();await old.done.promise;await settle(page);
  assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qi-agent.pending-operation:A'))?.commandId),newId,'late original HTTP response must not erase newer journal in the real browser');
  newer.release.resolve();await newer.done.promise;await manager(page).getByRole('alert').filter({hasText:'操作结果尚未确认'}).waitFor();
  assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('qi-agent.pending-operation:A'))?.commandId),newId);
  await manager(page).getByRole('button',{name:'信任项目',exact:true}).click();await manager(page).waitFor({state:'hidden'});assert.equal(h.writes.length,2);noDispatch(controls);await page.close();console.log(JSON.stringify({trustLateJournal:'passed'}));
 }
 if(!reviewCase||reviewCase==='retry-focus'){
  const {page,h}=await setup();await ready(page);h.failRead=true;await entry(page).click();await manager(page).getByRole('alert').waitFor();
  const held=gate('A');h.readGates.push(held);await manager(page).getByRole('button',{name:'重新读取',exact:true}).click();await held.seen.promise;
  assert.equal(await manager(page).evaluate(el=>el.contains(document.activeElement)),true,'removed retry button must leave focus on a stable modal control');
  await page.keyboard.press('Tab');assert.equal(await manager(page).evaluate(el=>el.contains(document.activeElement)),true);
  held.release.resolve();await held.done.promise;await manager(page).getByText('/mock/project-a',{exact:true}).waitFor();
  assert.equal(await manager(page).evaluate(el=>el.contains(document.activeElement)),true);await page.keyboard.press('Escape');await manager(page).waitFor({state:'hidden'});await page.close();console.log(JSON.stringify({trustReadRetryFocus:'passed'}));
 }
 if(!reviewCase||reviewCase==='saving-focus'){
  const {page,h}=await setup();await ready(page);await openManager(page);const held=gate('A');h.writeGates.push(held);
  const choice=manager(page).getByRole('button',{name:'撤销信任',exact:true});await choice.click();await held.seen.promise;
  for(const key of ['Tab','Shift+Tab','Tab']){
   await page.keyboard.press(key);assert.equal(await manager(page).evaluate(el=>el.contains(document.activeElement)),true,'saving must keep keyboard focus inside the modal');
  }
  await shot(page,'saving-focus-1440');held.release.resolve();await held.done.promise;await manager(page).waitFor({state:'hidden'});await page.close();
  const failed=await setup();await ready(failed.page);await openManager(failed.page);failed.h.failWrite=true;
  await manager(failed.page).getByRole('button',{name:'撤销信任',exact:true}).click();await manager(failed.page).getByRole('alert').waitFor();
  assert.equal(await manager(failed.page).getByRole('button',{name:'撤销信任',exact:true}).evaluate(el=>el===document.activeElement),true,'failure restores the explicit choice focus');await failed.page.close();
  console.log(JSON.stringify({trustSavingFocus:'passed'}));
 }
 if(!reviewCase||reviewCase==='generic-reconcile'){
  const {page,controls,h}=await setup();await ready(page);await openManager(page);h.dropWrite=true;
  await manager(page).getByRole('button',{name:'撤销信任',exact:true}).click();await manager(page).getByRole('alert').filter({hasText:'操作结果尚未确认'}).waitFor();await manager(page).getByRole('button',{name:'返回',exact:true}).click();await manager(page).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'核对结果',exact:true}).click();await page.getByRole('button',{name:'核对结果',exact:true}).waitFor({state:'hidden'});await settle(page);
  assert.match(await page.locator('.composer-trust').innerText(),/项目受限/,'generic reconciliation must show the actual completed trust status');
  assert.equal(h.writes.length,1);noDispatch(controls);await shot(page,'generic-reconciled-1440');await page.close();console.log(JSON.stringify({trustGenericReconcile:'passed'}));
 }
 if(!reviewCase){
  const {page,controls,h}=await setup();await page.addInitScript(()=>{localStorage.setItem('qi-agent.theme','dark');localStorage.setItem('qi-agent.web-preferences.v1',JSON.stringify({locale:'en'}));});await ready(page);
  await page.locator('.composer-trust button').click();const translated=page.getByRole('dialog',{name:'Project trust',exact:true});await translated.getByText('/mock/project-a',{exact:true}).waitFor();
  assert.match(await translated.innerText(),/Tools still follow session permissions/);assert.equal(await page.locator('body').getAttribute('data-theme'),'dark');await shot(page,'english-dark-1440');
  await page.setViewportSize({width:390,height:844});await shot(page,'english-dark-390');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await translated.getByRole('button',{name:'Back',exact:true}).click();noDispatch(controls);assert.equal(h.writes.length,0);await page.close();console.log(JSON.stringify({trustEnglishDark:'passed'}));
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({projectTrust:'passed',pageErrors:errors}));
}catch(error){for(const context of browser.contexts())for(const page of context.pages())await shot(page,`failure-${Date.now()}`).catch(()=>{});throw error;}
finally{await browser.close();}
