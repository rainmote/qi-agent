#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './lib/execution.mjs';
import { durableWrite, encode } from './lib/store.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error('Usage: node maintenance/build-image.mjs ABS_REPORT.json');
if (git(repo, 'status', '--porcelain')) throw new Error('Commit the reviewed image recipe before building');
const sha = git(repo, 'rev-parse', 'HEAD');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-image-'));
try {
  const archive = execFileSync('git', ['-C', repo, 'archive', sha], { maxBuffer: 128 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', directory], { input: archive });
  execFileSync('docker', ['build', '--progress=plain', '--iidfile', path.join(directory, 'image.id'), '-f', 'maintenance/image/Dockerfile', '.'],
    { cwd: directory, stdio: 'inherit' });
  const image = (await fs.readFile(path.join(directory, 'image.id'), 'utf8')).trim();
  const details = JSON.parse(execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }))[0];
  await durableWrite(destination, encode({ schema_version: 1, image, source_sha: sha, platform: details.Os + '/' + details.Architecture,
    created_at: new Date().toISOString(), status: 'BUILT', validation: 'NOT_RUN' }));
  console.log(encode({ image, report: destination }));
} catch (error) {
  await durableWrite(destination, encode({ schema_version: 1, source_sha: sha, status: 'FAILED', validation: 'NOT_RUN',
    reason: error.message, created_at: new Date().toISOString() }));
  throw error;
} finally { await fs.rm(directory, { recursive: true, force: true }); }
