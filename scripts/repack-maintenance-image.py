"""Repackage an exact, already verified CI artifact; never rebuild its image."""
import hashlib, json, os, re, subprocess, zipfile
from pathlib import Path

artifact_id=os.environ['QI_TRANSFER_ARTIFACT']
expected_digest=os.environ['QI_TRANSFER_SHA256']
expected_source=os.environ['QI_TRANSFER_SOURCE']
assert re.fullmatch(r'[0-9]+',artifact_id)
assert re.fullmatch(r'[a-f0-9]{64}',expected_digest)
assert re.fullmatch(r'[a-f0-9]{40}',expected_source)
root=Path(os.environ['RUNNER_TEMP'])/'qi-transfer';root.mkdir()
archive=root/'original.zip'
with archive.open('xb') as out:
    subprocess.run(['gh','api',f'/repos/{os.environ["GITHUB_REPOSITORY"]}/actions/artifacts/{artifact_id}/zip'],stdout=out,check=True)
def digest(p):
    h=hashlib.sha256()
    with p.open('rb') as inp:
        while data:=inp.read(4*1024*1024):h.update(data)
    return h.hexdigest()
assert digest(archive)==expected_digest
bundle=root/'bundle';bundle.mkdir()
allowed={'manifest.json','image.json','verification.json','broker.json','worker.json','qi-toolchain.tar.gz'}
with zipfile.ZipFile(archive) as z:
    assert len(z.infolist())==len(allowed) and set(z.namelist())==allowed
    for info in z.infolist():
        assert not info.is_dir() and info.file_size<2*1024**3
        with z.open(info) as inp,(bundle/info.filename).open('xb') as out:
            while data:=inp.read(4*1024*1024):out.write(data)
m=json.loads((bundle/'manifest.json').read_text())
assert m['source_sha']==expected_source and m['verification']=='CI_OFFLINE_VERIFIED'
assert m['platform']=='linux/arm64' and m['live_model_qualification']=='NOT_RUN'
p=bundle/'qi-toolchain.tar.gz'
assert p.stat().st_size==m['archive']['bytes'] and digest(p)==m['archive']['sha256']
assert p.stat().st_size<=3*400*1024**2
metadata=root/'metadata';metadata.mkdir()
for name in allowed-{'qi-toolchain.tar.gz'}:(metadata/name).write_bytes((bundle/name).read_bytes())
parts=[]
with p.open('rb') as inp:
    for number in range(3):
        directory=root/f'part{number:02d}';directory.mkdir()
        target=directory/f'qi-toolchain.part{number:02d}'
        remaining=400*1024**2;size=0;h=hashlib.sha256()
        with target.open('xb') as out:
            while remaining:
                data=inp.read(min(4*1024**2,remaining))
                if not data:break
                out.write(data);h.update(data);remaining-=len(data);size+=len(data)
        parts.append({'file':target.name,'bytes':size,'sha256':h.hexdigest()})
    assert not inp.read(1)
receipt={'source_sha':expected_source,'image':m['image'],'original_artifact_id':int(artifact_id),'original_zip_sha256':expected_digest,'archive':m['archive'],'parts':parts,'image_rebuilt':False}
(metadata/'transfer.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
