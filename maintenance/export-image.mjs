#!/usr/bin/env node
// Export only an exact image whose offline verification has passed. No registry
// publication, model credential or provider qualification is implied.
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './lib/execution.mjs';
import { durableWrite, encode } from './lib/store.mjs';
import { verifiedImageBundle } from './lib/image-bundle.mjs';

const [evidence, destination] = process.argv.slice(2);
if (![evidence, destination].every((p) => path.isAbsolute(p ?? ''))) throw new Error('Usage: node maintenance/export-image.mjs ABS_EVIDENCE_ROOT ABS_NEW_BUNDLE');
const repo = fileURLToPath(new URL('..', import.meta.url));
if (git(repo, 'status', '--porcelain')) throw new Error('Image export requires a clean checkout');
const names = ['qi-image.json', 'qi-container-evidence/report.json', 'qi-broker-evidence/report.json', 'qi-worker-evidence/report.json'];
const reports = await Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(evidence, name), 'utf8'))));
const manifest = verifiedImageBundle(git(repo, 'rev-parse', 'HEAD'), ...reports);
await fs.mkdir(destination);
const archive = path.join(destination, 'qi-toolchain.tar.gz');
const child = spawn('docker', ['image', 'save', manifest.image], { stdio: ['ignore', 'pipe', 'inherit'] });
const exited = new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error('Docker image export failed: ' + (signal ?? code))));
});
try {
  await Promise.all([exited, pipeline(child.stdout, createGzip({ level: 1 }), createWriteStream(archive + '.part', { flags: 'wx', mode: 0o600 }))]);
} catch (error) { child.kill('SIGTERM'); await exited.catch(() => {}); throw error; }
await fs.rename(archive + '.part', archive);
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
manifest.archive = { file: 'qi-toolchain.tar.gz', sha256: hash.digest('hex'), bytes: (await fs.stat(archive)).size };
manifest.created_at = new Date().toISOString();
await durableWrite(path.join(destination, 'manifest.json'), encode(manifest));
for (let i = 0; i < reports.length; i++) await durableWrite(path.join(destination, ['image.json', 'verification.json', 'broker.json', 'worker.json'][i]), encode(reports[i]));
console.log(encode(manifest));
