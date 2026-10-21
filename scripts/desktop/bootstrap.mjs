import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = join(repo, 'apps/desktop');
const sources = JSON.parse(await readFile(join(desktop, 'runtime-sources.json'), 'utf8'));
const cache = resolve(process.env.QI_DESKTOP_CACHE || join(repo, '.cache/desktop'));
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Only macOS arm64 is implemented and validated by this build path');
await mkdir(cache, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');

async function download(url, name, expected, limit) {
  const path = join(cache, name);
  try { if (hash(await readFile(path)) === expected) return; } catch {}
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || !['nodejs.org', 'raw.githubusercontent.com'].includes(endpoint.hostname)) throw new Error('Unapproved runtime source');
  const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Runtime download failed: ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Runtime download limit exceeded');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (hash(bytes) !== expected) throw new Error(`Runtime checksum mismatch: ${name}`);
  const temporary = `${path}.partial`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
}

await download(sources.node.url, sources.node.archive, sources.node.sha256, 200_000_000);
await download(sources.babashka.license_url, 'babashka-LICENSE', sources.babashka.license_sha256, 1_000_000);
const cli = join(desktop, '.tools/bin/cargo-tauri');
const version = spawnSync(cli, ['--version'], { encoding: 'utf8' });
if (version.status !== 0 || !version.stdout.includes('2.12.3')) {
  const result = spawnSync('cargo', ['install', 'tauri-cli', '--version', '=2.12.3', '--locked', '--root', join(desktop, '.tools')],
    { cwd: repo, stdio: 'inherit', env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: '/tmp',
      CARGO_HOME: process.env.CARGO_HOME || join(desktop, '.cache/cargo'), CARGO_HTTP_TIMEOUT: '20', CARGO_NET_RETRY: '0' } });
  if (result.status !== 0) throw new Error('Project-local Tauri CLI installation failed; no alternate registry or global install attempted');
}
console.log(`Verified build sources in ${cache}; project-local Tauri CLI 2.12.3. No application was started.`);
