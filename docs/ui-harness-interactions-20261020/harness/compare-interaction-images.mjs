import fs from 'node:fs/promises';
import {chromium} from '../qi-agent/node_modules/playwright/index.mjs';
const root=new URL('../qi-agent/docs/ui-harness-interactions-20261020/',import.meta.url),out=new URL('comparison/',root);await fs.mkdir(out,{recursive:true});
const inputs=await Promise.all(['reference/02-shortcuts-1440.png','candidate/interaction-shortcuts-1440.png'].map(async p=>'data:image/png;base64,'+(await fs.readFile(new URL(p,root))).toString('base64')));
const browser=await chromium.launch({channel:'chrome'});
try{const page=await browser.newPage();const result=await page.evaluate(async inputs=>{
 const images=await Promise.all(inputs.map(src=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=src;})));
 const [a,b]=images;if(a.width!==1440||a.height!==1000||b.width!==a.width||b.height!==a.height)throw Error('mismatched dimensions');
 const canvas=(width=a.width,height=a.height)=>{const el=document.createElement('canvas');el.width=width;el.height=height;return el;};
 const source=images.map(image=>{const el=canvas();el.getContext('2d').drawImage(image,0,0);return el.getContext('2d').getImageData(0,0,a.width,a.height);});
 const overlay=canvas(),diff=canvas(),sides=canvas(2880);sides.getContext('2d').drawImage(a,0,0);sides.getContext('2d').drawImage(b,1440,0);
 const blend=new ImageData(1440,1000),delta=new ImageData(1440,1000);let nonzero=0,modalNonzero=0,max=0;
 for(let i=0;i<source[0].data.length;i+=4){let changed=false;for(let c=0;c<3;c++){const d=Math.abs(source[0].data[i+c]-source[1].data[i+c]);changed||=d>0;max=Math.max(max,d);blend.data[i+c]=Math.round((source[0].data[i+c]+source[1].data[i+c])/2);delta.data[i+c]=Math.min(255,d*3);}blend.data[i+3]=delta.data[i+3]=255;if(changed){nonzero++;const p=i/4,x=p%1440,y=Math.floor(p/1440);if(x>=480&&x<960&&y>=230&&y<830)modalNonzero++;}}
 overlay.getContext('2d').putImageData(blend,0,0);diff.getContext('2d').putImageData(delta,0,0);
 return {images:{'side-by-side.png':sides.toDataURL(),'overlay.png':overlay.toDataURL(),'difference.png':diff.toDataURL()},metrics:{viewport:[1440,1000],dpr:1,full_nonzero_pixels:nonzero,full_pixels:1440000,modal_crop:[480,230,960,830],modal_nonzero_pixels:modalNonzero,modal_pixels:288000,max_channel_delta:max,exclusion_masks:[]}};
},inputs);
for(const [name,data]of Object.entries(result.images))await fs.writeFile(new URL(name,out),Buffer.from(data.split(',')[1],'base64'));
await fs.writeFile(new URL('metrics.json',out),JSON.stringify({...result.metrics,browser:browser.version(),reference:'reference/02-shortcuts-1440.png',candidate:'candidate/interaction-shortcuts-1440.png',acceptance:'blocked; diagnostic only. Official draft vs qi fixture session background and catalog/focus/heading states differ. No matched-content whole-screen claim. The crop does not waive the rest of the screen.'},null,2)+'\n');console.log(JSON.stringify(result.metrics));
}finally{await browser.close();}
