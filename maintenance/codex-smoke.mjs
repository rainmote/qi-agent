#!/usr/bin/env node
// Explicit live subscription smoke, or offline writer fixture; both use real Docker acceptance.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { git, immutableImage } from './lib/execution.mjs';
import { lockStore, encode, durableWrite, readJournal } from './lib/store.mjs';
import { prepare } from './lib/controller.mjs';
import { defaults, codexLoop } from './lib/codex.mjs';

const [mode, output] = process.argv.slice(2);
if (!['--live', '--offline'].includes(mode) || !path.isAbsolute(output ?? '')) throw new Error('Usage: QI_MAINTENANCE_IMAGE=sha256:... node maintenance/codex-smoke.mjs --live|--offline ABS_NEW_OUTPUT');
const live = mode === '--live';
const image = immutableImage(process.env.QI_MAINTENANCE_IMAGE);
const controller = fileURLToPath(new URL('..', import.meta.url));
// Short transport probe: at most three minutes for the writer, two for acceptance.
const policy = { ...JSON.parse(await fs.readFile(new URL('policy.json', import.meta.url))),
  wall_seconds: 300, verification_reserve_seconds: 120 };
await fs.mkdir(output); // A new directory only; preserve earlier evidence.
const repo = path.join(output, 'repo'), root = path.join(output, 'state'), verifier = path.join(output, 'verifier');
await fs.mkdir(path.join(repo, 'src'), { recursive: true }); await fs.mkdir(verifier);
await fs.writeFile(path.join(repo, 'src/math.mjs'), 'export const add = (a, b) => a - b;\n');
git(repo, 'init', '-b', 'main'); git(repo, 'add', '.');
git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Codex development-loop fixture');
const sha = git(repo, 'rev-parse', 'HEAD');
const profile = path.join(output, 'agent.edn'); await fs.writeFile(profile, '{:plugins []}\n');
await fs.writeFile(path.join(verifier, 'acceptance.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from '/work/src/math.mjs';
test('adds positive negative and zero numeric operands', () => {
  assert.equal(add(2, 3), 5); assert.equal(add(-2, 3), 1); assert.equal(add(0, -4), -4);
});\n`);
const task = { schema_version: 1, task_id: 'codex-addition-smoke', kind: 'bug',
  goal: 'Fix src/math.mjs: add(a, b) must return the arithmetic sum of two numeric operands, including negative and zero values. Keep the named export and do not add files.',
  base_sha: sha, image, allowed_files: ['src/math.mjs'], profile_path: profile, verifier_dir: verifier,
  checks: [{ id: 'syntax', argv: ['node', '--check', 'src/math.mjs'], timeout_seconds: 30 }],
  acceptance: { file: 'acceptance.test.mjs', tests: ['adds positive negative and zero numeric operands'] } };
await durableWrite(path.join(output, 'task.json'), encode(task));
const lock = await lockStore(root);
try {
  await prepare({ repo, root, controller, task, policy, lock });
  const simulated = live ? {} : {
    doctor: async () => ({ authentication: 'fixture', version: 'offline fixture' }),
    writer: async ({ workspace }) => {
      await fs.writeFile(path.join(workspace, 'src/math.mjs'), 'export const add = (a, b) => a + b;\n');
      return { exit_code: 0, stdout: [
        { type: 'thread.started', thread_id: 'offline-fixture' }, { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Offline oracle patch.' } },
        { type: 'turn.completed' },
      ].map(event => JSON.stringify(event)).join('\n'), stderr: '', duration_ms: 0 };
    },
  };
  // A single live invocation is sufficient for transport verification; this is not a model benchmark.
  const result = await codexLoop({ root, id: task.task_id, lock, command: process.env.QI_CODEX_EXECUTABLE || 'codex', config: { ...defaults, max_attempts: 1 }, ...simulated });
  const events = await readJournal(root);
  const usage = events.filter(event => event.type === 'implementation/result').map(event => event.data.usage);
  const report = { status: result.status === 'review_ready' ? 'PASS' : 'FAIL', mode: live ? 'live-chatgpt-subscription-with-docker' : 'offline-writer-with-docker',
    controller_sha: result.controller_sha, base_sha: sha, candidate_sha: result.candidate_sha ?? null,
    model: defaults.model, reasoning_effort: defaults.reasoning_effort, image,
    codex_invocations: live ? result.attempts : 0, provider_request_count: null, total_cost_usd: null,
    task_status: result.status, reason: result.reason ?? null, checks: result.checks, usage,
    original_checkout_unchanged: git(repo, 'rev-parse', 'HEAD') === sha && git(repo, 'status', '--porcelain') === '',
    note: 'A small integration fixture, not qi-agent full-suite validation, a heldout evaluation or unattended qualification.' };
  await durableWrite(path.join(output, 'report.json'), encode(report));
  console.log(encode({ status: report.status, task_status: result.status, candidate_sha: report.candidate_sha, output }));
  assert.equal(report.status, 'PASS', encode(report)); assert.equal(report.original_checkout_unchanged, true);
} finally { await lock.close(); }
