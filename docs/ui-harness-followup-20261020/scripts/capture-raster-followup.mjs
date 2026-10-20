// Uses only mocked API data. Start Vite, then run npm run test:web-browser.
// QI_AGENT_PLAYWRIGHT_MODULE can select an existing Playwright installation.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.QI_AGENT_PLAYWRIGHT_MODULE || '../qi-agent/node_modules/playwright/index.mjs');
const browser = await chromium.launch({headless:true,...(process.env.QI_AGENT_BROWSER_CHANNEL ? {channel:process.env.QI_AGENT_BROWSER_CHANNEL} : {})});
let base = process.env.QI_AGENT_WEB_TEST_URL || 'http://127.0.0.1:4179';
const errors=[];
const workspaceId='1234567890abcdef';
const sessions=['A','B'].map(id=>({id,workspaceId,path:`/mock/${id}.jsonl`,name:id==='A'?'Begin your reply with the':'Previous conversation',label:null,eventCount:2,messageCount:2,updatedAt:'2026-10-20T00:00:00Z',presetId:null}));
const policy={mode:'ask',modes:[{id:'deny',label:'Read Only'},{id:'ask',label:'Workspace Write'},{id:'allow',label:'Full Access'}]};
const models={current:{id:'mock-a',model:'DeepSeek-V4-Flash',provider:'DeepSeek'},providers:[{id:'mock-a',model:'DeepSeek-V4-Flash',provider:'DeepSeek'},{id:'mock-b',model:'DeepSeek-V4-Flash-Vision-Exp',provider:'DeepSeek'}]};
function snapshot(id,n=2){return {session_id:id,path:`/mock/${id}.jsonl`,cursor:{generation:1,sequence:n},events:Array.from({length:n},(_,i)=>({id:`${id}-${i}`,seq:i+1,at:'2026-10-02T01:00:00Z',type:'message',data:{message:{role:i%2?'assistant':'user',content:`${id}-controlled-message-${i}`}}})),state:{phase:'idle',revision:2},models,policy,interactions:[],interactions_revision:0};}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function fixture(initialCount=2){
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1,locale:'zh-CN',timezoneId:'UTC',colorScheme:'light',reducedMotion:'reduce'});
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.sources=[];window.EventSource=class extends EventTarget{constructor(url){super();this.url=url;window.sources.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){this.closed=true;}}});
 const controls={holdBootstrap:null,bootstrapOverride:null,failBootstrap:false,holdSnapshot:null,holdOpen:null,holdPolicy:null,holdModels:null,snapshotOverride:null,steers:[],modelCatalog:models,providerSaves:0,providerRetries:0,dropSubmit:false,rejectSubmit:false,uploads:[],submissions:[],operationStatus:"completed",preferenceEvents:{A:[],B:[]},rejectPreference:false,verification:undefined};
 const sessionSnapshot=(id,n=2)=>{const value=snapshot(id,n);value.events.push(...controls.preferenceEvents[id]);return value;};
 const provider={id:"mock-provider",name:"Mock Provider",protocol:"openai-completions",baseUrl:"https://example.invalid/v1",apiKeyConfigured:true,authType:"api-key",authStatus:"configured",models:[{id:"mock-model",name:"Mock Model"}]};
 await page.route('**/api/**', async route=>{
  const path=new URL(route.request().url()).pathname; let result; let held;
  if(path==='/api/bootstrap') {if(controls.failBootstrap){await route.fulfill({status:503,json:{ok:false,error:{message:'Fixture bootstrap unavailable'}}});return;}result=controls.bootstrapOverride||{workspaces:[{id:workspaceId,name:'workspace',path:'/mock',addedAt:'2026-10-02'}],catalogs:[{workspaceId,sessions}],activeWorkspaceId:workspaceId};held=controls.holdBootstrap;}
  else if(path.endsWith('/attachments')) {const input=route.request().postDataJSON();controls.uploads.push(input);result={type:'attachment',id:`fixture-upload-${controls.uploads.length}`,workspaceId,name:input.name,mime:input.mime,size:Buffer.from(input.base64,'base64').length};}
  else if(path.endsWith('/files') || path.endsWith('/search')) result={path:'',entries:[{name:'note.md',path:'note.md',kind:'file'},{name:'example.html',path:'example.html',kind:'file'}],truncated:false};
  else if(path.endsWith('/preview')) {const html=new URL(route.request().url()).searchParams.get('path')==='example.html';result={path:html?'example.html':'note.md',name:html?'example.html':'note.md',mime:html?'text/html':'text/markdown',size:200,kind:html?'html':'text',text:html?'<h1>Static fixture</h1><script>parent.fixtureScriptRan=true</script>':'# bounded file fixture'};}
  else if(path.endsWith('/changes')) result={turnId:'fixture-turn',partial:!controls.verification,verification:controls.verification,files:[{path:'note.md',status:'modified',before:'old',after:'new',diff:'--- a/note.md\n+++ b/note.md\n-old\n+new'}],notice:'Fixture changes only'};
  else if(path.endsWith('/references')) result={files:[{path:'note.md'}],sessions:[sessions[1]]};
  else if(path.endsWith('/resolve-references')) result=route.request().postDataJSON().message+'\n[User-selected source]\nbounded file fixture';
  else if(path==='/api/presets') result=[{id:'standard',name:'标准模式',trust:'system',description:'qì agent 默认的完整编码 Agent，包含文件、Shell、LSP、Skills、子代理与工作流能力。'},{id:'creator',name:'创造模式',trust:'system',description:'qì agent 高级创造 Agent：继承标准编码能力，支持运行时拓扑自省、可版本化受控插件实验，以及用户 Preset 的创建、修改与校验。'},{id:'production',name:'生产只读模式',trust:'system',description:'显式使用官方 API 的只读基线；无订阅回退，写入与外部动作默认拒绝，真实验收另行配置。'}];
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
   else if(method==='subagent.status') result={providers:[],jobs:controls.jobs || []};
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


import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
const task='/Users/geb/Documents/Codex/2026-10-19/task-2';
const mode=process.argv[2] || 'candidate';
const port=mode==='baseline'?4191:4192;
base=`http://127.0.0.1:${port}`;
const repository=`${task}/${mode==='baseline'?'pixel-20261020/baseline-source':'qi-agent'}`;
const out=`${process.argv[3] || `${task}/pixel-20261020`}/${mode}`;await mkdir(out,{recursive:true});
const server=spawn(process.execPath,[`${repository}/node_modules/vite/bin/vite.js`,'preview','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:repository,stdio:['ignore','pipe','pipe']});
const evidence=[];
async function shot(page,name){await page.mouse.move(1439,999);if(!name.includes('menu')&&!name.includes('model-options'))await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur()});await page.waitForTimeout(350);await page.evaluate(()=>document.fonts.ready);await settle(page);if(['permission-menu-light-1440','model-menu-light-1440','account-menu-light-1440','workspace-menu-light-1440'].includes(name)&&mode==='candidate')assert.ok(await page.locator('[role=menu]:visible').count()>0,`${name}: menu must remain open`);await page.screenshot({path:`${out}/${name}.png`,animations:'disabled'});if(['settings-light-1440','settings-dark-1440','new-session-dark-1440','permission-menu-light-1440','workspace-menu-light-1440','model-options-light-1440','model-options-light-320'].includes(name)){
 await mkdir(join(out,'probes'),{recursive:true});
 const trace=await page.evaluate(()=>{
  const all=el=>{const s=getComputedStyle(el);return Object.fromEntries([...s].filter(k=>!k.startsWith('--')).map(k=>[k,s.getPropertyValue(k)]))};
  const chain=el=>{const rows=[];for(let node=el;node&&rows.length<12;node=node.parentElement){const b=node.getBoundingClientRect();rows.push({tag:node.tagName,class:typeof node.className==='string'?node.className:node.getAttribute('class'),box:{x:b.x,y:b.y,width:b.width,height:b.height},css:all(node),svg:node.tagName==='svg'?node.outerHTML:undefined})}return rows};
  const sun=[...document.querySelectorAll('button')].find(el=>el.textContent==='浅色')?.querySelector('svg');
  const step=document.querySelector('.content-font-stepper,[class*=stepper]');
  const card=document.querySelector('.composer,.pbVuNW_card');
  const menu=document.querySelector('.composer-popover,[data-menu-material]');
  return{sun: sun?{chain:chain(sun),children:[...sun.children].map(el=>({html:el.outerHTML,css:all(el)}))}:null,stepper:step?chain(step):null,card:card?chain(card):null,menu:menu?chain(menu):null}
 });
 await writeFile(join(out,'probes',name+'-render-trace.json'),JSON.stringify(trace,null,2));
 for(const [i,delay] of [[1,50],[2,50],[3,600]]){await page.waitForTimeout(delay);await page.screenshot({path:join(out,'probes',name+'-repeat-'+i+'.png'),animations:'disabled'})}
}
const metrics=await page.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},text:document.body.innerText,elements:[...document.querySelectorAll('button,button > svg,button span,button strong,input,textarea,select,h1,p,summary,.message,.reasoning-row,[role=menu],[role=group],[role="dialog"],.composer-popover,.content-font-stepper,.composer,.draft-preset,.draft-context,.welcome-copy,.welcome-title-group,.preview-badge')].map(el=>{const b=el.getBoundingClientRect();const s=getComputedStyle(el);const textNode=[...el.childNodes].find(n=>n.nodeType===Node.TEXT_NODE&&n.textContent?.trim());let textBox=null;if(textNode){const r=document.createRange();r.selectNodeContents(textNode);const t=r.getBoundingClientRect();textBox={x:t.x,y:t.y,width:t.width,height:t.height};}return{svg:el.tagName==='svg'?el.outerHTML:undefined,textBox,tag:el.tagName,text:(el.textContent||el.getAttribute('aria-label')||el.getAttribute('placeholder')||'').slice(0,160),class:el.className,box:{x:b.x,y:b.y,width:b.width,height:b.height},style:{font:s.font,fontFamily:s.fontFamily,lineHeight:s.lineHeight,color:s.color,background:s.backgroundColor,border:s.border,borderRadius:s.borderRadius,padding:s.padding,gap:s.gap,boxShadow:s.boxShadow,fontKerning:s.fontKerning,fontVariationSettings:s.fontVariationSettings,fontFeatureSettings:s.fontFeatureSettings,fontOpticalSizing:s.fontOpticalSizing,fontSizeAdjust:s.fontSizeAdjust,textRendering:s.textRendering,fontSynthesis:s.fontSynthesis,letterSpacing:s.letterSpacing,filter:s.filter,transform:s.transform,contain:s.contain,willChange:s.willChange,opacity:s.opacity,fontSmoothing:s.webkitFontSmoothing,cornerShape:s.cornerShape,stroke:s.stroke,strokeWidth:s.strokeWidth,strokeLinecap:s.strokeLinecap,strokeLinejoin:s.strokeLinejoin,shapeRendering:s.shapeRendering}}}).filter(e=>e.box.width&&e.box.height)}));if(['permission-menu-light-1440','workspace-menu-light-1440'].includes(name)&&mode==='candidate'){const cdp=await page.context().newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');const {root}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:name.startsWith('permission')?'.permission-option-copy':'.workspace-menu [role=menuitemradio] > span'});metrics.platformFonts={...await cdp.send('CSS.getPlatformFontsForNode',{nodeId}),computed:(await cdp.send('CSS.getComputedStyleForNode',{nodeId})).computedStyle};await cdp.detach();}await writeFile(`${out}/${name}.json`,JSON.stringify(metrics,null,2));evidence.push({name,viewport:page.viewportSize()});}
try{
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{} await new Promise(r=>setTimeout(r,50));if(i===99)throw Error('preview failed');}
 const {page,controls}=await fixture();
 const events=[
 {id:'u',seq:1,type:'message',at:'2026-09-01T05:28:14.963Z',data:{message:{role:'user',content:'Begin your reply with the plain sentence "Reading the workspace now." as text, and in that same message call the bash tool with the command "echo alpha". After the tool result, reply with the single word DONE and stop.'}}},
 {id:'start',seq:2,type:'turn/start',at:'2026-09-01T05:28:15.000Z',data:{'turn-id':1}},
 {id:'step',seq:3,type:'step/start',at:'2026-09-01T05:28:15.000Z',data:{}},
 {id:'a1',seq:4,type:'message',at:'2026-09-01T05:28:15.100Z',data:{message:{role:'assistant',reasoning_content:'The user wants me to begin with "Reading the workspace now." and call bash with "echo alpha" in the same message. Then after the tool result, reply with the single word DONE and stop.',content:'Reading the workspace now.'}}},
 {id:'call',seq:5,type:'tool/call',at:'2026-09-01T05:28:15.200Z',data:{name:'bash','call-id':'alpha',arguments:{command:'echo alpha',description:'Print alpha to stdout'}}},
 {id:'result',seq:6,type:'tool/result',at:'2026-09-01T05:28:15.300Z',data:{'call-id':'alpha',ok:true,content:'alpha\n','duration-ms':1}},
 {id:'stepend',seq:7,type:'step/end',at:'2026-09-01T05:28:15.400Z',data:{}},
 {id:'a2',seq:8,type:'message',at:'2026-09-01T05:28:16.000Z',data:{message:{role:'assistant',content:'DONE'}}},
 {id:'end',seq:9,type:'agent/run/end',at:'2026-09-01T05:28:16.000Z',data:{status:'completed','run-id':'pixel-turn',verification:'not-run'}}];
 controls.snapshotOverride={...snapshot('A',0),events};
 await page.clock.setFixedTime(new Date('2026-10-20T09:00:00Z'));await page.goto(base);await page.locator('.session-header-title button').waitFor();await shot(page,'conversation-light-1440');
 const process=page.locator('.turn-process-toggle');if(await process.count())await process.first().click();await shot(page,'process-open-light-1440');
 if(mode!=='baseline'){
  await page.locator('.reasoning-row > summary').click();await shot(page,'reasoning-open-light-1440');await page.locator('.reasoning-content > summary').click();await shot(page,'reasoning-body-open-light-1440');await page.locator('.reasoning-row > summary').click();
  await page.locator('.tool-summary').click();await shot(page,'tools-open-light-1440');await page.locator('.tool-summary').click();
  await page.locator('.permission-trigger').click();await shot(page,'permission-menu-light-1440');await page.keyboard.press('Escape');
  await page.locator('.model-trigger').click();await shot(page,'model-menu-light-1440');await page.locator('.model-root-cell[data-pane=model]').click();await shot(page,'model-options-light-1440');await page.keyboard.press('Escape');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'设置',exact:true}).click();await shot(page,'account-menu-light-1440');await page.keyboard.press('Escape');
 }

 await page.getByRole('button',{name:'设置',exact:true}).click();if(mode!=='baseline'){await page.getByRole('menuitem',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'工作步骤展示',exact:true}).click();await page.getByRole('menuitemradio',{name:'详细',exact:true}).click();assert.equal(await page.evaluate(()=>localStorage.getItem('qi-agent.transcript-view')),'detailed');}await shot(page,'settings-light-1440');
 if(mode!=='baseline'){await page.getByRole('button',{name:'工作步骤展示',exact:true}).click();await shot(page,'settings-transcript-menu-light-1440');await page.keyboard.press('Escape');await page.getByRole('button',{name:'工作步骤收起时机',exact:true}).click();await shot(page,'settings-collapse-menu-light-1440');await page.keyboard.press('Escape');await page.getByRole('button',{name:'工作区',exact:true}).click();await shot(page,'extra-settings-workspaces-light-1440');await page.getByRole('button',{name:'通用设置',exact:true}).click();}
 await page.getByRole('button',{name:'深色',exact:true}).click();await shot(page,'settings-dark-1440');await page.getByRole('button',{name:'关闭设置',exact:true}).click();await shot(page,'process-open-dark-1440');
 await page.locator('.new-session').click();await shot(page,'new-session-dark-1440');
 await page.getByRole('button',{name:'设置',exact:true}).click();if(mode!=='baseline')await page.getByRole('menuitem',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'浅色',exact:true}).click();await page.getByRole('button',{name:'关闭设置',exact:true}).click();await shot(page,'new-session-light-1440');if(mode!=='baseline'){await page.locator('.draft-files-trigger').click();await page.locator('.workspace-file-list').getByRole('button',{name:'note.md',exact:true}).waitFor();await shot(page,'extra-draft-files-light-1440');await page.getByRole('button',{name:'关闭文件面板',exact:true}).click();await page.getByRole('button',{name:'选择工作区',exact:true}).click();await shot(page,'workspace-menu-light-1440');await page.keyboard.press('Escape');await page.locator('.preset-trigger').click();await shot(page,'preset-menu-light-1440');await page.keyboard.press('Escape');}
 for(const width of [1024,768,390,320]){await page.setViewportSize({width,height:844});await shot(page,'new-session-light-'+width);if(mode!=='baseline'&&[390,320].includes(width)){await page.locator('.model-trigger').click();await page.locator('.model-root-cell[data-pane=model]').click();await shot(page,'model-options-light-'+width);await page.keyboard.press('Escape');await page.keyboard.press('Escape');}if(mode!=='baseline'&&width===320){await page.locator('.preset-trigger').click();await shot(page,'preset-menu-light-320');await page.keyboard.press('Escape');}}
 await page.setViewportSize({width:390,height:844});
 if(await page.getByRole('button',{name:'打开导航',exact:true}).isVisible())await page.getByRole('button',{name:'打开导航',exact:true}).click();
 await page.getByRole('button',{name:'设置',exact:true}).click();if(mode!=='baseline')await page.getByRole('menuitem',{name:'设置',exact:true}).click();await shot(page,'settings-light-390');await page.getByRole('button',{name:'深色',exact:true}).click();await shot(page,'settings-dark-390');await page.getByRole('button',{name:'关闭设置',exact:true}).click();
 if(await page.locator('.mobile-scrim').isVisible())await page.keyboard.press('Escape');await shot(page,'new-session-dark-390');

 if(mode!=='baseline'){
  const {page:childPage,controls:child}=await fixture(0);
  sessions[0].name='Ask a research subagent to';sessions[0].presetId='standard';
  const answer="Event sourcing is a pattern where all changes to an application's state are stored as an immutable, append-only sequence of events, rather than persisting only the current state, enabling full auditability, temporal queries, and event-driven architectures.";
  child.snapshotOverride={...snapshot('A',0),events:[
   {id:'child-u',seq:1,type:'message',at:'2026-10-20T09:00:00Z',data:{message:{role:'user',content:'Ask a research subagent to explain event sourcing.'}}},
   {id:'child-a',seq:2,type:'message',at:'2026-10-20T09:00:02Z',data:{message:{role:'assistant',content:answer,reasoning_content:'Explain the pattern in one sentence.'}}},
   {id:'child-end',seq:3,type:'agent/run/end',at:'2026-10-20T09:00:02Z',data:{status:'completed','run-id':'subtask-fixture',verification:'not-run'}}]};
  child.jobs=[{id:'fixture-child',label:'event-sourcing researcher',provider:'spawn',status:'completed',result:answer}];
  await childPage.clock.setFixedTime(new Date('2026-10-20T09:00:00Z'));await childPage.goto(base);await childPage.locator('.session-subagents-trigger').waitFor();await shot(childPage,'extra-subtask-light-1440');
  await childPage.locator('.session-subagents-trigger').click();await shot(childPage,'extra-subtask-menu-light-1440');
  await childPage.locator('.session-subagents .subagent-disclosure summary').click();await shot(childPage,'extra-subtask-result-light-1440');await childPage.keyboard.press('Escape');
  await childPage.setViewportSize({width:390,height:844});await shot(childPage,'extra-subtask-light-390');
  await childPage.locator('.session-subagents-trigger').click();await shot(childPage,'extra-subtask-menu-light-390');await childPage.keyboard.press('Escape');await childPage.close();
  const {page:empty,controls:noWorkspace}=await fixture(0);noWorkspace.bootstrapOverride={workspaces:[],catalogs:[],activeWorkspaceId:null};await empty.goto(base);await empty.locator('.new-session-center').waitFor();await shot(empty,'extra-empty-workspace-light-1440');await empty.close();
  const {page:loading,controls:boot}=await fixture(0);const held=gate('bootstrap');boot.holdBootstrap=held;await loading.goto(base);await held.seen.promise;await shot(loading,'extra-bootstrap-loading-light-1440');held.release.resolve();await held.done.promise;await loading.close();
  const {page:failure,controls:failed}=await fixture(0);failed.failBootstrap=true;await failure.goto(base);await failure.getByRole('status').filter({hasText:'Fixture bootstrap unavailable'}).waitFor();await shot(failure,'extra-bootstrap-error-light-1440');await failure.close();
 }
 assert.deepEqual(errors,[]);await writeFile(`${out}/manifest.json`,JSON.stringify({mode,baseCandidate:'c72cbf2667e90245c9c16149f0bbb8681b8cc12f',settingsPreferenceAlignment:'Selected detailed via actual UI before settings captures; candidate default remains standard; reference fixture uses detailed',browser:browser.version(),dpr:1,locale:'zh-CN',timezone:'UTC',data:'Recorded official turn-tail-actions semantic content translated into qi API fixture; no production protocol change',evidence,errors},null,2));console.log(JSON.stringify({mode,captures:evidence.length,errors}));
}finally{await browser.close();server.kill('SIGTERM');}
