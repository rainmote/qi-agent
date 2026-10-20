"""Unmasked native-resolution comparison. No crops are excluded from whole-page metrics."""
from PIL import Image, ImageChops, ImageDraw
from pathlib import Path
import json, statistics, sys
root=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path(__file__).resolve().parent.parent/'pixel-20261020'
out=root/'comparison';out.mkdir(exist_ok=True)
rows=[]
def metrics(a,b):
 d=ImageChops.difference(a,b); hist=d.histogram(); total=a.width*a.height
 mae=sum((i%256)*n for i,n in enumerate(hist))/(total*3)
 hi=list(d.convert('RGB').getdata()); changed=sum(max(v)>16 for v in hi); nonzero=sum(max(v)>0 for v in hi)
 return {'width':a.width,'height':a.height,'mae_0_255':round(mae,5),'pixels_nonzero':nonzero,'pixels_nonzero_percent':round(nonzero/total*100,5),'exact_equal':nonzero==0,'pixels_gt16':changed,'pixels_gt16_percent':round(changed/total*100,5)}
for src in sorted((root/'reference').glob('*.png')):
 for mode in ['baseline','candidate']:
  dst=root/mode/src.name
  if not dst.exists():continue
  a=Image.open(src).convert('RGB');b=Image.open(dst).convert('RGB')
  if a.size!=b.size:raise ValueError(f'{src.name}: unequal sizes')
  record={'name':src.stem,'mode':mode,'raw_unmasked':metrics(a,b),'exclusions':[]}
  # Region metrics supplement, never replace the unmasked page.
  meta=json.loads(src.with_suffix('.json').read_text()); cards=[e for e in meta['elements'] if str(e['class'])=='pbVuNW_card']
  if cards:
   q=cards[0]['box'];box=tuple(round(n) for n in (q['x'],q['y'],q['x']+q['width'],q['y']+q['height']))
   record['composer_region']={'box':box,**metrics(a.crop(box),b.crop(box))}
  rows.append(record)
  if mode=='candidate':
   prefix=out/src.stem
   board=Image.new('RGB',(a.width*2,a.height+32),'#e8e8e8');draw=ImageDraw.Draw(board);draw.text((12,8),'Official 687f282',fill='black');draw.text((a.width+12,8),'qi-agent candidate',fill='black');board.paste(a,(0,32));board.paste(b,(a.width,32));board.save(str(prefix)+'-side-by-side.png')
   Image.blend(a,b,.5).save(str(prefix)+'-overlay.png')
   diff=ImageChops.difference(a,b);diff=diff.point(lambda n:min(255,n*4));diff.save(str(prefix)+'-diff-x4.png')
(root/'comparison/metrics.json').write_text(json.dumps({'method':'Exact RGB equality and nonzero pixels, RGB MAE and percent of pixels with maximum channel delta >16; original full viewport, no excluded pixels. Delta >16 is diagnostic, not an acceptance threshold. Diff visualization multiplied by4 only; metrics use unamplified data.','pairs':rows},indent=2)+'\n')
print(json.dumps([r for r in rows if r['name'] in ['new-session-light-1440','new-session-light-390','settings-light-1440','conversation-light-1440']],indent=2))
