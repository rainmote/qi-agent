import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordDependencyLocks, selectDependencyCache } from '../image/dependency-cache.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qi-cache-pairs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache'), work = path.join(root, 'work');
  await mkdir(path.join(work, 'apps/tui-rs'), { recursive: true });
  async function setLocks(npm, cargo) {
    await writeFile(path.join(work, 'package-lock.json'), npm);
    await writeFile(path.join(work, 'apps/tui-rs/Cargo.lock'), cargo);
  }
  for (const name of ['current', 'baseline']) {
    const slot = path.join(cache, name);
    for (const dir of ['node_modules', 'target', 'browsers']) {
      await mkdir(path.join(slot, dir), { recursive: true });
      await writeFile(path.join(slot, dir, 'identity'), name);
    }
    await setLocks(`${name}-npm`, `${name}-cargo`);
    await recordDependencyLocks(work, slot);
  }
  return { root, cache, work, setLocks };
}

test('different baseline/current npm locks select their own complete dependency closures', async t => {
  const f = await fixture(t);
  for (const name of ['baseline', 'current']) {
    await f.setLocks(`${name}-npm`, `${name}-cargo`);
    const slot = await selectDependencyCache(f.work, f.cache);
    assert.equal(slot, path.join(f.cache, name));
    for (const dir of ['node_modules', 'target', 'browsers']) {
      assert.equal(await readFile(path.join(slot, dir, 'identity'), 'utf8'), name);
    }
  }
});

test('mixed and unreviewed lock pairs fail before the requested command executes', async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../image/dependency-cache.mjs', import.meta.url));
  for (const [npm, cargo] of [['current-npm', 'baseline-cargo'], ['baseline-npm', 'current-cargo'], ['unknown', 'current-cargo']]) {
    await f.setLocks(npm, cargo);
    const r = spawnSync('sh', ['-ec', '"$1" "$2" select "$3" "$4"; echo UNREVIEWED_COMMAND_STARTED', 'fixture', process.execPath, cli, f.work, f.cache], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Dependency lock pair does not match/);
    assert.ok(!r.stdout.includes('UNREVIEWED_COMMAND_STARTED'));
  }
});

test('missing locks, incomplete slots and malformed manifests are never admitted', async t => {
  const f = await fixture(t);
  await f.setLocks('current-npm', 'current-cargo');
  await rm(path.join(f.cache, 'current/browsers'), { recursive: true });
  await assert.rejects(selectDependencyCache(f.work, f.cache));
  await writeFile(path.join(f.cache, 'current/locks.json'), '{broken');
  await assert.rejects(selectDependencyCache(f.work, f.cache));
  await rm(path.join(f.work, 'package-lock.json'));
  await assert.rejects(selectDependencyCache(f.work, f.cache));
});

test('the shipped entrypoint wires the selected slot to npm, Rust and Chromium', () => {
  const entry = fileURLToPath(new URL('../image/entrypoint.sh', import.meta.url));
  execFileSync('sh', ['-n', entry]);
  // Wiring is covered in addition to actual selection/negative execution above.
  return readFile(entry, 'utf8').then(source => {
    assert.match(source, /select \/work \/opt\/qi-cache/);
    for (const part of ['PLAYWRIGHT_BROWSERS_PATH="$slot/browsers"', '"$slot/node_modules"', '"$slot/target/."']) assert.ok(source.includes(part));
  });
});

test('supervisor dependencies are bound when present and cannot be injected into an old baseline', async t => {
  const f = await fixture(t);
  await f.setLocks('current-npm', 'current-cargo');
  await mkdir(path.join(f.work, 'apps/desktop/supervisor'), { recursive: true });
  await writeFile(path.join(f.work, 'apps/desktop/supervisor/Cargo.lock'), 'supervisor-lock');
  await assert.rejects(selectDependencyCache(f.work, f.cache), /Dependency lock pair/);
  const slot = path.join(f.cache, 'current');
  await rm(path.join(slot, 'locks.json'));
  await recordDependencyLocks(f.work, slot);
  await assert.rejects(selectDependencyCache(f.work, f.cache));
  await mkdir(path.join(slot, 'supervisor-target'));
  assert.equal(await selectDependencyCache(f.work, f.cache), slot);
  await writeFile(path.join(f.work, 'apps/desktop/supervisor/Cargo.lock'), 'changed-supervisor');
  await assert.rejects(selectDependencyCache(f.work, f.cache), /Dependency lock pair/);
  await rm(path.join(f.work, 'apps/desktop/supervisor/Cargo.lock'));
  await assert.rejects(selectDependencyCache(f.work, f.cache), /Dependency lock pair/);
  await f.setLocks('baseline-npm', 'baseline-cargo');
  assert.equal(await selectDependencyCache(f.work, f.cache), path.join(f.cache, 'baseline'));
});
