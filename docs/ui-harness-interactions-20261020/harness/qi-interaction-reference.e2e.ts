// Task-owned capture: shipped assembly, public fixtures, no provider/model requests.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { it, onTestFinished, expect } from 'vitest'
import { launchWebScaffold, seedSession, selectedSessionFixture, watchConsole } from './scaffold.ts'
it('captures official shortcuts and settings interaction reference', async () => {
 const out=join(process.cwd(),'../interaction-20261020/reference-v3'); await mkdir(out,{recursive:true})
 const scaffold=await launchWebScaffold({}); onTestFinished(()=>scaffold.close())
 const fixture=await selectedSessionFixture(join(process.cwd(),'snapshots/web/turn-tail-actions/session.v3.jsonl'))
 const workspace=await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd,'workspace')
 const id=await seedSession(scaffold,await readFile(fixture,'utf8'),'pixel-session-A',undefined,{createdAt:1792454400000})
 await workspace.attachSession(id); await scaffold.ctx.sessionController.rename({sessionId:id,title:'Begin your reply with the'})
 const previous=await seedSession(scaffold,await readFile(fixture,'utf8'),'pixel-session-B',undefined,{createdAt:1792454340000})
 await workspace.attachSession(previous);await scaffold.ctx.sessionController.rename({sessionId:previous,title:'Previous conversation'})
 const browser=await chromium.launch({channel:'chrome'});onTestFinished(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1,locale:'zh-CN',timezoneId:'UTC',colorScheme:'light',reducedMotion:'reduce'})
 await page.clock.setFixedTime(new Date('2026-10-20T09:00:00Z'));
 const console=watchConsole(page);const evidence=[]
 const shot=async(name:string)=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(200);await page.screenshot({path:join(out,name+'.png'),animations:'disabled'});evidence.push({name,viewport:page.viewportSize(),text:await page.locator('body').innerText()})}
 await page.goto(scaffold.authenticatedUrl);await page.getByText('Begin your reply with the',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:'账号菜单',exact:true}).click();await page.getByText('设置',{exact:true}).click();await shot('01-settings-1440');
 await page.getByRole('button',{name:'编辑快捷键',exact:true}).click();await page.getByRole('searchbox',{name:'搜索快捷键',exact:true}).waitFor();await shot('02-shortcuts-1440');
 await page.getByRole('searchbox',{name:'搜索快捷键',exact:true}).fill('workspace');await shot('03-shortcuts-search-1440');await page.getByRole('searchbox',{name:'搜索快捷键',exact:true}).fill('');
 await page.getByRole('button',{name:/^修改.*快捷键$/}).first().click();await page.getByRole('button',{name:'按下快捷键',exact:true}).waitFor();await page.mouse.move(100,100);await shot('04-shortcut-editor-1440');await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});await shot('05-shortcuts-390');
 expect(console.pageErrors).toEqual([]);await writeFile(join(out,'manifest.json'),JSON.stringify({sha:'687f282e8625c6b8d11ff58211a90524be2e4317',assembly:'official shipped scaffold; public replay fixture; no model calls',browser:browser.version(),dpr:1,locale:'zh-CN',evidence},null,2));
},90000)
