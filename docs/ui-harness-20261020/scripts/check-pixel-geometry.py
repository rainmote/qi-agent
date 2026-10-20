"""Replay measured official card geometry against frozen baseline or candidate."""
import json, sys
from pathlib import Path
root=Path(sys.argv[2]).resolve() if len(sys.argv)>2 else Path(__file__).resolve().parent.parent/'pixel-20261020'
mode=sys.argv[1]
assert mode in ('baseline','candidate')
cases=[]
for width in (1440,1024,768,390,320):
 name=f'new-session-light-{width}'
 ref=json.loads((root/'reference'/f'{name}.json').read_text())
 actual=json.loads((root/mode/f'{name}.json').read_text())
 a=next(e['box'] for e in ref['elements'] if e['class']=='pbVuNW_card')
 b=next(e['box'] for e in actual['elements'] if 'composer' in str(e['class']).split())
 differences={k:round(b[k]-a[k],6) for k in ('x','y','width','height')}
 cases.append({'name':name,'official':a,'actual':b,'delta_css_px':differences,'passed':all(abs(v)<0.1 for v in differences.values())})
result={'mode':mode,'reference_sha':'687f282e8625c6b8d11ff58211a90524be2e4317','baseline_sha':'315860136df47f896ad61268ff29b408c2103351','tolerance_css_px':0.1,'passed':all(c['passed'] for c in cases),'cases':cases}
(root/f'geometry-{mode}.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
sys.exit(0 if result['passed'] else 1)
