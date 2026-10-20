// Task-owned capture against official public replay fixtures; no provider calls.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { it, expect, onTestFinished } from 'vitest'
import { launchWebScaffold, selectedSessionFixture, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh } from './support.ts'
it('captures official subagent and transport states using the shipped runtime', async()=>{
 const out=join(process.cwd(),'../pixel-20261020/reference-extra');await mkdir(out,{recursive:true})
 const fixture=await selectedSessionFixture(join(process.cwd(),'snapshots/web/live-interactions/session.v3.jsonl'))
 const scaffold=await launchWebScaffold({replayFixture:fixture,compareReplaySession:false,paceMs:25});onTestFinished(()=>scaffold.close())
 const browser=await chromium.launch({channel:'chrome'});onTestFinished(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1,locale:'zh-CN',timezoneId:'UTC',colorScheme:'light',reducedMotion:'reduce'})
 const tripwire=watchConsole(page);const sockets=[];let blocked=false
 await page.routeWebSocket('**/api/remote.mux',client=>{const server=client.connectToServer();sockets.push({client,server});client.onMessage(m=>{if(!blocked)server.send(m)});server.onMessage(m=>{if(!blocked)client.send(m)})})
 const shot=async(name)=>{await page.waitForTimeout(350);await page.screenshot({path:join(out,name+'.png'),animations:'disabled'});await writeFile(join(out,name+'.txt'),await page.locator('body').innerText())}
 await page.goto(scaffold.authenticatedUrl);await page.locator('[data-composer-input]').first().waitFor();await shot('empty-workspace-light-1440')
 await connectFreshWorkspaceZh(page,scaffold.workspaceCwd)
 const parent=scaffold.ctx.agents.roots()[0];if(!parent)throw Error('parent missing')
 const settled=scaffold.whenTurnSettled();await page.locator('[data-composer-input][contenteditable=true]').fill('Ask a research subagent to explain event sourcing.');await page.locator('[data-composer-input][contenteditable=true]').press('Enter');await settled
 const started=await scaffold.ctx.subagents.startActivation({delivery:'caller',provider:'spawn',label:'event-sourcing researcher',signal:new AbortController().signal,request:{prompt:[{type:'text',text:'Explain event sourcing in one sentence.'}],parent}})
 await expect.poll(()=>scaffold.ctx.agents.get(started.childId),{timeout:20000}).toBeUndefined()
 await shot('subtask-light-1440')
 await page.getByText('1 个子智能体',{exact:true}).click();await shot('subtask-menu-light-1440');await page.keyboard.press('Escape')
 await page.setViewportSize({width:390,height:844});await shot('subtask-light-390')
 blocked=true;const active=sockets.at(-1);await active.client.close({code:1012,reason:'isolated connection test'});await active.server.close({code:1012,reason:'isolated connection test'});await shot('connection-loss-light-390')
 const loading=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1,locale:'zh-CN',timezoneId:'UTC',colorScheme:'light',reducedMotion:'reduce'});
 await loading.routeWebSocket('**/api/remote.mux',()=>{});await loading.goto(scaffold.authenticatedUrl);await loading.waitForTimeout(500);
 await loading.screenshot({path:join(out,'loading-no-transport-light-1440.png'),animations:'disabled'});await writeFile(join(out,'loading-no-transport-light-1440.txt'),await loading.locator('body').innerText());await loading.close();
 await writeFile(join(out,'manifest.json'),JSON.stringify({sha:'687f282e8625c6b8d11ff58211a90524be2e4317',fixture:'live-interactions/session.v3.jsonl',liveProviderCalls:0,errors:tripwire.pageErrors},null,2));expect(tripwire.pageErrors).toEqual([])
},120000)
