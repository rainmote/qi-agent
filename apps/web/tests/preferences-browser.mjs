import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browser, base, errors, fixture, snapshot, settle, gate } from './browser-fixture.mjs';
const preferenceKey='qi-agent.web-preferences.v1';
const artifacts=process.env.QI_AGENT_BROWSER_ARTIFACTS;
const shot=async(page,name)=>{
 if(name.startsWith('general-'))await page.locator('.settings-content').evaluate(el=>el.scrollTop=0);
 if(!artifacts)return;await fs.mkdir(artifacts,{recursive:true});await page.screenshot({path:`${artifacts}/prefs-${name}.png`,fullPage:true,animations:'disabled'});
 const state=await page.evaluate(()=>({dpr:devicePixelRatio,locale:document.documentElement.lang,theme:document.body.dataset.theme,
  bodyFont:getComputedStyle(document.body).fontFamily,fontVariables:Object.fromEntries(['text','code','terminal'].map(role=>[role,getComputedStyle(document.body).getPropertyValue(`--qi-${role}-font`)])),
  settingsScroll:[...document.querySelectorAll('.settings-content')].map(el=>({scrollTop:el.scrollTop,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth})),
  exclusionMasks:[]}));
 await fs.writeFile(`${artifacts}/prefs-${name}.json`,JSON.stringify({capturedAt:new Date().toISOString(),browser:browser.version(),viewport:page.viewportSize(),state},null,2)+'\n');
};
const settings=async page=>{await page.locator('.sidebar-settings').click();await page.getByRole('menuitem',{name:/^(设置|Settings)$/}).click();await page.getByRole('dialog',{name:/^(设置|Settings)$/}).waitFor();};
const dispatch=async(page,events)=>{await page.evaluate(events=>{const source=window.sources.findLast(source=>!source.closed);for(const event of events)source.dispatchEvent(new MessageEvent('worker',{data:JSON.stringify(event)}));},events);await settle(page);};
const phase=(value,revision)=>[{type:'event',event:'agent/state',data:{phase:value,revision}}];
const waitCount=async(array,count)=>{for(let i=0;i<50&&array.length<count;i++)await new Promise(r=>setTimeout(r,20));assert.equal(array.length,count);};
try {
 {
  const {page,controls}=await fixture();
  const content=snapshot('A');content.events[1].data.message.content='模型原文：等待批准\n```js\nconst value = 1;\n```';
  content.events.push({id:'font-call',seq:3,at:'2026-10-02T01:00:01Z',type:'tool/call',data:{name:'bash','call-id':'font-bash',arguments:{command:'echo 原文'}}},
   {id:'font-result',seq:4,at:'2026-10-02T01:00:02Z',type:'tool/result',data:{'call-id':'font-bash',ok:true,content:'原始命令输出'}});content.cursor.sequence=4;controls.snapshotOverride=content;
  await page.goto(base);await page.locator('.session-header-title button').waitFor();
  await settings(page);await shot(page,'general-zh-1440');
  const code=page.getByRole('switch',{name:'显示代码工作视图',exact:true});
  assert.equal(await code.getAttribute('aria-checked'),'true');await code.click();
  await page.getByRole('button',{name:'更多字体设置',exact:true}).click();
  for(const [label,value]of [['正文字体','Arial, sans-serif'],['代码字体','Courier New, monospace'],['终端输出字体','Menlo, monospace']]){
   const field=page.getByRole('textbox',{name:label,exact:true});await field.fill(value);await field.press('Enter');
  }
  const codeSize=page.getByRole('spinbutton',{name:'代码字号',exact:true});await codeSize.fill('16');await codeSize.blur();
  const terminalSize=page.getByRole('spinbutton',{name:'终端输出字号',exact:true});await terminalSize.fill('19');await terminalSize.blur();
  const font=page.getByRole('textbox',{name:'代码字体',exact:true});await font.fill('Arial; color:red');await font.press('Enter');
  await page.getByRole('alert').filter({hasText:'字体名称格式无效'}).waitFor();assert.equal(await font.inputValue(),'Courier New, monospace');
  await codeSize.fill('99');await codeSize.blur();assert.equal(await codeSize.inputValue(),'16');
  await shot(page,'font-roles-zh-1440');await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  assert.equal(await page.getByRole('tab',{name:'轨迹',exact:true}).count(),0);
  assert.match(await page.locator('body').evaluate(el=>getComputedStyle(el).fontFamily),/Arial/);
  const codeBlock=page.locator('.markdown-content pre code');assert.match(await codeBlock.evaluate(el=>getComputedStyle(el).fontFamily),/Courier New/);assert.equal(await codeBlock.evaluate(el=>getComputedStyle(el).fontSize),'16px');
  await page.locator('.tool-summary').click();await page.locator('.tool-batch-row').click();const output=page.locator('.tool-details > div:nth-child(2) > pre');await output.waitFor();assert.equal(await output.innerText(),'原始命令输出');assert.match(await output.evaluate(el=>getComputedStyle(el).fontFamily),/Menlo/);assert.equal(await output.evaluate(el=>getComputedStyle(el).fontSize),'19px');await shot(page,'fonts-applied-1440');
  await page.keyboard.press('Alt+Shift+KeyF');await page.getByRole('complementary',{name:'工作区文件',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'本轮变更',exact:true}).count(),0);
  await page.getByRole('button',{name:'关闭文件面板',exact:true}).click();
  await settings(page);await page.getByRole('button',{name:'编辑快捷键',exact:true}).click();
  await page.getByRole('dialog',{name:'快捷键',exact:true}).waitFor();
  await page.getByRole('button',{name:'修改文件与变更快捷键',exact:true}).click();
  const record=page.getByRole('button',{name:'录制快捷键：文件与变更',exact:true});
  await record.press('Alt+Shift+KeyB');
  await page.getByRole('alert').filter({hasText:'此组合已绑定其他操作'}).waitFor();
  await record.click();await record.dispatchEvent('keydown',{key:'l',code:'KeyL',metaKey:true});
  await page.getByRole('alert').filter({hasText:'此组合不可用'}).waitFor();await record.dispatchEvent('keydown',{key:'a',code:'KeyA',metaKey:true});assert.equal(await record.getAttribute('aria-pressed'),'true');
  await record.dispatchEvent('keydown',{key:'g',code:'KeyG',altKey:true,shiftKey:true,isComposing:true});
  assert.equal(await record.getAttribute('aria-pressed'),'true');
  await record.press('Escape');assert.equal(await record.getAttribute('aria-pressed'),'false');
  assert.equal(await page.getByRole('dialog',{name:'快捷键',exact:true}).count(),1);
  await record.click();await record.press('Alt+Shift+KeyG');
  assert.match(await page.getByRole('button',{name:'修改文件与变更快捷键',exact:true}).innerText(),/G/);
  await shot(page,'shortcut-editor-zh-1440');await page.keyboard.press('Escape');
  await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'编辑快捷键',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.getByRole('button',{name:'繁忙时的发送行为',exact:true}).click();await page.getByRole('menuitemradio',{name:'插话发送',exact:true}).click();
  await page.getByRole('button',{name:'语言：中文',exact:true}).click();await page.getByRole('menuitemradio',{name:'English',exact:true}).click();
  await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();await page.getByRole('switch',{name:'Show coding view',exact:true}).waitFor();
  await page.getByRole('button',{name:'Edit shortcuts',exact:true}).click();
  await page.getByRole('button',{name:'Edit shortcut: Files and changes',exact:true}).click();
  const englishRecord=page.getByRole('button',{name:'Record shortcut: Files and changes',exact:true});
  await englishRecord.dispatchEvent('keydown',{key:'a',code:'KeyA',metaKey:true});await page.getByRole('alert').filter({hasText:'This combination is unavailable'}).waitFor();
  await englishRecord.press('Escape');await page.getByRole('button',{name:'Back',exact:true}).click();await page.keyboard.press('Escape');
  await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  await shot(page,'general-en-1440');await page.getByRole('button',{name:'Close settings',exact:true}).click();
  await page.getByRole('textbox',{name:'Message the agent',exact:true}).waitFor();await page.getByText('模型原文：等待批准',{exact:true}).waitFor();assert.equal(await output.innerText(),'原始命令输出');
  await page.keyboard.press('Alt+Shift+KeyG');await page.getByRole('complementary',{name:'Workspace files',exact:true}).waitFor();
  await page.locator('.workspace-file-list').getByRole('button',{name:'note.md',exact:true}).click();
  await page.getByText('bounded file fixture',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Close files panel',exact:true}).click();
  await page.reload();await page.getByRole('textbox',{name:'Message the agent',exact:true}).waitFor();
  assert.equal(await page.getByRole('tab',{name:'Trajectory',exact:true}).count(),0);
  const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),preferenceKey);
  assert.equal(saved.busyEnter,'steer');assert.equal(saved.codeFontSize,16);assert.equal(saved.terminalFontSize,19);assert.equal(saved.shortcuts.files.code,'KeyG');assert.equal(saved.locale,'en');
  await page.keyboard.press('Alt+Shift+KeyG');await page.getByRole('button',{name:'Close files panel',exact:true}).click();const draft=page.getByRole('textbox',{name:'Message the agent',exact:true});await draft.fill('unsent draft');await draft.press('ControlOrMeta+A');assert.deepEqual(await draft.evaluate(el=>[el.selectionStart,el.selectionEnd]),[0,12],'native Select All remains available');assert.equal(await draft.inputValue(),'unsent draft');
  await settings(page);await page.getByRole('switch',{name:'Show coding view',exact:true}).click();
  await page.getByRole('button',{name:'Close settings',exact:true}).click();await page.getByRole('tab',{name:'Trajectory',exact:true}).waitFor();
  await page.setViewportSize({width:320,height:844});await settings(page);
  await page.getByRole('button',{name:'More font settings',exact:true}).click();await page.getByRole('textbox',{name:'Text font',exact:true}).waitFor();
  for(const field of await page.locator('.settings-font-row input').all()){await field.scrollIntoViewIfNeeded();const box=await field.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=320,'font field must remain reachable at 320px');assert.equal(await field.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el;}),true,'font input center must not be obscured by navigation');}
  assert.equal(await page.locator('.settings-content').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'settings content itself cannot hide horizontal overflow');await shot(page,'font-roles-en-320');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('button',{name:'Edit shortcuts',exact:true}).click();
  await page.getByRole('dialog',{name:'Keyboard shortcuts',exact:true}).waitFor();
  await page.getByRole('button',{name:'Edit shortcut: Files and changes',exact:true}).click();
  assert.equal(await page.locator('.shortcut-reference-list').evaluate(el=>el.scrollWidth<=el.clientWidth),true);await shot(page,'shortcut-editor-en-320');
  await page.getByRole('button',{name:'Clear',exact:true}).click();
  assert.match(await page.getByRole('button',{name:'Edit shortcut: Files and changes',exact:true}).innerText(),/Unbound/);
  await page.getByRole('button',{name:'Restore default shortcuts',exact:true}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.match(await page.getByRole('button',{name:'Edit shortcut: Files and changes',exact:true}).innerText(),/Unbound/);
  await page.getByRole('button',{name:'Restore default shortcuts',exact:true}).click();
  await page.getByRole('region',{name:'Restore all default shortcuts?',exact:true}).getByRole('button',{name:'Restore default shortcuts',exact:true}).click();
  assert.match(await page.getByRole('button',{name:'Edit shortcut: Files and changes',exact:true}).innerText(),/F/);
  assert.equal(controls.submissions.length,0);assert.equal(controls.followUps.length,0);assert.equal(controls.steers.length,0);assert.equal(controls.policySelections.length,0);
  await page.close();console.log(JSON.stringify({webPreferences:'passed',cases:['code view controls actual trajectory/diffs','fonts validated and applied','shortcuts duplicate/reserved/IME/Escape/remap/clear/reset','English actual interface','raw message/file unchanged','reload persistence','320px controls','no backend mutations']}));
 }
 {
  const {page}=await fixture();await page.goto(base);await page.locator('.session-header-title button').waitFor();await settings(page);
  await page.evaluate(key=>{window.preferenceOriginalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(name,value){if(name===key)throw new DOMException('Test quota exceeded','QuotaExceededError');return window.preferenceOriginalSet.call(this,name,value);};},preferenceKey);
  await page.getByRole('switch',{name:'显示代码工作视图',exact:true}).click();await page.getByRole('alert').filter({hasText:'当前浏览器未能保存偏好'}).waitFor();
  await page.getByRole('button',{name:'语言：中文',exact:true}).click();await page.getByRole('menuitemradio',{name:'English',exact:true}).click();await page.getByRole('alert').filter({hasText:'This browser could not save'}).waitFor();
  assert.equal(await page.getByRole('switch',{name:'Show coding view',exact:true}).getAttribute('aria-checked'),'false');await shot(page,'persistence-error-en');
  await page.evaluate(()=>{Storage.prototype.setItem=window.preferenceOriginalSet;delete window.preferenceOriginalSet;});await page.getByRole('switch',{name:'Show coding view',exact:true}).click();assert.equal(await page.getByRole('alert').count(),0);
  assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).locale,preferenceKey),'en');await page.close();console.log(JSON.stringify({preferencePersistenceFailure:'passed',cases:['memory updates with visible failure','error switches language','successful save clears warning and persists all current values']}));
 }
 for(const preferred of ['queue','steer']){
  const {page,controls}=await fixture();controls.snapshotOverride={...snapshot('A'),state:{phase:'model',revision:2}};
  await page.addInitScript(({key,preferred})=>{if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({busyEnter:preferred}));},{key:preferenceKey,preferred});
  await page.goto(base);const input=page.locator('textarea');await input.waitFor();await page.getByRole('button',{name:'停止运行',exact:true}).waitFor();
  for(const width of [1440,320]){
   await page.setViewportSize({width,height:844});await input.fill(`${preferred} ${width} Enter`);
   await input.dispatchEvent('keydown',{key:'Enter',isComposing:true});await input.press('Shift+Enter');
   assert.equal(controls.followUps.length+controls.steers.length, width===1440?0:3);
   assert.match(await input.inputValue(),/\n$/);await input.press('Enter');await waitCount(preferred==='queue'?controls.followUps:controls.steers,width===1440?1:3);
   await input.fill(`${preferred} ${width} complementary`);await input.press('Control+Enter');
   await waitCount(preferred==='queue'?controls.steers:controls.followUps,width===1440?1:2);
   await input.fill(`${preferred} ${width} button`);await shot(page,`busy-${preferred}-${width}`);
   await page.getByRole('button',{name:preferred==='queue'?'排队发送':'插话发送',exact:true}).dblclick();
   await waitCount(preferred==='queue'?controls.followUps:controls.steers,width===1440?2:4);
   assert.equal(controls.submissions.length,0);assert.equal(await page.getByRole('button',{name:'停止运行',exact:true}).count(),1);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'busy composer cannot overflow');
  }
  const sent=[...controls.followUps,...controls.steers];assert.equal(new Set(sent.map(r=>r.commandId)).size,sent.length,'each accepted intent has a distinct command_id');assert.ok(sent.every(r=>r.commandId));
  await dispatch(page,[{type:'event',event:'interaction/request',data:{id:'approval-fixture',title:'Fixture approval',message:'Original审批内容',items:[{value:'allow',label:'Allow'}]}}]);
  await page.getByLabel('待确认操作',{exact:true}).waitFor();await input.fill('blocked by approval');await input.press('Enter');await input.press('Control+Enter');await settle(page);
  assert.equal(controls.followUps.length+controls.steers.length,6);assert.equal(await page.locator('.busy-submit-button').count(),0);await shot(page,`approval-${preferred}-320`);
  await dispatch(page,[{type:'event',event:'interaction/resolved',data:{id:'approval-fixture'}}]);
  controls[preferred==='queue'?'dropFollowUp':'dropSteer']=true;await input.fill('uncertain running submission');await input.press('Enter');await page.getByRole('button',{name:'核对结果',exact:true}).waitFor();
  await input.fill('must not resend while unknown');await input.press('Enter');await input.press('Control+Enter');await settle(page);assert.equal(controls.followUps.length+controls.steers.length,7,'unknown busy submission blocks both modes');
  await page.getByRole('button',{name:'核对结果',exact:true}).click();await page.getByRole('button',{name:'核对结果',exact:true}).waitFor({state:'hidden'});assert.equal(controls.followUps.length+controls.steers.length,7,'reconcile completed receipt never resends');
  await dispatch(page,phase('model',4));const stop=gate('A');controls.holdAbort=stop;await page.getByRole('button',{name:'停止运行',exact:true}).click();await stop.seen.promise;
  try{await input.fill('cannot submit while stopping');await input.press('Enter');await input.press('Control+Enter');assert.equal(controls.followUps.length+controls.steers.length,7);assert.equal(await page.locator('.busy-submit-button').isDisabled(),true);await shot(page,`stopping-${preferred}-320`);}finally{stop.release.resolve();await stop.done.promise;}
  await page.close();
  const idle=await fixture();await idle.page.addInitScript(({key,preferred})=>localStorage.setItem(key,JSON.stringify({busyEnter:preferred})),{key:preferenceKey,preferred});await idle.page.goto(base);await idle.page.locator('textarea').fill('idle submission');await idle.page.locator('textarea').press('Meta+Enter');await waitCount(idle.controls.submissions,1);assert.equal(idle.controls.steers.length+idle.controls.followUps.length,0);await idle.page.close();
  console.log(JSON.stringify({busyPreference:'passed',preferred,cases:['Enter preference','Ctrl+Enter complementary','idle Cmd+Enter submits','visible send button double click once','IME/Shift+Enter','approval/stopping/unknown-result guards','reconcile without resend','command_id','1440/320 no page overflow']}));
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({preferencePageErrors:errors}));
} catch(error) {
 for(const context of browser.contexts())for(const page of context.pages())await shot(page,'failure').catch(()=>{});
 throw error;
} finally {await browser.close();}
