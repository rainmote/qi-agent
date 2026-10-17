import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { compactionOracle, compactionOracleDriver, COMPACTION_ORACLE_FILES, DEFAULT_COMPACTION_ORACLE } from '../lib/compaction-oracle.mjs';

async function fixture(body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-compaction-oracle-'));
  const git = (...argv) => execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'Offline Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    const contents = COMPACTION_ORACLE_FILES.map((file, index) => `;; ${file}\n(identity "literal $() and backticks ${String.fromCharCode(96)} ${index}")\n\n`);
    for (const [index, file] of COMPACTION_ORACLE_FILES.entries()) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), contents[index]); }
    git('add', '.'); git('commit', '-qm', 'known identity oracle'); const sha = git('rev-parse', 'HEAD');
    for (const file of COMPACTION_ORACLE_FILES) await fs.writeFile(path.join(root, file), 'unrelated future lifecycle implementation\n');
    git('add', '.'); git('commit', '-qm', 'new controller head');
    await body({ root, sha, contents, git });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('compaction oracle reads exact committed bytes independently of HEAD and dirty worktree', async () => {
  await fixture(async ({ root, sha, contents }) => {
    await fs.writeFile(path.join(root, COMPACTION_ORACLE_FILES[0]), 'uncommitted unrelated edit\n');
    const oracle = compactionOracle(root, sha);
    assert.equal(oracle.sha, sha); assert.deepEqual(oracle.files.map(row => row.file), COMPACTION_ORACLE_FILES);
    assert.deepEqual(oracle.files.map(row => row.content), contents);
    assert.deepEqual(oracle.files.map(row => row.sha256), contents.map(content => createHash('sha256').update(content).digest('hex')));
  });
});

test('offline compaction driver preserves source bytes using argv without shell evaluation', async () => {
  await fixture(async ({ root, sha, contents }) => {
    const driver = compactionOracleDriver(compactionOracle(root, sha));
    assert.equal(driver.mode, 'offline'); assert.equal(driver.paid, false); assert.equal(driver.unattended, false);
    execFileSync(process.execPath, driver.argv.slice(1), { cwd: root });
    for (const [index, file] of COMPACTION_ORACLE_FILES.entries()) assert.equal(await fs.readFile(path.join(root, file), 'utf8'), contents[index]);
  });
});

test('compaction oracle rejects symbolic refs, non-commit objects and missing source files', async () => {
  await fixture(async ({ root, sha, git }) => {
    assert.match(DEFAULT_COMPACTION_ORACLE, /^[a-f0-9]{40}$/);
    assert.throws(() => compactionOracle(root, 'HEAD'), /exact commit/);
    assert.throws(() => compactionOracle(root, git('rev-parse', `${sha}^{tree}`)), /identify a commit/);
    git('rm', COMPACTION_ORACLE_FILES[1]); git('commit', '-qm', 'missing reference source');
    assert.throws(() => compactionOracle(root, git('rev-parse', 'HEAD')), /Command failed/);
  });
});
