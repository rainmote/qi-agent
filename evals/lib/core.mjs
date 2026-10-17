import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessTap } from './grading.mjs';

export const SCHEMA_VERSION = 1;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
      path.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Expected a safe relative path: ' + String(value));
  }
  return value;
}

export async function filesIn(root, prefix = '') {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    relativePath(name);
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not allowed: ' + name);
    if (entry.isDirectory()) files.push(...await filesIn(root, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error('Only regular files and directories are allowed: ' + name);
  }
  return files;
}

export async function treeHash(root) {
  const hash = createHash('sha256');
  for (const name of await filesIn(root)) {
    const data = await fs.readFile(path.join(root, name));
    hash.update(name + '\0' + data.length + '\0');
    hash.update(data);
  }
  return hash.digest('hex');
}

export async function copyTree(source, destination) {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of await filesIn(source)) {
    const target = path.join(destination, name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(source, name), target);
  }
}

export async function readTask(directory) {
  const root = path.resolve(directory);
  const task = JSON.parse(await fs.readFile(path.join(root, 'task.json'), 'utf8'));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(task.id) || typeof task.title !== 'string' ||
      typeof task.category !== 'string' || !['dev', 'heldout'].includes(task.split)) {
    throw new Error('Invalid task identity: ' + root);
  }
  if (!Number.isInteger(task.timeout_seconds) || task.timeout_seconds < 1 || task.timeout_seconds > 3600) {
    throw new Error('Task timeout must be 1..3600 seconds');
  }
  if (!Array.isArray(task.allowed_files) || !task.allowed_files.length ||
      new Set(task.allowed_files).size !== task.allowed_files.length) {
    throw new Error('Task must specify unique allowed_files');
  }
  task.allowed_files.forEach(relativePath);
  if (!Array.isArray(task.acceptance_tests) || !task.acceptance_tests.length ||
      new Set(task.acceptance_tests).size !== task.acceptance_tests.length ||
      task.acceptance_tests.some((name) => typeof name !== 'string' || !name || /[\r\n]/.test(name))) {
    throw new Error('Task must list the exact acceptance test names');
  }
  // This first local validator deliberately runs only the trusted Node development fixtures.
  if (JSON.stringify(task.verify_command) !== JSON.stringify(['node', '--test', 'tests/acceptance.test.mjs'])) {
    throw new Error('Unsupported local verifier command; use Harbor for other runtimes');
  }
  const prompt = await fs.readFile(path.join(root, 'prompt.md'), 'utf8');
  if (!prompt.trim()) throw new Error('Task prompt is empty');
  await filesIn(path.join(root, 'workspace'));
  const solutionFiles = await filesIn(path.join(root, 'solution'));
  if (solutionFiles.some((file) => !task.allowed_files.includes(file))) {
    throw new Error('Reference solution changes a forbidden file');
  }
  const verifierFiles = await filesIn(path.join(root, 'verifier'));
  if (!verifierFiles.includes('tests/acceptance.test.mjs')) throw new Error('Missing acceptance tests');
  if (verifierFiles.some((file) => task.allowed_files.includes(file))) {
    throw new Error('Agent deliverables must not overwrite verifier files');
  }
  return { ...task, root, prompt, hash: await treeHash(root) };
}

export async function loadTasks(tasksRoot, taskIds = []) {
  const tasks = [];
  for (const entry of (await fs.readdir(tasksRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('Task directories cannot be symlinks');
    if (entry.isDirectory()) tasks.push(await readTask(path.join(tasksRoot, entry.name)));
  }
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error('Duplicate task IDs');
  for (const id of taskIds) if (!tasks.some((task) => task.id === id)) throw new Error('Unknown task: ' + id);
  const selected = taskIds.length ? tasks.filter((task) => taskIds.includes(task.id)) : tasks;
  if (!selected.length) throw new Error('No tasks found');
  return selected;
}

export function cleanEnvironment(temporaryHome) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
    HOME: temporaryHome, TMPDIR: temporaryHome,
    NO_COLOR: '1',
  };
}

export function runProcess(command, args, { cwd, env, timeoutMs = 30000, maxOutputBytes = 2_000_000 } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    let child;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let outputLimited = false;
    let settled = false;
    let timeout;
    let escalation;
    const killGroup = (signal) => {
      if (!child?.pid) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch { /* exited */ }
    };
    const stop = () => {
      killGroup('SIGTERM');
      escalation ||= setTimeout(() => killGroup('SIGKILL'), 300);
    };
    const finish = (exitCode, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(escalation);
      // Also dispose descendants after the parent exits; no child may outlive a trial.
      killGroup('SIGKILL');
      resolve({ exit_code: exitCode, signal, error, timed_out: timedOut, output_limited: outputLimited,
        duration_ms: Math.round(performance.now() - started), stdout, stderr });
    };
    try {
      child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', shell: false,
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { finish(null, null, error.message); return; }
    const collect = (stream) => (chunk) => {
      const remaining = Math.max(0, maxOutputBytes - bytes);
      const accepted = chunk.subarray(0, remaining).toString('utf8');
      if (stream === 'stdout') stdout += accepted; else stderr += accepted;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { outputLimited = true; stop(); }
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (error) => finish(null, null, error.message));
    child.on('close', (code, signal) => finish(code, signal));
    timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  });
}

export async function changesFrom(baseline, candidate) {
  const original = new Set(await filesIn(baseline));
  const current = new Set(await filesIn(candidate));
  const changes = [];
  for (const file of [...new Set([...original, ...current])].sort()) {
    if (!original.has(file)) changes.push({ path: file, kind: 'added' });
    else if (!current.has(file)) changes.push({ path: file, kind: 'deleted' });
    else if (!Buffer.compare(await fs.readFile(path.join(baseline, file)), await fs.readFile(path.join(candidate, file)))) continue;
    else changes.push({ path: file, kind: 'modified' });
  }
  return changes;
}

export async function verifyCandidate(task, candidate, artifactDirectory) {
  const verifier = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-eval-verify-'));
  try {
    const changes = await changesFrom(path.join(task.root, 'workspace'), candidate);
    const forbidden = changes.filter((change) => !task.allowed_files.includes(change.path));
    await copyTree(path.join(task.root, 'workspace'), verifier);
    for (const file of task.allowed_files) {
      const source = path.join(candidate, file);
      const destination = path.join(verifier, file);
      try {
        const stat = await fs.lstat(source);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Deliverables must be regular files');
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(source, destination);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.rm(destination, { force: true });
      }
    }
    await copyTree(path.join(task.root, 'verifier'), verifier);
    const temporaryHome = path.join(verifier, '.home');
    await fs.mkdir(temporaryHome);
    const execution = await runProcess(process.execPath, ['--test', '--test-reporter=tap', ...task.verify_command.slice(2)], {
      cwd: verifier, env: cleanEnvironment(temporaryHome), timeoutMs: Math.min(task.timeout_seconds * 1000, 30000),
    });
    const tap = assessTap(execution.stdout, task.acceptance_tests);
    const testsPassed = execution.exit_code === 0 && !execution.timed_out && !execution.output_limited && !execution.error && tap.passed;
    const result = { passed: testsPassed && !forbidden.length, tests_passed: testsPassed,
      forbidden_changes: forbidden, changes, tap, execution };
    if (artifactDirectory) {
      await fs.mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(artifactDirectory, 'verifier.stdout.txt'), execution.stdout, { mode: 0o600 });
      await fs.writeFile(path.join(artifactDirectory, 'verifier.stderr.txt'), execution.stderr, { mode: 0o600 });
      await fs.writeFile(path.join(artifactDirectory, 'changes.json'), JSON.stringify(changes, null, 2) + '\n', { mode: 0o600 });
    }
    return result;
  } finally { await fs.rm(verifier, { recursive: true, force: true }); }
}

export async function offlineTrial(task, agent, trial, outputRoot) {
  if (!['noop', 'oracle'].includes(agent)) throw new Error('Offline trials only support noop or oracle');
  const runId = task.id + '-' + agent + '-' + trial + '-' + randomUUID().slice(0, 8);
  const artifacts = path.join(outputRoot, 'runs', runId);
  await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-eval-work-'));
  const startedAt = new Date().toISOString();
  try {
    await copyTree(path.join(task.root, 'workspace'), workspace);
    const started = performance.now();
    if (agent === 'oracle') await copyTree(path.join(task.root, 'solution'), workspace);
    const duration = Math.round(performance.now() - started);
    const verification = await verifyCandidate(task, workspace, artifacts);
    const record = { schema_version: SCHEMA_VERSION, run_id: runId, task_id: task.id,
      task_title: task.title, category: task.category, split: task.split, task_hash: task.hash,
      agent, model: null, trial, mode: 'offline_fixture', started_at: startedAt,
      agent_status: 'completed', success: verification.passed,
      failure_kind: verification.passed ? null : verification.forbidden_changes.length ? 'forbidden_change' :
        verification.execution.error ? 'verifier_error' : verification.execution.timed_out ? 'verifier_timeout' :
          !verification.tap.complete ? 'verifier_incomplete' : 'acceptance_failed',
      agent_duration_ms: duration, verifier_duration_ms: verification.execution.duration_ms,
      reported_usage: null, cost_usd: null, cost_complete: false,
      isolation: 'fresh_directories_trusted_fixtures_only',
      notes: ['Offline fixture plumbing check; not a model benchmark or security sandbox.'],
      verification: { tests_passed: verification.tests_passed, forbidden_changes: verification.forbidden_changes,
        exit_code: verification.execution.exit_code, timed_out: verification.execution.timed_out, tap: verification.tap } };
    await copyTree(workspace, path.join(artifacts, 'candidate'));
    await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    return record;
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
}
