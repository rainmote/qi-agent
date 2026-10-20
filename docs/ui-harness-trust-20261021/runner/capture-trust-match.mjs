// Match the prior baseline's rendered +08 timestamps; never reads a host project.
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browser,base,fixture,settle,errors } from '../qi-agent/apps/web/tests/browser-fixture.mjs';
const root=resolve('../qi-agent/docs/ui-harness-trust-20261021');
const baseline=JSON.parse(await readFile(resolve(root,'before/trust-trusted-1440.json'),'utf8'));
try{
 const {page,controls}=await fixture(2,{viewport:{width:1440,height:1000},deviceScaleFactor:1,locale:'zh-CN',timezoneId:'Asia/Singapore',reducedMotion:'reduce'});
 await page.clock.install({time:new Date(baseline.capturedAt)});
 controls.trustStates={A:{configured:true,root:'/mock/project-a',decision:'allow','explicit?':true,'matched-root':'/mock/project-a',source:'user-store',mutable:true}};
 await page.goto(base);await page.locator('.session-header-title button').waitFor();await settle(page);
 await page.screenshot({path:resolve(root,'candidate/trust-trusted-matched-1440.png'),animations:'disabled',fullPage:true});
 const state=await page.evaluate(()=>({dpr:devicePixelRatio,locale:document.documentElement.lang,theme:document.body.dataset.theme,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,timezoneOffset:new Date().getTimezoneOffset(),bodyFont:getComputedStyle(document.body).fontFamily,composer:document.querySelector('.composer').getBoundingClientRect().toJSON()}));
 await writeFile(resolve(root,'candidate/trust-trusted-matched-1440.json'),JSON.stringify({capturedAt:new Date().toISOString(),clock:new Date(baseline.capturedAt).toISOString(),browser:browser.version(),viewport:page.viewportSize(),state,baselineTimezone:'Original capture did not record IANA zone; displayed 09:00 for 01:00Z. Candidate uses Asia/Singapore to match that visible +08 content.',errors,masks:[]},null,2)+'\n');
 if(errors.length)throw Error(JSON.stringify(errors));
 console.log(JSON.stringify({capture:'trusted matched clock/displayed timezone',errors}));
}finally{await browser.close();}
