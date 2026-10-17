#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, snapshot } from './lib/execution.mjs';
import { durableWrite, encode } from './lib/store.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const destination = process.argv[2];
const baseline = process.argv[3] ?? null;
if (!destination || !path.isAbsolute(destination) || (baseline && !/^[a-f0-9]{40}$/.test(baseline))) {
  throw new Error('Usage: node maintenance/build-image.mjs ABS_REPORT.json [EXACT_BASELINE_SHA]');
}
if (git(repo, 'status', '--porcelain')) throw new Error('Commit the reviewed image recipe before building');
const sha = git(repo, 'rev-parse', 'HEAD');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-image-'));
try {
  await snapshot(repo, sha, directory);
  if (baseline) {
    const seed = path.join(directory, '.qi-image-baseline');
    await snapshot(repo, baseline, seed);
    if (!(await fs.readFile(path.join(seed, 'package-lock.json'))).equals(await fs.readFile(path.join(directory, 'package-lock.json')))) {
      throw new Error('Baseline npm lock differs; build a separate image with its exact Node dependencies');
    }
  }
  execFileSync('docker', ['build', '--progress=plain', '--iidfile', path.join(directory, 'image.id'), '-f', 'maintenance/image/Dockerfile', '.'],
    { cwd: directory, stdio: 'inherit' });
  const image = (await fs.readFile(path.join(directory, 'image.id'), 'utf8')).trim();
  const details = JSON.parse(execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }))[0];
  await durableWrite(destination, encode({ schema_version: 1, image, source_sha: sha, baseline_sha: baseline, platform: details.Os + '/' + details.Architecture,
    created_at: new Date().toISOString(), status: 'BUILT', validation: 'NOT_RUN' }));
  console.log(encode({ image, report: destination }));
} catch (error) {
  await durableWrite(destination, encode({ schema_version: 1, source_sha: sha, baseline_sha: baseline, status: 'FAILED', validation: 'NOT_RUN',
    reason: error.message, created_at: new Date().toISOString() }));
  throw error;
} finally { await fs.rm(directory, { recursive: true, force: true }); }
