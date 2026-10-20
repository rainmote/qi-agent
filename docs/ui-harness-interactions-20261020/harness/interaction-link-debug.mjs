import {browser,base,fixture,snapshot,settle} from '../qi-agent/apps/web/tests/browser-fixture.mjs';
try{
 const {page,controls}=await fixture();const content=snapshot('A');content.events[1].data.message.content='[工作区文档](docs/guide.md)';controls.snapshotOverride=content;
 await page.goto(base);await page.locator('.session-header-title button').waitFor();await settle(page);
 await page.evaluate(()=>{window.clicks=[];document.addEventListener('click',event=>{if(event.target.closest('a')){const data={button:event.button,ctrl:event.ctrlKey,meta:event.metaKey,alt:event.altKey,shift:event.shiftKey};queueMicrotask(()=>window.clicks.push({...data,defaultPrevented:event.defaultPrevented}));}},true);});
 await page.getByRole('link',{name:'工作区文档',exact:true}).click();await settle(page);await page.waitForTimeout(200);
 console.log(JSON.stringify({data:await page.evaluate(()=>({clicks:window.clicks,storage:localStorage.getItem('qi-agent.web-preferences.v1'),rootInert:document.getElementById('root').inert,links:[...document.querySelectorAll('a')].map(a=>({text:a.textContent,href:a.href})),drawer:document.querySelector('.workspace-panel')?.textContent})),requests:controls.previewRequests,pages:page.context().pages().map(p=>p.url())}));
}finally{await browser.close();}
