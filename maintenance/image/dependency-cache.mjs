import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const lockFiles = ['package-lock.json', 'apps/tui-rs/Cargo.lock'];
const supervisorLock = 'apps/desktop/supervisor/Cargo.lock';
async function locks(workspace) {
  const result = Object.fromEntries(await Promise.all(lockFiles.map(async file =>
    [file, createHash('sha256').update(await readFile(path.join(workspace, file))).digest('hex')])));
  try { result[supervisorLock] = createHash('sha256').update(await readFile(path.join(workspace, supervisorLock))).digest('hex'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; result[supervisorLock] = null; }
  return result;
}

export async function recordDependencyLocks(workspace, slot) {
  await writeFile(path.join(slot, 'locks.json'), JSON.stringify(await locks(workspace)) + '\n', { flag: 'wx' });
}

// Both slots are baked into the immutable image. Never choose npm, Rust or
// Chromium independently: the complete lock set (including optional supervisor) selects one dependency set.
export async function selectDependencyCache(workspace, cache) {
  const actual = await locks(workspace);
  for (const name of ['current', 'baseline']) {
    const slot = path.join(cache, name);
    let expected;
    try { expected = JSON.parse(await readFile(path.join(slot, 'locks.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (Object.keys(expected).length !== lockFiles.length + 1 ||
        ![...lockFiles, supervisorLock].every(file => expected[file] === actual[file])) continue;
    const directories = ['node_modules', 'target', 'browsers', ...(actual[supervisorLock] ? ['supervisor-target'] : [])];
    for (const directory of directories) {
      if (!(await stat(path.join(slot, directory))).isDirectory()) throw new Error('Incomplete dependency cache slot');
    }
    return slot;
  }
  throw new Error('Dependency lock pair does not match a reviewed image source');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, workspace, cache] = process.argv.slice(2);
  if (!['record', 'select'].includes(mode) || !path.isAbsolute(workspace ?? '') || !path.isAbsolute(cache ?? '')) {
    throw new Error('Usage: dependency-cache.mjs record|select ABS_WORKSPACE ABS_CACHE');
  }
  if (mode === 'record') await recordDependencyLocks(workspace, cache);
  else console.log(await selectDependencyCache(workspace, cache));
}
