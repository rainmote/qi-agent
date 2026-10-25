// Production-UI subscription catalog regression. All API routes below are fixtures.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { platform, release, arch } from 'node:os';
import { browser, base, errors, fixture, snapshot, deferred, settle } from './browser-fixture.mjs';
const engine=process.env.QI_AGENT_BROWSER_ENGINE||'chromium';
const target=new URL(base);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.protocol,'http:');
const output=resolve(process.env.QI_AGENT_BROWSER_ARTIFACTS||'out/chatgpt-catalog-browser');
await mkdir(output,{recursive:true});
const report={status:'RUNNING',startedAt:new Date().toISOString(),engine,headless:true,browserVersion:browser.version(),
  platform:{os:platform(),release:release(),arch:arch(),node:process.version},profile:'production UI; all APIs mocked; no credentials or model calls',
  controllerSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),cases:[],cleanup:{}};
const save=()=>writeFile(resolve(output,'result.json'),JSON.stringify(report,null,2)+'\n');
await save();
const initialModels=[{id:'catalog-stable',model:'fixture-current','display-name':'Account Current',provider:'chatgpt-subscription','settings-provider-id':'chatgpt',
  'thinking-levels':['low','medium','xhigh'],'thinking-level':'xhigh'}];
const nextModels=[{...initialModels[0],'thinking-levels':['low','medium'],'thinking-level':'medium'},
  ...['alpha','beta','gamma','delta','epsilon'].map(name=>({id:'catalog-'+name,model:'fixture-'+name,'display-name':'Account '+name,provider:'chatgpt-subscription',
  'settings-provider-id':'chatgpt','thinking-levels':['low','medium','high','xhigh'],'thinking-level':'high'}))];
const catalog=models=>({current:models[0],providers:models});
const settingsModels=models=>models.map(model=>({id:model.model,name:model['display-name'],contextWindow:272000,thinkingLevels:model['thinking-levels'],defaultThinkingLevel:model['thinking-level']}));
const baseProvider={id:'chatgpt',name:'ChatGPT 订阅',protocol:'chatgpt-subscription',baseUrl:'https://chatgpt.com/backend-api/codex',builtin:true,
  apiKeyConfigured:false,authType:'chatgpt-subscription',authStatus:'configured',authSource:'codex-auth-cache',authFile:'/isolated-fixture/auth.json',models:settingsModels(initialModels)};
const fullReload={scope:'open-web-sessions',applied:['A'],failures:[]};
async function configured({errorInitially=null,initial=initialModels,next=nextModels}={}){
  const {page,controls}=await fixture();page.setDefaultTimeout(6000);
  controls.modelCatalog=catalog(initial);
  controls.snapshotOverride={...snapshot('A'),models:controls.modelCatalog};
  const state={provider:{...baseProvider,models:settingsModels(initial),...(errorInitially?{modelCatalogError:errorInitially}:{})},refreshes:0,legacySaves:0,retries:0,requests:[],
    refreshError:null,catalogError:null,reload:fullReload,hold:null};
  await page.route('**/api/providers**',async route=>{
    const request=route.request(), path=new URL(request.url()).pathname;
    state.requests.push({path,method:request.method(),body:request.postData()});
    let result;
    if(path==='/api/providers'&&request.method()==='GET')result={providers:[state.provider],presets:[]};
    else if(path==='/api/providers/chatgpt/refresh'){
      assert.equal(request.method(),'POST');const body=request.postData();assert(body===null||body===''||body==='{}','refresh must not send browser-supplied credentials, account, endpoint, or catalog');
      state.refreshes++;if(state.hold){state.hold.seen.resolve();await state.hold.release.promise;}
      if(state.refreshError){await route.fulfill({status:502,json:{ok:false,error:{message:state.refreshError}}});return;}
      if(state.catalogError){
        state.provider={...state.provider,modelCatalogError:state.catalogError};
        await route.fulfill({json:{ok:true,result:{...state.provider,reload:state.reload}}});return;
      }
      state.provider={...baseProvider,models:settingsModels(next)};
      if(!state.reload.failures.length)controls.modelCatalog=catalog(next);
      result={...state.provider,reload:state.reload};
    }else if(path==='/api/providers/reload'){
      state.retries++;assert.equal(request.method(),'POST');assert.deepEqual(request.postDataJSON(),{sessionIds:['A']});
      controls.modelCatalog=catalog(nextModels);result=fullReload;
    }else if(path==='/api/providers'&&request.method()==='POST'){state.legacySaves++;throw new Error('Subscription refresh must not save a browser-supplied model draft');}
    else throw new Error('Unexpected provider route '+path);
    await route.fulfill({json:{ok:true,result}});
  });
  await page.goto(base);await page.locator('.session-header-title button').waitFor();
  await page.locator('.model-trigger').waitFor();
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'模型',exact:true}).click();
  await page.getByRole('button',{name:'编辑 ChatGPT 订阅 (chatgpt)',exact:true}).click();
  await page.getByRole('button',{name:'刷新登录状态',exact:true}).waitFor();
  return {page,controls,state};
}
async function closeSettings(page){await page.getByRole('button',{name:'关闭设置',exact:true}).click();await settle(page);}
async function checkOptions(page){
  await page.locator('.model-trigger').click();await page.getByRole('menuitem',{name:/^模型/}).click();
  await page.getByRole('searchbox',{name:'搜索模型',exact:true}).waitFor();
  assert.deepEqual(await page.getByRole('menu',{name:'选择模型',exact:true}).getByRole('menuitemradio').allTextContents(),nextModels.map(row=>row['display-name']));
  await page.keyboard.press('Escape');await page.keyboard.press('Escape');
}
async function run(name,body){const row={name,status:'RUNNING',startedAt:new Date().toISOString()};report.cases.push(row);await save();let page;
  try{await body(value=>page=value);row.status='PASS';}
  catch(error){row.status='FAIL';row.error=error.stack||String(error);console.error(name+': '+row.error);}
  finally{row.endedAt=new Date().toISOString();if(page&&!page.isClosed()){row.screenshot=name+'.png';await page.screenshot({path:resolve(output,row.screenshot),fullPage:true,animations:'disabled'}).catch(error=>row.screenshotError=String(error));await page.close();}await save();}
}
try{
  await run('subscription-refresh-composer',async own=>{
    const {page,controls,state}=await configured();own(page);
    assert.match(await page.locator('.provider-editor').innerText(),/Account Current/,'subscription displays its read-only catalog');
    assert.equal(await page.locator('.provider-editor').getByRole('textbox').count(),0,'subscription must not edit model IDs or credentials');
    state.hold={seen:deferred(),release:deferred()};
    const refresh=page.getByRole('button',{name:'刷新登录状态',exact:true});await refresh.click();
    await Promise.race([state.hold.seen.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Refresh did not call subscription catalog API')),6000))]);
    const busy=page.getByRole('button',{name:'正在刷新',exact:true});assert.equal(await busy.isDisabled(),true);
    await busy.evaluate(node=>{node.click();node.click();});assert.equal(state.refreshes,1,'busy duplicate clicks do not issue extra refreshes');
    state.hold.release.resolve();
    await page.locator('.provider-editor').waitFor({state:'hidden'});await closeSettings(page);
    await checkOptions(page);assert.equal(state.refreshes,1);assert.equal(state.legacySaves,0);assert.equal(controls.submissions.length,0);
    assert(!JSON.stringify(state.requests).includes('private-token'));
  });
  await run('same-model-reasoning-reconciles',async own=>{
    const {page,controls,state}=await configured();own(page);await page.getByRole('button',{name:'刷新登录状态',exact:true}).click();
    await page.locator('.provider-editor').waitFor({state:'hidden'});await closeSettings(page);
    assert.match(await page.locator('.model-trigger').innerText(),/Account Current/);
    assert.match(await page.locator('.model-trigger').innerText(),/Medium/,'same identity must reflect worker-confirmed supported effort');
    assert.doesNotMatch(await page.locator('.model-trigger').innerText(),/Xhigh|XHigh/i);
    await page.locator('.model-trigger').click();await page.getByRole('menuitem',{name:/^推理等级/}).click();
    const options=page.getByRole('radiogroup',{name:'推力强度',exact:true});assert.deepEqual(await options.getByRole('radio').allTextContents(),['Low','Medium']);
    assert.equal(await options.getByRole('radio',{name:'Medium',exact:true}).getAttribute('aria-checked'),'true');
    assert.equal(state.refreshes,1);assert.equal(controls.submissions.length,0);
  });
  await run('refresh-failure-remains-visible-retry',async own=>{
    const {page,controls,state}=await configured();own(page);state.refreshError='Fixture ChatGPT catalog unavailable (HTTP 503)';
    await page.getByRole('button',{name:'刷新登录状态',exact:true}).click();
    await page.getByText(state.refreshError,{exact:true}).waitFor();assert.equal(await page.locator('.provider-editor').isVisible(),true);
    assert.match(await page.locator('.provider-editor').innerText(),/Account Current/);assert.equal(state.refreshes,1);
    state.refreshError=null;await page.getByRole('button',{name:'刷新登录状态',exact:true}).click();
    await page.locator('.provider-editor').waitFor({state:'hidden'});await closeSettings(page);await checkOptions(page);
    assert.equal(state.refreshes,2);assert.equal(state.legacySaves,0);assert.equal(controls.submissions.length,0);
  });
  await run('saved-catalog-worker-reload-retry',async own=>{
    const {page,controls,state}=await configured();own(page);
    state.reload={scope:'open-web-sessions',applied:[],failures:[{sessionId:'A',sessionName:'会话A',message:'Fixture worker reload timed out'}]};
    await page.getByRole('button',{name:'刷新登录状态',exact:true}).click();
    await page.getByText('Fixture worker reload timed out',{exact:false}).waitFor();
    await page.getByRole('button',{name:'重试未生效会话',exact:true}).click();
    await page.getByText('配置已保存，已更新 1 个 Web 会话。',{exact:true}).waitFor();
    await closeSettings(page);await checkOptions(page);assert.equal(state.refreshes,1);assert.equal(state.retries,1);assert.equal(controls.submissions.length,0);
  });
  await run('removed-model-effort-uses-worker-fallback',async own=>{
    const initial=[{...initialModels[0],'thinking-levels':['low','medium'],'thinking-level':'low'}];
    const next=[{...initialModels[0],id:'catalog-fallback',model:'fixture-fallback','display-name':'Account Fallback','thinking-levels':['low','medium'],'thinking-level':'medium'}];
    const {page,controls,state}=await configured({initial,next});own(page);
    await page.getByRole('button',{name:'刷新登录状态',exact:true}).click();
    await page.locator('.provider-editor').waitFor({state:'hidden'});await closeSettings(page);
    assert.match(await page.locator('.model-trigger').innerText(),/Account Fallback/,'removed model must switch to worker fallback identity');
    assert.match(await page.locator('.model-trigger').innerText(),/Medium/,'changed identity must use worker-confirmed effort even if previous Low is still supported');
    await page.locator('.model-trigger').click();await page.getByRole('menuitem',{name:/^推理等级/}).click();
    const options=page.getByRole('radiogroup',{name:'推力强度',exact:true});assert.deepEqual(await options.getByRole('radio').allTextContents(),['Low','Medium']);
    assert.equal(await options.getByRole('radio',{name:'Medium',exact:true}).getAttribute('aria-checked'),'true');
    assert.equal(state.refreshes,1);assert.equal(controls.submissions.length,0);
  });
  await run('catalog-error-envelope-remains-visible-retry',async own=>{
    const {page,controls,state}=await configured();own(page);state.catalogError='Fixture catalog refresh failed; retained current-account cache';
    await page.getByRole('button',{name:'刷新登录状态',exact:true}).click();
    await page.locator('.provider-editor .form-error').filter({hasText:state.catalogError}).waitFor();
    assert.equal(await page.locator('.provider-editor .form-error').innerText(),state.catalogError);
    assert.equal(await page.locator('.provider-editor').isVisible(),true);assert.match(await page.locator('.provider-editor').innerText(),/Account Current/);
    assert.equal(state.refreshes,1);assert.deepEqual(controls.modelCatalog,catalog(initialModels),'failed refresh preserves worker catalog');
    state.catalogError=null;await page.getByRole('button',{name:'刷新登录状态',exact:true}).click();
    await page.locator('.provider-editor').waitFor({state:'hidden'});await closeSettings(page);await checkOptions(page);
    assert.equal(state.refreshes,2);assert.equal(state.legacySaves,0);assert.equal(controls.submissions.length,0);
  });
  await run('initial-catalog-error-is-visible',async own=>{
    const message='Fixture initial catalog refresh failed; cached models may be stale';
    const {page,state,controls}=await configured({errorInitially:message});own(page);
    await page.getByText(message,{exact:true}).waitFor();assert.match(await page.locator('.provider-editor').innerText(),/Account Current/);
    assert.equal(state.refreshes,0);assert.equal(controls.submissions.length,0);
  });
  assert.deepEqual(errors,[],'unexpected browser script errors');
  report.status=report.cases.every(row=>row.status==='PASS')?'PASS':'FAIL';
}catch(error){report.status='FAIL';report.error=error.stack||String(error);}
finally{try{await browser.close();report.cleanup.browserClosed=true;}catch(error){report.cleanup.error=String(error);report.status='FAIL';}
  report.endedAt=new Date().toISOString();report.counts={total:report.cases.length,passed:report.cases.filter(row=>row.status==='PASS').length,failed:report.cases.filter(row=>row.status==='FAIL').length};await save();console.log(JSON.stringify(report));if(report.status!=='PASS')process.exitCode=1;}
