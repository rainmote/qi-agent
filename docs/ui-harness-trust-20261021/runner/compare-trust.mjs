// Native-resolution screenshot comparison only. It never loads or contacts either application.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '../qi-agent/node_modules/playwright/index.mjs';
const root=resolve('qi-agent/docs/ui-harness-trust-20261021'),out=resolve(root,'comparison');await mkdir(out,{recursive:true});
const pairs=[
 ['before-after-trusted','before/trust-trusted-1440.png','candidate/trust-trusted-matched-1440.png','qi 9754431 - trusted, no management entry','qi candidate - trusted status + management entry'],
 ['settings-source-vs-qi','reference/settings-light-1440.png','candidate/trust-settings-1440.png','Official 687f282 settings','qi settings - added project trust (different content)'],
 ['related-source-vs-trust','reference/workspace-menu-light-1440.png','candidate/trust-manage-trusted-1440.png','Official workspace menu - related pattern only','qi project trust - distinct security semantics'],
 ['responsive-trust','candidate/trust-inherited-390.png','candidate/trust-inherited-320.png','qi inherited trust - 390 CSS px','qi inherited trust - 320 CSS px'],
];
const browser=await chromium.launch({headless:true,channel:'chrome'});const page=await browser.newPage({deviceScaleFactor:1});
const records=[];
try{
 for(const [name,left,right,leftLabel,rightLabel] of pairs){
  const a='data:image/png;base64,'+(await readFile(resolve(root,left))).toString('base64');
  const b='data:image/png;base64,'+(await readFile(resolve(root,right))).toString('base64');
  const result=await page.evaluate(async({a,b,leftLabel,rightLabel,compare})=>{
   const load=src=>new Promise((yes,no)=>{const img=new Image();img.onload=()=>yes(img);img.onerror=no;img.src=src;});
   const [one,two]=await Promise.all([load(a),load(b)]);
   const canvas=document.createElement('canvas');canvas.width=one.width+two.width;canvas.height=Math.max(one.height,two.height)+34;
   const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
   ctx.drawImage(one,0,34);ctx.drawImage(two,one.width,34);ctx.fillStyle='#111';ctx.font='18px Arial';ctx.fillText(leftLabel,12,23);ctx.fillText(rightLabel,one.width+12,23);
   const value={png:canvas.toDataURL('image/png'),leftSize:[one.width,one.height],rightSize:[two.width,two.height]};
   if(compare){
    if(one.width!==two.width||one.height!==two.height)throw Error('Native sizes differ');
    const w=one.width,h=one.height,ac=document.createElement('canvas'),bc=document.createElement('canvas');ac.width=bc.width=w;ac.height=bc.height=h;
    const ax=ac.getContext('2d'),bx=bc.getContext('2d');ax.drawImage(one,0,0);bx.drawImage(two,0,0);
    const first=ax.getImageData(0,0,w,h),second=bx.getImageData(0,0,w,h),diff=ax.createImageData(w,h),overlay=ax.createImageData(w,h);
    let changed=0,maxDifference=0,minX=w,minY=h,maxX=-1,maxY=-1;
    for(let i=0;i<first.data.length;i+=4){let differs=false;for(let c=0;c<3;c++){
     const delta=Math.abs(first.data[i+c]-second.data[i+c]);diff.data[i+c]=delta;overlay.data[i+c]=Math.round((first.data[i+c]+second.data[i+c])/2);if(delta)differs=true;maxDifference=Math.max(maxDifference,delta);
    }diff.data[i+3]=overlay.data[i+3]=255;if(differs){changed++;const x=(i/4)%w,y=Math.floor(i/4/w);minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}}
    ax.putImageData(diff,0,0);value.diff=ac.toDataURL('image/png');ax.putImageData(overlay,0,0);value.overlay=ac.toDataURL('image/png');
    value.metrics={changedPixels:changed,bbox:changed?[minX,minY,maxX+1,maxY+1]:null,maxChannelDifference:maxDifference};
   }
   return value;
  },{a,b,leftLabel,rightLabel,compare:name==='before-after-trusted'});
  const png=data=>Buffer.from(data.split(',')[1],'base64');await writeFile(resolve(out,name+'.png'),png(result.png));
  if(result.diff){await writeFile(resolve(out,name+'-difference.png'),png(result.diff));await writeFile(resolve(out,name+'-overlay.png'),png(result.overlay));
   await writeFile(resolve(out,'metrics.json'),JSON.stringify({comparison:'qi baseline vs qi candidate; NOT official fidelity',...result.metrics,size:result.leftSize,resampling:false,masks:[],excludedRegions:[],threshold:null,interpretation:'Visible addition of trust status; no zero-pixel or percent-based acceptance claim.'},null,2)+'\n');}
  records.push({name,left,right,leftSize:result.leftSize,rightSize:result.rightSize,resampling:false,masks:[],pixelEqualityTest:false,stateNote:name==='before-after-trusted'?'Same controlled qi messages and displayed +08 dates; candidate clock pinned to baseline capture. Original baseline IANA timezone was not recorded.':'Different content or component state; qualitative comparison only'});
 }
 await writeFile(resolve(out,'pairs.json'),JSON.stringify(records,null,2)+'\n');console.log(JSON.stringify({browser:browser.version(),pairs:records}));
}finally{await browser.close();}
