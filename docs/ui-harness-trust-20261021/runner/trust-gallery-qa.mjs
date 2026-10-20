import { chromium } from '../qi-agent/node_modules/playwright/index.mjs';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve('qi-agent/docs/ui-harness-trust-20261021');
const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 const images=await Promise.all(['reference/settings-light-1440.png','candidate/trust-settings-1440.png'].map(async path=>'data:image/png;base64,'+(await readFile(resolve(root,path))).toString('base64')));
 const png=await page.evaluate(async images=>{
  const load=src=>new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image);image.src=src;});const [a,b]=await Promise.all(images.map(load));
  const canvas=document.createElement('canvas');canvas.width=1160;canvas.height=284;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,1160,284);ctx.font='18px Arial';ctx.fillStyle='#111';ctx.fillText('Official settings - permission/language',10,23);ctx.fillText('qi settings - permission/trust/language',590,23);ctx.drawImage(a,520,160,580,250,0,34,580,250);ctx.drawImage(b,520,160,580,250,580,34,580,250);return canvas.toDataURL('image/png');
 },images);
 await writeFile(resolve(root,'comparison/settings-focus.png'),Buffer.from(png.split(',')[1],'base64'));
 await writeFile(resolve(root,'comparison/settings-focus.json'),JSON.stringify({crop:[520,160,580,250],size:[1160,284],resampling:false,qualitativeOnly:true,fullImageComparison:'settings-source-vs-qi.png',note:'Focused view is supplementary; no cropped regions are excluded from whole-image evidence.'},null,2)+'\n');
 await page.goto('file://'+resolve(root,'index.html'));await page.locator('h1').waitFor();await page.evaluate(async()=>{for(const details of document.querySelectorAll('details'))details.open=true;for(const img of document.images)img.loading='eager';await Promise.all([...document.images].map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=resolve;img.onerror=resolve;})));});
 const bad=await page.evaluate(()=>[...document.images].filter(img=>!img.naturalWidth).map(img=>img.getAttribute('src')));if(bad.length||errors.length)throw Error(JSON.stringify({bad,errors}));
 await page.locator('#alpha').fill('25');const opacity=await page.locator('#over').evaluate(el=>getComputedStyle(el).opacity);if(opacity!=='0.25')throw Error('Overlay control did not respond');
 await page.screenshot({path:resolve(root,'comparison/gallery-desktop.png'),animations:'disabled'});await page.setViewportSize({width:390,height:844});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow)throw Error('Evidence gallery overflows at390');await page.screenshot({path:resolve(root,'comparison/gallery-mobile.png'),animations:'disabled'});
 await writeFile(resolve(root,'comparison/gallery-check.json'),JSON.stringify({browser:browser.version(),badImages:bad,pageErrors:errors,overlayOpacity:opacity,mobileOverflow:overflow,status:'passed'},null,2)+'\n');console.log(JSON.stringify({gallery:'passed',badImages:bad,pageErrors:errors,overlayOpacity:opacity,mobileOverflow:overflow}));
}finally{await browser.close();}
