import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { git } from '../lib/execution.mjs';

test('snapshot extracts valid padded tar archives even when tar stops reading before their end', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-snapshot-test-'));
  try {
    const repo = path.join(root, 'repo'), bin = path.join(root, 'bin'), target = path.join(root, 'snapshot');
    await fs.mkdir(repo); await fs.mkdir(bin);
    await fs.writeFile(path.join(repo, 'value.txt'), 'verified source\n');
    git(repo, 'init', '-b', 'main'); git(repo, 'add', '.');
    git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'fixture');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    // Zero padding after tar's end marker is valid. A large trailer makes the
    // early-reader-close race reproducible without sleeps or a fake extractor.
    await fs.writeFile(path.join(bin, 'git'), `#!${process.execPath}\nconst fs=require('node:fs'), cp=require('node:child_process');
const args=process.argv.slice(2), output=args.find(a=>a.startsWith('--output='));
const archive=cp.execFileSync(${JSON.stringify(actualGit)},args.filter(a=>!a.startsWith('--output=')));
const padded=Buffer.concat([archive,Buffer.alloc(4*1024*1024)]);
if(output) fs.writeFileSync(output.slice('--output='.length),padded); else process.stdout.write(padded);\n`, { mode: 0o755 });
    const script = `import {snapshot} from ${JSON.stringify(new URL('../lib/execution.mjs', import.meta.url).href)};
await snapshot(${JSON.stringify(repo)},${JSON.stringify(sha)},${JSON.stringify(target)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.readFile(path.join(target, 'value.txt'), 'utf8'), 'verified source\n');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
