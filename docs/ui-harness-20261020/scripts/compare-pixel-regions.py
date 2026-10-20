"""Component diagnostics supplement the full, unmasked viewport comparison."""
import json, math, sys
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'pixel-20261020'
out = root / 'comparison' / 'regions'
out.mkdir(exist_ok=True)
rows = []

def add(name, region, box, actual=None):
    x, y, w, h = (box[k] for k in ('x', 'y', 'width', 'height'))
    crop = (math.floor(x), math.floor(y), math.ceil(x + w), math.ceil(y + h))
    a = Image.open(root / 'reference' / (name + '.png')).convert('RGB').crop(crop)
    b = Image.open(root / 'candidate' / (name + '.png')).convert('RGB').crop(crop)
    delta = ImageChops.difference(a, b)
    pixels = list(delta.getdata())
    nonzero = sum(max(p) > 0 for p in pixels)
    row = {'state': name, 'region': region, 'source_box_css_px': box, 'raster_box': crop,
           'pixels': len(pixels), 'nonzero': nonzero, 'exact_equal': nonzero == 0,
           'max_channel_delta': max(max(p) for p in pixels),
           'pixels_gt16': sum(max(p) > 16 for p in pixels)}
    if actual:
        row['geometry_delta_css_px'] = {k: round(actual[k] - box[k], 6) for k in box}
    rows.append(row)
    board = Image.new('RGB', (a.width * 2, a.height * 2 + 40), '#ededed')
    draw = ImageDraw.Draw(board)
    draw.text((4, 3), 'Official', fill='black')
    draw.text((a.width + 4, 3), 'Candidate', fill='black')
    board.paste(a, (0, 20)); board.paste(b, (a.width, 20))
    board.paste(delta.point(lambda v: min(255, v * 4)), (a.width // 2, a.height + 40))
    board.save(out / (name + '-' + region + '.png'))

for p in sorted((root / 'reference').glob('new-session-*.json')):
    name = p.stem
    ref = json.loads(p.read_text())['elements']
    candidate = json.loads((root / 'candidate' / p.name).read_text())['elements']
    for region, left, right in (
        ('input-card', lambda e: e['class'] == 'pbVuNW_card', lambda e: 'composer' in str(e['class']).split()),
        ('title-and-badge', lambda e: 'titleGroup' in str(e['class']), lambda e: e['class'] == 'welcome-title-group'),
        ('workspace-chip', lambda e: e['class'] == 'BzFq3G_workspace', lambda e: e['class'] == 'workspace-context-select'),
        ('preset-chip', lambda e: e['class'] == 'd6Wyeq_seat', lambda e: e['class'] == 'preset-trigger'),
    ):
        a = next(e['box'] for e in ref if left(e))
        b = next(e['box'] for e in candidate if right(e))
        add(name, region, a, b)
    if '1440' in name or '1024' in name:
        add(name, 'session-list', {'x': 12, 'y': 282, 'width': 256, 'height': 100})

for name in ('permission-menu-light-1440', 'workspace-menu-light-1440', 'model-menu-light-1440',
             'model-options-light-1440', 'model-options-light-390', 'model-options-light-320'):
    ref = json.loads((root / 'reference' / (name + '.json')).read_text())['elements']
    candidate = json.loads((root / 'candidate' / (name + '.json')).read_text())['elements']
    a = next(e['box'] for e in ref if str(e['class']).startswith('_surface_'))
    b = next(e['box'] for e in candidate if 'composer-popover' in str(e['class']).split())
    add(name, 'menu', a, b)

for name in ('settings-light-1440', 'settings-dark-1440'):
    ref = json.loads((root / 'reference' / (name + '.json')).read_text())['elements']
    candidate = json.loads((root / 'candidate' / (name + '.json')).read_text())['elements']
    for text, region in (('浅色', 'appearance-light'), ('深色', 'appearance-dark'), ('跟随系统', 'appearance-system')):
        a = next(e['box'] for e in ref if e['tag'] == 'BUTTON' and e['text'] == text)
        b = next(e['box'] for e in candidate if e['tag'] == 'BUTTON' and e['text'] == text)
        add(name, region, a, b)
    a = next(e['box'] for e in ref if 'stepper' in str(e['class']))
    b = next(e['box'] for e in candidate if e['class'] == 'content-font-stepper')
    add(name, 'font-size-stepper', a, b)

(root / 'comparison' / 'regions.json').write_text(json.dumps({
    'method': 'Exact RGB comparison within explicitly listed diagnostic rectangles, using floor/ceil to include partial edge pixels. No region is excluded from the full viewport metrics. These diagnostics do not constitute whole-page acceptance.',
    'reference_sha': '687f282e8625c6b8d11ff58211a90524be2e4317', 'regions': rows,
}, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({'regions': len(rows), 'exact_equal': sum(r['exact_equal'] for r in rows),
                  'residuals': [{k: r[k] for k in ('state', 'region', 'nonzero', 'max_channel_delta')} for r in rows if not r['exact_equal']]}))
