import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { commitSHA } from './github.mjs';

export const TARGETS = ['linux-x86_64', 'linux-aarch64', 'macos-x86_64', 'macos-aarch64'];

export async function checkAssets({ directory, tag, sha }) {
  commitSHA(sha);
  if (!/^v[0-9][A-Za-z0-9.+-]*$/.test(tag ?? '')) throw new Error('Invalid version tag');
  const names = TARGETS.map((target) => `qi-agent-${tag}-${target}.tar.gz`);
  const entries = await fs.readdir(directory);
  const archives = entries.filter((name) => name.endsWith('.tar.gz')).sort();
  if (JSON.stringify(archives) !== JSON.stringify([...names].sort())) throw new Error('Release archive set is incomplete or unexpected');
  const lines = [];
  for (const name of names) {
    const archive = path.join(directory, name);
    for (const file of [archive, archive + '.sha256', archive + '.source.json']) {
      if (!(await fs.lstat(file)).isFile()) throw new Error('Release asset must be a regular file');
    }
    const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
    if ((await fs.readFile(archive + '.sha256', 'utf8')).trim() !== `${digest}  ${name}`) throw new Error('Release checksum mismatch: ' + name);
    const source = JSON.parse(await fs.readFile(archive + '.source.json', 'utf8'));
    if (source.sha !== sha || source.tag !== tag || source.asset !== name || source.sha256 !== digest) throw new Error('Release source manifest mismatch: ' + name);
    lines.push(`${digest}  ${name}`);
  }
  return { status: 'PASS', sha, tag, assets: names, checksums: lines.join('\n') + '\n' };
}
