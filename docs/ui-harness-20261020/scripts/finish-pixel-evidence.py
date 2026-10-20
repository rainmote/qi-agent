"""Bind saved evidence to product files; never starts services or changes Git state."""
import datetime
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

task = Path(__file__).resolve().parent.parent
repo = task / 'qi-agent'
out = repo / 'docs/ui-harness-20261020'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
mode = sys.argv[1]
assert mode in ('precommit', 'postcommit')
freeze = json.loads((out / 'tested-source.json').read_text())
for group in ('ui_source_files', 'built_artifacts', 'runtime_and_contracts'):
    for relative, expected in freeze[group].items():
        assert sha(repo / relative) == expected, (group, relative, 'changed since evidence freeze')

if mode == 'precommit':
    meta = json.loads((task / 'evidence/logs/pixel-gallery.json').read_text())
    assert meta['exit_code'] == 0
    gallery = json.loads((task / 'pixel-20261020/gallery/results.json').read_text())
    assert gallery['html_sha256'] == sha(out / 'index.html')
    assert gallery['states'] == 26 and gallery['pageErrors'] == []
    shutil.copytree(task / 'pixel-20261020/gallery', out / 'gallery', dirs_exist_ok=True)
    for ext in ('json', 'log'):
        shutil.copy2(task / f'evidence/logs/pixel-gallery.{ext}', out / f'checks/pixel-gallery.{ext}')
    index = json.loads((out / 'checks/index.json').read_text())
    index = [row for row in index if row['name'] != 'pixel-gallery'] + [{'name': 'pixel-gallery', **meta}]
    (out / 'checks/index.json').write_text(json.dumps(index, indent=2) + '\n')
else:
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    commit_time = int(subprocess.check_output(['git', 'show', '-s', '--format=%ct', 'HEAD'], cwd=repo, text=True).strip())
    post = task / 'pixel-20261020/postcommit'
    post.mkdir(exist_ok=True)
    checks = []
    for name in ('pixel-postcommit-browser-regressions', 'pixel-postcommit-real-e2e'):
        meta = json.loads((task / f'evidence/logs/{name}.json').read_text())
        assert meta['exit_code'] == 0, (name, meta)
        assert datetime.datetime.fromisoformat(meta['start']).timestamp() >= commit_time, (name, 'not post-commit')
        for ext in ('json', 'log'):
            shutil.copy2(task / f'evidence/logs/{name}.{ext}', post / f'{name}.{ext}')
        checks.append({'name': name, **meta})
    records = []
    for line in (post / 'pixel-postcommit-browser-regressions.log').read_text().splitlines():
        if line.startswith('{'):
            try:
                records.append(json.loads(line))
            except ValueError:
                pass
    assert any(row.get('bootstrapHistoryRace') == 'passed' for row in records)
    assert {row['target'] for row in records if row.get('bootstrapLateOpen') == 'passed'} == {'A', 'B'}
    assert any(row.get('bootstrapInvalidRoute') == 'passed' for row in records)
    assert {row['width'] for row in records if row.get('browserHistory') == 'passed'} == {1440, 390}
    assert {row['width'] for row in records if row.get('presetMenu') == 'passed'} == {1440, 320}
    assert any(row.get('pageErrors') == [] for row in records)
    receipt = {'tested_commit': commit, 'recorded_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'result': 'passed', 'strict_pixel_acceptance': 'blocked',
        'ui_source_files_unchanged': len(freeze['ui_source_files']),
        'built_artifacts_unchanged': len(freeze['built_artifacts']),
        'runtime_and_contracts_unchanged': len(freeze['runtime_and_contracts']),
        'checks': checks, 'browser_results': records,
        'frozen_evidence_inventory_sha256': sha(out / 'evidence-sha256.json'),
        'tested_source_manifest_sha256': sha(out / 'tested-source.json'),
        'scope': 'Full browser regression including reload-immediate-Back startup races, menus, duplicate clicks, cancellation, return and mobile; real offline Host/daemon/Worker E2E. Receipt is saved outside Git after the final commit so neither product nor committed evidence is changed.'}
    (post / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    screenshots = post / 'screenshots'
    screenshots.mkdir(exist_ok=True)
    for subdir, patterns in [('regressions', ['browser-history-return-*.png', 'run-outcomes-*.png']), ('e2e', ['composer-*.png'])]:
        for pattern in patterns:
            for p in (task / 'evidence/after' / subdir).glob(pattern):
                shutil.copy2(p, screenshots / p.name)
    print(json.dumps({'mode': mode, 'tested_commit': commit, 'receipt': str(post / 'receipt.json'),
        'product_fingerprints_match': True, 'strict_pixel_acceptance': 'blocked'}))
    sys.exit(0)

files = {str(p.relative_to(out)): sha(p) for p in sorted(out.rglob('*'))
         if p.is_file() and p.name != 'evidence-sha256.json'}
(out / 'evidence-sha256.json').write_text(json.dumps({'algorithm': 'sha256', 'excludes_self': True,
    'files': files}, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'mode': mode, 'files': len(files), 'product_fingerprints_match': True,
    'strict_pixel_acceptance': 'blocked'}))
