#!/usr/bin/env node
// Real offline containers; fixture/oracle plumbing evidence, never a model score.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { git, containerCommand, immutableImage } from './lib/execution.mjs';
import { lockStore, encode, durableWrite } from './lib/store.mjs';
import { prepare, implement } from './lib/controller.mjs';

const controller = fileURLToPath(new URL('..', import.meta.url));
const image = immutableImage(process.env.QI_MAINTENANCE_IMAGE);
const output = process.env.QI_MAINTENANCE_OUTPUT ?? await fs.mkdtemp(path.join(os.tmpdir(), 'qi-maint-container-'));
await fs.mkdir(output, { recursive: true });
const policy = JSON.parse(await fs.readFile(new URL('policy.json', import.meta.url)));
const results = [];
for (const agent of ['nop', 'oracle']) {
  const directory = path.join(output, agent);
  await fs.mkdir(directory); // Never overwrite earlier trial evidence.
  const repo = path.join(directory, 'repo'), root = path.join(directory, 'state'), verifier = path.join(directory, 'verifier');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true }); await fs.mkdir(verifier);
  await fs.writeFile(path.join(repo, 'src/value.mjs'), 'export const value = 1;\n');
  git(repo, 'init', '-b', 'main'); git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'isolated fixture');
  const sha = git(repo, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(directory, 'agent.edn'), '{:plugins []}\n');
  await fs.writeFile(path.join(verifier, 'acceptance.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
const {value} = await import('file:///work/src/value.mjs');
test('value is repaired', () => assert.equal(value, 2));\n`);
  const task = { schema_version: 1, task_id: 'container-' + agent, kind: 'bug', goal: 'Repair the fixture value',
    base_sha: sha, image, allowed_files: ['src/value.mjs'], profile_path: path.join(directory, 'agent.edn'), verifier_dir: verifier,
    checks: [{ id: 'syntax', argv: ['node', '--check', 'src/value.mjs'], timeout_seconds: 30 }],
    acceptance: { file: 'acceptance.test.mjs', tests: ['value is repaired'] } };
  const lock = await lockStore(root);
  try {
    await prepare({ repo, root, controller, task, policy, lock });
    const driver = { mode: 'offline', paid: false, unattended: false, argv: agent === 'oracle' ?
      ['node', '-e', "require('node:fs').writeFileSync('src/value.mjs', 'export const value = 2;\\n')"] : ['node', '-e', ''] };
    const result = await implement({ root, id: task.task_id, lock, driver });
    assert.equal(result.status === 'review_ready', agent === 'oracle', encode(result));
    assert.equal(await fs.readFile(path.join(repo, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
    results.push({ agent, task_id: task.task_id, status: result.status, reason: result.reason ?? null,
      candidate_sha: result.candidate_sha ?? null, controller_sha: result.controller_sha, image,
      baseline_and_red: result.checks?.filter((check) => check.phase !== 'candidate'), evidence: result.evidence ?? null,
      cost_usd: null, model_calls: 0, mode: 'offline_fixture', state_directory: root });
  } finally { await lock.close(); }
}
const containment = await containerCommand({ image, workspace: path.join(output, 'oracle/repo'), readonly: true,
  argv: ['node', '-e', `const fs=require('node:fs'); try { fs.writeFileSync('/inputs/src/value.mjs','tampered'); process.exit(2); } catch(e) { if(!['EROFS','EACCES'].includes(e.code)) throw e; }`], timeoutMs: 10_000 });
assert.equal(containment.exit_code, 0, containment.stderr);
const timeout = await containerCommand({ image, workspace: path.join(output, 'oracle/repo'), readonly: true,
  argv: ['node', '-e', 'setInterval(()=>{},1000)'], timeoutMs: 1200 });
assert.equal(timeout.timed_out, true);
const pauseAt = Date.now() + 700;
const paused = await containerCommand({ image, workspace: path.join(output, 'oracle/repo'), readonly: true,
  argv: ['node', '-e', 'setInterval(()=>{},1000)'], timeoutMs: 10_000, shouldStop: async () => Date.now() >= pauseAt });
assert.equal(paused.timed_out, false, 'pause must stop the container before its command timeout');
assert.notEqual(paused.exit_code, 0);
const report = { schema_version: 1, status: 'PASS', results, readonly_input: 'PASS', container_timeout_cleanup: 'PASS',
  container_pause_cleanup: 'PASS',
  note: 'Real Docker nop/oracle and isolation smoke only; not Harbor integration or a model benchmark.' };
await durableWrite(path.join(output, 'report.json'), encode(report));
console.log(encode({ ...report, output }));
