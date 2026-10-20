"""Freeze an inventory or record post-commit checks without changing product/Git."""
import datetime, hashlib, json, shutil, subprocess, sys
from pathlib import Path
task = Path(__file__).resolve().parent.parent
repo = task / 'qi-agent'
out = repo / 'docs/ui-harness-followup-20261020'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
freeze = json.loads((out / 'tested-source.json').read_text())
for group in ('ui_source_files', 'built_artifacts', 'runtime_and_contracts'):
    for rel, digest in freeze[group].items(): assert sha(repo / rel) == digest, (group, rel)
mode = sys.argv[1]
if mode == 'precommit':
    assert (out / 'readonly-review.md').is_file()
    gallery = json.loads((out / 'gallery/results.json').read_text())
    assert gallery['states'] == 28 and gallery['pageErrors'] == []
    assert gallery['html_sha256'] == sha(out / 'index.html')
    shutil.copy2(Path(__file__), out / 'scripts/finish-followup-evidence.py')
    files = {str(p.relative_to(out)): sha(p) for p in sorted(out.rglob('*'))
             if p.is_file() and p.name != 'evidence-sha256.json'}
    (out / 'evidence-sha256.json').write_text(json.dumps({'algorithm': 'sha256', 'excludes_self': True,
        'files': files}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'mode': mode, 'files': len(files), 'product_fingerprints_match': True,
                     'strict_pixel_acceptance': 'blocked'}))
elif mode == 'postcommit':
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    commit_time = int(subprocess.check_output(['git', 'show', '-s', '--format=%ct', 'HEAD'], cwd=repo, text=True).strip())
    assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True).strip()
    dest = task / 'pixel-followup-20261020/postcommit'; dest.mkdir(exist_ok=True)
    checks = []
    for name in ('followup-postcommit-browser', 'followup-postcommit-real-e2e'):
        meta = json.loads((task / f'evidence/logs/{name}.json').read_text())
        assert meta['status'] == 'completed' and meta['exit_code'] == 0, (name, meta)
        assert datetime.datetime.fromisoformat(meta['start']).timestamp() >= commit_time
        for ext in ('log', 'json'): shutil.copy2(task / f'evidence/logs/{name}.{ext}', dest / f'{name}.{ext}')
        checks.append({'name': name, **meta})
    rows = []
    for line in (dest / 'followup-postcommit-browser.log').read_text().splitlines():
        if line.startswith('{'):
            try: rows.append(json.loads(line))
            except ValueError: pass
    assert any(r.get('draftFilesEntry') == 'passed' for r in rows)
    assert any(r.get('bootstrapHistoryRace') == 'passed' for r in rows)
    assert {r['target'] for r in rows if r.get('bootstrapLateOpen') == 'passed'} == {'A', 'B'}
    assert any(r.get('bootstrapInvalidRoute') == 'passed' for r in rows)
    assert {r['width'] for r in rows if r.get('browserHistory') == 'passed'} == {1440, 390}
    assert any(r.get('pageErrors') == [] for r in rows)
    receipt = {'tested_commit': commit, 'recorded_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'result': 'passed', 'strict_pixel_acceptance': 'blocked', 'checks': checks, 'browser_results': rows,
        'ui_source_files_unchanged': len(freeze['ui_source_files']), 'built_artifacts_unchanged': len(freeze['built_artifacts']),
        'runtime_and_contracts_unchanged': len(freeze['runtime_and_contracts']),
        'tested_source_manifest_sha256': sha(out / 'tested-source.json'),
        'evidence_inventory_sha256': sha(out / 'evidence-sha256.json'),
        'scope': 'Post-commit full browser regression and real offline Host/daemon/worker E2E; no product or committed evidence mutation.'}
    (dest / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    screenshots = dest / 'screenshots'; screenshots.mkdir(exist_ok=True)
    for folder in ('e2e', 'regressions'):
        for p in (task / 'evidence/after' / folder).glob('*.png'): shutil.copy2(p, screenshots / p.name)
    print(json.dumps({'mode': mode, 'tested_commit': commit, 'receipt': str(dest / 'receipt.json'),
                     'product_fingerprints_match': True, 'strict_pixel_acceptance': 'blocked'}))
else:
    raise ValueError(mode)
