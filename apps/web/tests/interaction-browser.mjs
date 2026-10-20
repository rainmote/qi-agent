import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browser, base, errors, fixture, snapshot, settle, gate } from './browser-fixture.mjs';
const key='qi-agent.web-preferences.v1', artifacts=process.env.QI_AGENT_BROWSER_ARTIFACTS;
const shot=async(page,name)=>{
 if(!artifacts)return;await fs.mkdir(artifacts,{recursive:true});await settle(page);
 await page.screenshot({path:`${artifacts}/interaction-${name}.png`,animations:'disabled',fullPage:true});
 const state=await page.evaluate(()=>({dpr:devicePixelRatio,locale:document.documentElement.lang,theme:document.body.dataset.theme,bodyFont:getComputedStyle(document.body).fontFamily,
  dialogs:[...document.querySelectorAll('[role="dialog"]')].map(el=>({label:el.getAttribute('aria-label'),rect:el.getBoundingClientRect().toJSON()})),
  active:document.activeElement?.getAttribute('aria-label'),exclusionMasks:[]}));
 await fs.writeFile(`${artifacts}/interaction-${name}.json`,JSON.stringify({capturedAt:new Date().toISOString(),browser:browser.version(),viewport:page.viewportSize(),state},null,2)+'\n');
};
const settings=async(page)=>{await page.locator('.sidebar-settings').click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();};
const ref=page=>page.getByRole('dialog',{name:'快捷键',exact:true});
const edit=async(page,label)=>{await page.getByRole('button',{name:`修改${label}快捷键`,exact:true}).click();return page.getByRole('button',{name:`录制快捷键：${label}`,exact:true});};
const accepted=page=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
try {
 {
  const {page,controls}=await fixture();await page.goto(base);await page.locator('.session-header-title button').waitFor();
  await settings(page);await shot(page,'settings-1440');
  await page.getByRole('button',{name:'编辑快捷键',exact:true}).click();await ref(page).waitFor();
  assert.equal(await page.getByRole('searchbox',{name:'搜索快捷键',exact:true}).count(),1,'green counterpart of the baseline missing-search failure');
  assert.equal(await page.locator('.shortcut-binding').count(),11);
  for(const group of ['消息输入','菜单与弹层','审批区域'])assert.equal(await page.getByRole('region',{name:group,exact:true}).count(),1);
  await shot(page,'shortcuts-1440');const search=page.getByRole('searchbox',{name:'搜索快捷键',exact:true});
  await search.fill('workspace');assert.equal(await page.locator('.shortcut-binding').count(),1);await shot(page,'search-1440');
  await search.fill('no-match-fixture');await page.getByRole('status').filter({hasText:'没有匹配的快捷键'}).waitFor();await shot(page,'search-empty-1440');await search.fill('');
  let record=await edit(page,'文件与变更');await shot(page,'editor-1440');
  await search.fill('f');await settle(page);assert.equal(await search.evaluate(el=>el===document.activeElement),true,'search keeps focus when it closes a matching editor');
  await search.fill('');record=await edit(page,'文件与变更');
  const before=await accepted(page);await record.dispatchEvent('keydown',{key:'g',code:'KeyG',altKey:true,shiftKey:true});
  assert.deepEqual((await accepted(page))?.shortcuts?.files,before?.shortcuts?.files,'key down alone must not save');
  await record.dispatchEvent('keydown',{key:'g',code:'KeyG',altKey:true,shiftKey:true,repeat:true});
  await record.dispatchEvent('keyup',{key:'g',code:'KeyG',altKey:true,shiftKey:true});
  assert.equal((await accepted(page)).shortcuts.files.code,'KeyG','held key repeat does not discard the pending combination');
  assert.equal(await page.getByRole('button',{name:'修改文件与变更快捷键',exact:true}).evaluate(el=>el===document.activeElement),true);
  record=await edit(page,'文件与变更');await record.press('Tab');assert.equal(await record.getAttribute('aria-pressed'),'false');
  await page.getByRole('button',{name:'返回',exact:true}).click();
  record=await edit(page,'文件与变更');await record.dispatchEvent('keydown',{key:'h',code:'KeyH',altKey:true,shiftKey:true,isComposing:true});
  await record.dispatchEvent('keyup',{key:'h',code:'KeyH',altKey:true,shiftKey:true});assert.equal((await accepted(page)).shortcuts.files.code,'KeyG');
  await record.dispatchEvent('keydown',{key:'Dead',code:'Quote',altKey:true});await record.press('Escape');
  assert.equal(await record.getAttribute('aria-pressed'),'false');await page.keyboard.press('Escape');assert.equal(await page.locator('.shortcut-inline-editor').count(),0);
  await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'编辑快捷键',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Meta+Slash');await ref(page).waitFor();await page.keyboard.press('Meta+Slash');await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭设置',exact:true}).click();await page.keyboard.press('Meta+Slash');await ref(page).waitFor();await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+Shift+KeyG');await page.getByRole('complementary',{name:'工作区文件',exact:true}).waitFor();await page.getByRole('button',{name:'关闭文件面板',exact:true}).click();
  await page.keyboard.press('Meta+Slash');record=await edit(page,'文件与变更');
  await page.evaluate(key=>{window.originalPreferenceWrite=Storage.prototype.setItem;Storage.prototype.setItem=function(name,value){if(name===key)throw new DOMException('fixture quota','QuotaExceededError');return window.originalPreferenceWrite.call(this,name,value);};},key);
  await record.press('Alt+Shift+KeyH');await page.getByRole('alert').filter({hasText:'无法保存快捷键'}).waitFor();
  assert.equal((await accepted(page)).shortcuts.files.code,'KeyG');assert.match(await record.innerText(),/H/);await shot(page,'save-error-1440');
  await page.evaluate(()=>{Storage.prototype.setItem=window.originalPreferenceWrite;delete window.originalPreferenceWrite;});await page.getByRole('button',{name:'重试保存',exact:true}).click();assert.equal((await accepted(page)).shortcuts.files.code,'KeyH');
  record=await edit(page,'文件与变更');
  await page.evaluate(key=>{const next=JSON.parse(localStorage.getItem(key));next.shortcuts.files=null;next.shortcutsRevision++;localStorage.setItem(key,JSON.stringify(next));window.dispatchEvent(new StorageEvent('storage',{key,newValue:JSON.stringify(next)}));},key);
  await record.press('Alt+Shift+KeyG');await page.getByRole('alert').filter({hasText:'快捷键配置已变化'}).waitFor();assert.equal((await accepted(page)).shortcuts.files,null);await shot(page,'stale-review-1440');
  await page.getByRole('button',{name:'我已查看最新配置',exact:true}).click();await record.click();await record.press('Alt+Shift+KeyG');assert.equal((await accepted(page)).shortcuts.files.code,'KeyG');
  await page.getByRole('button',{name:'恢复默认快捷键',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await accepted(page)).shortcuts.files.code,'KeyG');
  await page.getByRole('button',{name:'恢复默认快捷键',exact:true}).click();await shot(page,'reset-confirm-1440');await page.getByRole('region',{name:'恢复所有默认快捷键？',exact:true}).getByRole('button',{name:'恢复默认快捷键',exact:true}).click();assert.equal((await accepted(page)).shortcuts.files.code,'KeyF');
  assert.equal(await search.evaluate(el=>el===document.activeElement),true,'reset returns focus to a stable control, not its newly disabled button');
  // Exercise each newly exposed action through its actual global listener.
  for(const [label,code] of [['搜索会话','KeyK'],['添加工作区','KeyO'],['会话信息','KeyD'],['对话','KeyJ'],['轨迹','KeyT']]){record=await edit(page,label);await record.press(`Alt+Shift+${code}`);}
  await page.keyboard.press('Escape');await page.keyboard.press('Alt+Shift+KeyK');await page.getByRole('textbox',{name:'搜索会话',exact:true}).waitFor();
  await settle(page);assert.equal(await page.getByRole('textbox',{name:'搜索会话',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Alt+Shift+KeyO');await page.getByRole('dialog',{name:'添加工作区',exact:true}).waitFor();await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+Shift+KeyD');await page.getByRole('heading',{name:'会话日志',exact:true}).waitFor();await page.keyboard.press('Alt+Shift+KeyD');
  await page.keyboard.press('Alt+Shift+KeyT');assert.equal(await page.getByRole('tab',{name:'轨迹',exact:true}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('Alt+Shift+KeyJ');assert.equal(await page.getByRole('tab',{name:'对话',exact:true}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('Alt+Shift+KeyN');await page.locator('.new-session-view').waitFor();await page.keyboard.press('Meta+Slash');
  assert.equal(await page.getByRole('button',{name:'修改会话信息快捷键',exact:true}).locator('..').getByText('当前页面暂不可用',{exact:true}).count(),1);
  for(const width of [768,390,320]){await page.setViewportSize({width,height:844});await shot(page,`shortcuts-${width}`);assert.ok(await page.locator('.shortcut-reference-list').evaluate(el=>el.scrollWidth<=el.clientWidth));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const frame=await ref(page).boundingBox();assert.ok(frame.x>=12&&frame.x+frame.width<=width-12,`${width}px shortcut dialog must retain reachable, symmetric viewport margins`);
   if(width<=600){assert.equal(frame.x,12);assert.equal(frame.x+frame.width,width-12);}
   if(width<=600){const button=page.getByRole('button',{name:'修改文件与变更快捷键',exact:true});await button.scrollIntoViewIfNeeded();assert.ok((await button.boundingBox()).height>=44);}}
  await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:1000});await settings(page);await page.getByRole('button',{name:'深色',exact:true}).click();await page.getByRole('button',{name:'编辑快捷键',exact:true}).click();await shot(page,'shortcuts-dark-1440');await page.keyboard.press('Escape');
  assert.equal(controls.submissions.length+controls.followUps.length+controls.steers.length+controls.policySelections.length,0);
  assert.ok(!controls.rpcRequests.some(call=>['interaction.resolve','plugins.manage'].includes(call.method)));await page.close();
  console.log(JSON.stringify({shortcutReference:'passed',cases:['searchable 11-action catalog and scoped fixed help','release/repeat/IME/dead/Tab/Escape','focus return','save failure retained binding/draft and explicit retry','stale review','confirmed reset and cancel','actual navigation keys','1440/768/390/320 and dark','no approval or turn mutation']}));
 }
 {
  const {page,controls}=await fixture();const content=snapshot('A');content.events[1].data.message.content='[工作区文档](docs/guide.md) [外部网页](https://example.invalid) [逃逸链接](../outside.md)';controls.snapshotOverride=content;
  controls.runtimeStatus={plugins:[{id:'files',namespace:'qi.files',description:'读取文件'},{id:'shell',namespace:'qi.shell',description:'运行命令'}],tools:[{name:'read_file',description:'读取文件'},{name:'write_file',description:'写入文件'}],commands:[]};
  controls.filePreviews={'docs/guide.md':{path:'docs/guide.md',name:'guide.md',kind:'text',mime:'text/markdown',size:100,text:'# 文档原文\n[相邻文档](../note.md)'}};
  await page.goto(base);await page.locator('.session-header-title button').waitFor();
  const link=page.getByRole('link',{name:'工作区文档',exact:true});assert.match(await link.getAttribute('href'),/\/api\/workspaces\/1234567890abcdef\/content\?path=docs%2Fguide.md/);
  assert.equal(await page.getByRole('link',{name:'逃逸链接',exact:true}).count(),0);
  assert.equal(await page.getByRole('link',{name:'外部网页',exact:true}).getAttribute('target'),'_blank');
  const pendingPreview=gate('file');controls.holdPreview=pendingPreview;await link.click();
  console.log(JSON.stringify({filePreviewStart:{url:page.url(),drawer:await page.locator('.workspace-panel').count(),requests:controls.previewRequests||[]}}));
  try {
   await Promise.race([pendingPreview.seen.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('preview request was not issued within 5s')),5000))]);
   await page.locator('.workspace-file-list').waitFor();assert.equal(await page.getByRole('button',{name:'取消',exact:true}).count(),1,'completed directory listing must not hide the pending preview cancel action');await shot(page,'file-preview-loading-1440');
   await page.getByRole('button',{name:'取消',exact:true}).click();
  }finally{controls.holdPreview=null;pendingPreview.release.resolve();}
  await pendingPreview.done.promise;await settle(page);
  assert.equal(await page.getByText('文档原文',{exact:true}).count(),0,'cancelled preview cannot appear after its response arrives');
  await link.dblclick();await page.getByRole('complementary',{name:'工作区文件',exact:true}).waitFor();await page.getByText('文档原文',{exact:true}).waitFor();await shot(page,'file-link-panel-1440');
  await page.getByRole('link',{name:'相邻文档',exact:true}).click();await page.getByText('bounded file fixture',{exact:true}).waitFor();assert.equal(controls.previewRequests.at(-1),'note.md');
  await page.getByRole('button',{name:'返回文件',exact:true}).click();await page.locator('.workspace-file-list').waitFor();await page.getByRole('button',{name:'关闭文件面板',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await link.click();await page.getByText('文档原文',{exact:true}).waitFor();await shot(page,'file-link-panel-390');
  assert.equal(await page.locator('.main-panel').evaluate(el=>el.inert),true);await page.getByRole('button',{name:'关闭文件面板',exact:true}).click();assert.equal(await page.locator('.main-panel').evaluate(el=>el.inert),false);await page.setViewportSize({width:1440,height:1000});
  await settings(page);const nav=page.getByRole('navigation',{name:'设置分区',exact:true});await nav.getByRole('button',{name:'插件',exact:true}).focus();await page.keyboard.press('ArrowDown');assert.equal(await nav.getByRole('button',{name:'工具',exact:true}).evaluate(el=>el===document.activeElement),true);
  await nav.getByRole('button',{name:'工具',exact:true}).click();await page.getByRole('searchbox',{name:'搜索工具',exact:true}).fill('read_file');assert.equal(await page.locator('.settings-card').count(),1);await shot(page,'tools-filter-1440');
  await page.getByRole('searchbox',{name:'搜索工具',exact:true}).fill('none');await page.getByText('没有匹配的工具',{exact:true}).waitFor();
  await nav.getByRole('button',{name:'插件',exact:true}).click();await page.getByRole('searchbox',{name:'搜索插件',exact:true}).fill('qi.files');assert.equal(await page.locator('.settings-card').count(),1);await shot(page,'plugins-filter-1440');
  await page.getByRole('button',{name:'管理插件',exact:true}).click();await page.getByRole('region',{name:'插件管理',exact:true}).waitFor();await page.getByText('尚未安装插件包。',{exact:true}).waitFor();await page.getByRole('button',{name:'关闭工作台',exact:true}).click();
  await settings(page);await page.getByRole('button',{name:'文件链接打开方式',exact:true}).click();await page.getByRole('menuitemradio',{name:'新标签页',exact:true}).click();assert.equal((await accepted(page)).fileLinkOpening,'new-tab');await shot(page,'file-link-setting-1440');await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  const native=await link.evaluate(el=>{return {href:el.href,target:el.target,rel:el.rel};});assert.match(native.href,/docs%2Fguide.md/);assert.equal(native.target,'_blank');assert.match(native.rel,/noopener/);
  // Observe the decision without opening an extra tab or making an external request.
  assert.equal(await link.evaluate(el=>{let prevented;const listener=event=>{prevented=event.defaultPrevented;event.preventDefault();};document.addEventListener('click',listener,{once:true});el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0}));return prevented;}),false);
  assert.equal(await page.getByRole('complementary',{name:'工作区文件',exact:true}).count(),0);
  await page.reload();await page.locator('.session-header-title button').waitFor();assert.equal((await accepted(page)).fileLinkOpening,'new-tab');
  assert.equal(controls.submissions.length+controls.followUps.length+controls.steers.length+controls.policySelections.length,0);assert.ok(!controls.rpcRequests.some(call=>call.method==='plugins.manage'));
  await page.close();console.log(JSON.stringify({workspaceLinksAndSettings:'passed',cases:['workspace-scoped content URL','relative preview navigation','root escape blocked','external URLs unchanged','native new-tab preference and reload','plugin/tool search and empty states','settings nav keys','real manager entry without mutations']}));
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({interactionPageErrors:errors}));
}catch(error){for(const context of browser.contexts())for(const page of context.pages())await shot(page,`failure-${Date.now()}`).catch(()=>{});throw error;}finally{await browser.close();}
