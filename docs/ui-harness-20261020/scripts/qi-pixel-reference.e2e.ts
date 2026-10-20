// Task-owned capture: shipped assembly, public fixtures, no provider/model requests.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { it, onTestFinished, expect } from 'vitest'
import { launchWebScaffold, seedSession, selectedSessionFixture, watchConsole } from './scaffold.ts'
it('captures normalized official reference states', async () => {
 const out=join(process.cwd(),'../pixel-20261020/reference'); await mkdir(out,{recursive:true})
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
 const shot=async(name:string)=>{
  await page.mouse.move(1439,999);if(!name.includes('menu')&&!name.includes('model-options'))await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur()});await page.waitForTimeout(350);await page.evaluate(()=>document.fonts.ready)
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
  if(name.includes('menu'))expect(await page.locator('[role=menu]:visible').count(),`${name}: menu must remain open`).toBeGreaterThan(0)
  if(name.includes('model-options'))expect(await page.getByRole('menuitemradio').count()).toBeGreaterThan(0)
  await page.screenshot({path:join(out,name+'.png'),animations:'disabled'})
  const metrics=await page.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},text:document.body.innerText,elements:[...document.querySelectorAll('button,button > svg,button span,button strong,input,p,summary,[role=menu],[role=group],[data-composer-input],h1,[role="dialog"],[data-turn-process],[class*="headline"],[class*="titleGroup"],[class*="previewBadge"],[class*="fishHitbox"],[class*="stack"],[class*="card"],[class*="row"],[class*="stepper"]')].map(el=>{const b=el.getBoundingClientRect();const s=getComputedStyle(el);const textNode=[...el.childNodes].find(n=>n.nodeType===Node.TEXT_NODE&&n.textContent?.trim());let textBox=null;if(textNode){const r=document.createRange();r.selectNodeContents(textNode);const t=r.getBoundingClientRect();textBox={x:t.x,y:t.y,width:t.width,height:t.height};}return{svg:el.tagName==='svg'?el.outerHTML:undefined,textBox,tag:el.tagName,text:(el.textContent||el.getAttribute('aria-label')||el.getAttribute('data-placeholder')||'').slice(0,160),class:el.className,box:{x:b.x,y:b.y,width:b.width,height:b.height},style:{font:s.font,fontFamily:s.fontFamily,lineHeight:s.lineHeight,color:s.color,background:s.backgroundColor,border:s.border,borderRadius:s.borderRadius,padding:s.padding,gap:s.gap,boxShadow:s.boxShadow,fontKerning:s.fontKerning,fontVariationSettings:s.fontVariationSettings,fontFeatureSettings:s.fontFeatureSettings,fontOpticalSizing:s.fontOpticalSizing,fontSizeAdjust:s.fontSizeAdjust,textRendering:s.textRendering,fontSynthesis:s.fontSynthesis,letterSpacing:s.letterSpacing,filter:s.filter,transform:s.transform,contain:s.contain,willChange:s.willChange,opacity:s.opacity,fontSmoothing:s.webkitFontSmoothing,cornerShape:s.cornerShape,stroke:s.stroke,strokeWidth:s.strokeWidth,strokeLinecap:s.strokeLinecap,strokeLinejoin:s.strokeLinejoin,shapeRendering:s.shapeRendering}}}).filter(e=>e.box.width&&e.box.height)}))
  let platformFonts: unknown = undefined
  if (['permission-menu-light-1440','workspace-menu-light-1440'].includes(name)) {
   const cdp=await page.context().newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable')
   const {root}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:'[role=menu] [role^=menuitem] span[class*=itemLabel]'})
   platformFonts={...await cdp.send('CSS.getPlatformFontsForNode',{nodeId}),computed:(await cdp.send('CSS.getComputedStyleForNode',{nodeId})).computedStyle};await cdp.detach()
  }
  await writeFile(join(out,name+'.json'),JSON.stringify({...metrics,platformFonts},null,2));evidence.push({name,viewport:page.viewportSize()})
 }
 await page.goto(scaffold.authenticatedUrl);await page.getByRole('treeitem').filter({has:page.getByText('Begin your reply with the',{exact:true})}).click();await page.locator('[data-turn-process]').first().waitFor();await shot('conversation-light-1440')
 await page.locator('[data-turn-process]').first().click();await shot('process-open-light-1440')
 await page.getByRole('button',{name:'已完成分析',exact:true}).click();await shot('reasoning-open-light-1440');await page.getByText('思考',{exact:true}).click();await shot('reasoning-body-open-light-1440');await page.getByRole('button',{name:'已完成分析',exact:true}).click()
 await page.getByRole('button',{name:'执行了命令',exact:true}).click();await shot('tools-open-light-1440');await page.getByRole('button',{name:'执行了命令',exact:true}).click()
 await page.getByText('工作区内修改',{exact:true}).click();await shot('permission-menu-light-1440');await page.keyboard.press('Escape')
 await page.getByText('DeepSeek-V4-Flash',{exact:true}).click();await shot('model-menu-light-1440');await page.getByRole('menuitem').filter({hasText:'模型'}).click();await shot('model-options-light-1440');await page.keyboard.press('Escape');await page.keyboard.press('Escape')
 await page.getByRole('button',{name:'账号菜单',exact:true}).click();await shot('account-menu-light-1440')
 await page.getByText('设置',{exact:true}).click();await page.getByRole('button',{name:'通用设置',exact:true}).waitFor();await shot('settings-light-1440')
 await page.getByRole('button',{name:'深色',exact:true}).click();await shot('settings-dark-1440')
 await page.getByRole('button',{name:'关闭',exact:true}).click();await shot('process-open-dark-1440')
 await page.getByRole('button',{name:'新建会话',exact:true}).last().click();await page.locator('[data-composer-input]').first().waitFor();await shot('new-session-dark-1440')
 await page.getByRole('button',{name:'账号菜单',exact:true}).click();await page.getByText('设置',{exact:true}).click();await page.getByRole('button',{name:'浅色',exact:true}).click();await page.getByRole('button',{name:'关闭',exact:true}).click()
 await shot('new-session-light-1440')
 await page.getByRole('button',{name:'标准模式',exact:true}).click();await shot('preset-menu-light-1440');await page.keyboard.press('Escape')
 await page.getByRole('button',{name:'选择工作区',exact:true}).click();await shot('workspace-menu-light-1440');await page.keyboard.press('Escape')
 for(const width of [1024,768,390,320]) {await page.setViewportSize({width,height:844});await shot('new-session-light-'+width);if([390,320].includes(width)){await page.locator('[data-composer-input]').first().waitFor();await page.getByRole('button',{name:/^选择模型/}).click();await page.getByRole('menuitem').filter({hasText:'模型'}).click();await shot('model-options-light-'+width);await page.keyboard.press('Escape');await page.keyboard.press('Escape')}if(width===320){await page.getByRole('button',{name:'标准模式',exact:true}).click();await shot('preset-menu-light-320');await page.keyboard.press('Escape')}}
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'账号菜单',exact:true}).click();await page.getByText('设置',{exact:true}).click();await shot('settings-light-390')
 await page.getByRole('button',{name:'深色',exact:true}).click();await shot('settings-dark-390');await page.getByRole('button',{name:'关闭',exact:true}).click();await shot('new-session-dark-390')
 expect(console.pageErrors).toEqual([])
 await writeFile(join(out,'manifest.json'),JSON.stringify({sha:'687f282e8625c6b8d11ff58211a90524be2e4317',assembly:'shipped web + isolated scaffold + recorded fixture, zero model calls',browser:browser.version(),locale:'zh-CN',timezone:'UTC',dpr:1,evidence,errors:console.pageErrors},null,2))
},180000)
