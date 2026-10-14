import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { commitSHA, checkReview } from './github.mjs';
import { digest, encode, identifier, readJournal, putArtifact, readArtifact, validateArtifacts } from './store.mjs';
import { git, relative, regularFile, snapshot, changedFiles, immutableImage, containerCommand } from './execution.mjs';
import { assessTap } from '../../evals/lib/grading.mjs';
import { usageLedger, mayAttempt } from './ledger.mjs';

const catalog = JSON.parse(await fs.readFile(new URL('../checks.json', import.meta.url)));

export const TERMINAL = new Set(['accepted', 'failed', 'blocked', 'uncertain', 'cancelled']);
const TRANSITIONS = {
  queued: ['scoped', 'blocked', 'uncertain', 'cancelled'], scoped: ['implementing', 'verifying', 'blocked', 'uncertain', 'cancelled'],
  implementing: ['verifying', 'failed', 'blocked', 'uncertain', 'cancelled'],
  verifying: ['review_ready', 'implementing', 'failed', 'blocked', 'uncertain', 'cancelled'],
  review_ready: ['accepted', 'blocked', 'uncertain', 'cancelled'],
  failed: ['scoped'],
};

export function taskState(events, id) {
  const related = events.filter((event) => event.data?.task_id === id);
  const created = related.find((event) => event.type === 'task/created');
  if (!created) return null;
  return related.reduce((state, event) => ['task/transition', 'task/preflight'].includes(event.type) ? { ...state, ...event.data, revision: event.seq } : state,
    { ...created.data, status: 'queued', revision: created.seq });
}

export async function transition(root, lock, id, expectedRevision, status, data = {}) {
  const current = taskState(await readJournal(root), id);
  if (!current || current.revision !== expectedRevision) throw new Error('Task revision conflict');
  if (!TRANSITIONS[current.status]?.includes(status)) throw new Error(`Illegal transition ${current.status} -> ${status}`);
  await lock.append('task/transition', { ...data, task_id: id, status });
  return taskState(await readJournal(root), id);
}

export function validateContract(task, policy) {
  identifier(task.task_id); commitSHA(task.base_sha); immutableImage(task.image);
  if (task.schema_version !== 1 || !['bug', 'feature', 'docs'].includes(task.kind) || typeof task.goal !== 'string' || !task.goal.trim()) throw new Error('Invalid task contract');
  if (!Array.isArray(task.allowed_files) || !task.allowed_files.length || new Set(task.allowed_files).size !== task.allowed_files.length) throw new Error('Declare unique allowed_files');
  for (const file of task.allowed_files) {
    relative(file);
    if (policy.protected_paths.some((protectedPath) => file === protectedPath || file.startsWith(protectedPath.endsWith('/') ? protectedPath : protectedPath + '/'))) {
      throw new Error('Protected controller/policy/verifier path requires a separate human implementation: ' + file);
    }
  }
  if (!Array.isArray(task.checks) || !task.checks.length || new Set(task.checks.map((check) => check.id)).size !== task.checks.length) throw new Error('Declare unique baseline/candidate checks');
  for (const check of task.checks) {
    identifier(check.id);
    if (!Array.isArray(check.argv) || !check.argv.length || check.argv.some((v) => typeof v !== 'string' || v.includes('\0'))) throw new Error('Invalid check argv');
    if (!Number.isSafeInteger(check.timeout_seconds) || check.timeout_seconds < 1 || check.timeout_seconds > 1800) throw new Error('Invalid check timeout');
  }
  if (task.kind === 'bug') {
    if (!task.acceptance || !Array.isArray(task.acceptance.tests) || !task.acceptance.tests.length ||
        new Set(task.acceptance.tests).size !== task.acceptance.tests.length || task.acceptance.tests.some((s) => typeof s !== 'string' || !s || /[\r\n]/.test(s))) throw new Error('Bug fixes require named red/green acceptance tests');
  } else if (!task.acceptance && (typeof task.red_not_applicable !== 'string' || !task.red_not_applicable.trim())) throw new Error('Predeclare why red checking is not applicable');
  if (task.acceptance) relative(task.acceptance.file);
  if (!path.isAbsolute(task.profile_path) || !path.isAbsolute(task.verifier_dir ?? '')) throw new Error('Profile and verifier paths must be explicit absolute paths');
  if (!Number.isSafeInteger(policy.max_attempts) || policy.max_attempts < 1 || policy.max_attempts > 3 ||
      !Number.isFinite(policy.wall_seconds) || policy.wall_seconds > 2700 || policy.wall_seconds <= policy.verification_reserve_seconds ||
      policy.verification_reserve_seconds < 1 || policy.parent_steps !== 32 || policy.readonly_child_steps !== 8 ||
      policy.mode !== 'human_reviewed_candidate' || policy.automatic_push !== false || policy.automatic_merge !== false || policy.automatic_release !== false ||
      (policy.max_cost_usd !== null && (!Number.isFinite(policy.max_cost_usd) || policy.max_cost_usd <= 0))) throw new Error('Invalid or expanded pilot policy');
  return task;
}

async function copyVerifier(source, destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true, mode: 0o755 });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('Verifier cannot contain symlinks');
    if (entry.isDirectory()) await copyVerifier(path.join(source, entry.name), path.join(destination, entry.name));
    else if (entry.isFile()) await fs.copyFile(path.join(source, entry.name), path.join(destination, entry.name));
    else throw new Error('Verifier must contain only regular files');
  }
}

async function hashTree(root) {
  const values = [];
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('Trusted material contains a symlink');
    values.push([entry.name, (await fs.stat(path.join(root, entry.name))).mode & 0o777,
      entry.isDirectory() ? await hashTree(path.join(root, entry.name)) : digest(await fs.readFile(path.join(root, entry.name)))]);
  }
  return digest(JSON.stringify(values));
}

export async function prepare({ repo, root, controller, task, policy, lock }) {
  validateContract(task, policy);
  repo = await fs.realpath(repo); controller = await fs.realpath(controller); root = await fs.realpath(root);
  if (root === repo || root.startsWith(repo + path.sep) || root === controller || root.startsWith(controller + path.sep)) throw new Error('State must be outside the candidate and controller repositories');
  if (git(repo, 'rev-parse', task.base_sha + '^{commit}') !== task.base_sha) throw new Error('Base commit unavailable');
  const events = await readJournal(root);
  const existing = taskState(events, task.task_id);
  if (existing) {
    if (existing.contract_hash !== digest(encode(task))) throw new Error('Task identity already has a different contract');
    return existing;
  }
  const activeIds = [...new Set(events.filter((e) => e.type === 'task/created').map((e) => e.data.task_id))];
  if (events.some((e) => e.type === 'action/intent' && !events.some((done) => done.type === 'action/result' && done.data.action_id === e.data.action_id))) {
    throw new Error('Unresolved external action; reconcile before admitting a new task');
  }
  if (activeIds.some((id) => !TERMINAL.has(taskState(events, id).status))) throw new Error('Pilot permits one active task and one writer');
  const controllerSHA = commitSHA(git(controller, 'rev-parse', 'HEAD'));
  if (git(controller, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Controller checkout must be clean and pinned');
  const contract = await putArtifact(root, encode(task));
  const policyArtifact = await putArtifact(root, encode(policy));
  const material = path.join(root, 'materials', task.task_id);
  const workspace = path.join(root, 'workspaces', task.task_id);
  await lock.append('task/created', { task_id: task.task_id, status: 'queued', base_sha: task.base_sha,
    repository: repo, controller_sha: controllerSHA, contract, policy: policyArtifact, contract_hash: digest(encode(task)),
    material, workspace, started_at: Date.now(), attempts: 0 });
  // Interrupted creation remains queued and must be reconciled, never silently replayed.
  await snapshot(repo, task.base_sha, path.join(material, 'base'));
  if (task.kind !== 'docs' && await fs.stat(path.join(material, 'base/src/qi/plugins/runtime.clj')).then(() => true, () => false)) {
    const required = [...catalog.checks,
      ...(task.allowed_files.some((file) => /^(apps\/(web|web-host|shared)|protocol\/|apps\/tui-rs\/src\/daemon)/.test(file)) ? catalog.web_checks : [])];
    for (const check of required) {
      if (!task.checks.some((item) => item.id === check.id && JSON.stringify(item.argv) === JSON.stringify(check.argv))) {
        throw new Error('qi-agent code tasks require the trusted check catalog: ' + check.id);
      }
    }
  }
  await snapshot(controller, controllerSHA, path.join(material, 'controller'));
  await copyVerifier(task.verifier_dir, path.join(material, 'verifier'));
  await fs.mkdir(path.join(material, 'profile'), { recursive: true });
  await fs.copyFile(task.profile_path, path.join(material, 'profile', 'agent.edn'));
  await fs.chmod(path.join(material, 'profile', 'agent.edn'), 0o644);
  const materialHash = await hashTree(material);
  git(repo, 'worktree', 'add', '--detach', workspace, task.base_sha);
  const state = taskState(await readJournal(root), task.task_id);
  return transition(root, lock, task.task_id, state.revision, 'scoped', { material_hash: materialHash,
    profile_hash: digest(await fs.readFile(task.profile_path)), verifier_hash: await hashTree(path.join(material, 'verifier')) });
}

export async function loadTask(root, id) {
  identifier(id);
  const events = await readJournal(root);
  await validateArtifacts(root, events);
  const state = taskState(events, id);
  if (!state) throw new Error('Unknown task');
  const task = JSON.parse(await readArtifact(root, state.contract));
  const policy = JSON.parse(await readArtifact(root, state.policy));
  validateContract(task, policy);
  if (state.material_hash && await hashTree(state.material) !== state.material_hash) throw new Error('Trusted material hash mismatch');
  return { state, task, policy, events };
}

const succeeded = (result) => result.exit_code === 0 && !result.error && !result.signal && !result.timed_out && !result.output_limited;

async function executeCheck({ root, lock, state, task, check, workspace, phase, deadline, execute }) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { id: check.id, phase, status: 'NOT_RUN', reason: 'wall-budget' };
  const started = new Date().toISOString();
  const name = 'qi-maint-check-' + randomUUID();
  await lock.append('check/start', { task_id: task.task_id, check_id: check.id, phase, container: name });
  const result = await execute({ image: task.image, argv: check.argv, workspace, readonly: true,
    mounts: [{ source: path.join(state.material, 'verifier'), target: '/acceptance' }],
    timeoutMs: Math.min(remaining, check.timeout_seconds * 1000), name });
  const output = await putArtifact(root, encode(result));
  const tap = check.tests ? assessTap(result.stdout, check.tests) : null;
  const status = succeeded(result) && (!tap || tap.passed) ? 'PASS' : 'FAIL';
  return { id: check.id, phase, status, argv: check.argv, image: task.image, started_at: started,
    ended_at: new Date().toISOString(), exit_code: result.exit_code, timed_out: result.timed_out,
    duration_ms: result.duration_ms, tests: tap?.tests ?? null, tap, output };
}

async function candidateTree(state, task, root) {
  if (git(state.workspace, 'rev-parse', 'HEAD') !== state.base_sha) throw new Error('Candidate must remain at its detached base until controller verification');
  const files = changedFiles(state.workspace, state.base_sha);
  if (!files.length) throw new Error('Candidate has no source changes');
  if (files.some((file) => !task.allowed_files.includes(file))) throw new Error('Candidate changed a file outside the contract');
  const directory = path.join(root, 'verification', randomUUID());
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.cp(path.join(state.material, 'base'), directory, { recursive: true });
  const manifest = [];
  for (const file of files) {
    const source = await regularFile(state.workspace, file); // Deletions need a separate contract/version.
    const target = path.join(directory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    const bytes = await fs.readFile(target);
    manifest.push({ file, mode: (await fs.stat(source)).mode & 0o777, sha256: digest(bytes), content: await putArtifact(root, bytes) });
  }
  const patch = git(state.workspace, 'diff', '--binary', state.base_sha, '--', ...files);
  return { directory, files, manifest, fingerprint: digest(encode(manifest)), patch: await putArtifact(root, patch + '\n') };
}

export async function preflight({ root, id, lock, execute = containerCommand }) {
  let { state, task, policy } = await loadTask(root, id);
  if (state.preflight_passed) return state;
  const deadline = state.started_at + policy.wall_seconds * 1000;
  const checks = [];
  const check = async (spec, workspace, phase) => {
    const result = await executeCheck({ root, lock, state, task, check: spec, workspace, phase, deadline, execute });
    checks.push(result);
    await lock.append('check/result', { task_id: id, run_id: state.run_id ?? null, ...result });
    return result;
  };
  try {
    for (const spec of task.checks) {
      if ((await check(spec, path.join(state.material, 'base'), 'baseline')).status !== 'PASS') {
        return transition(root, lock, id, state.revision, 'blocked', { reason: 'baseline-failed', checks });
      }
    }
    const acceptance = task.acceptance ? { id: 'acceptance', argv: ['node', '--test', '--test-reporter=tap', '/acceptance/' + task.acceptance.file],
      timeout_seconds: 60, tests: task.acceptance.tests } : null;
    if (task.kind === 'bug') {
      const red = await check(acceptance, path.join(state.material, 'base'), 'red');
      const raw = JSON.parse(await readArtifact(root, red.output));
      // A completed named assertion failure, not syntax/import/timeout/skip, is valid red evidence.
      if (!red.tap?.complete || red.tap.reason !== 'acceptance_assertions_failed' || raw.exit_code !== 1 ||
          raw.timed_out || raw.output_limited || raw.signal || raw.error || !/ERR_ASSERTION|AssertionError/.test(raw.stdout)) {
        return transition(root, lock, id, state.revision, 'blocked', { reason: 'invalid-red-evidence', checks });
      }
    }
    await lock.append('task/preflight', { task_id: id, preflight_passed: true, checks });
    return taskState(await readJournal(root), id);
  } catch (error) {
    return transition(root, lock, id, state.revision, 'uncertain', { reason: error.message, checks });
  }
}

export async function verify({ root, id, lock, execute = containerCommand }) {
  let { state, task, policy } = await loadTask(root, id);
  if (!['scoped', 'implementing', 'verifying'].includes(state.status)) throw new Error('Task is not ready for verification');
  state = await preflight({ root, id, lock, execute });
  if (TERMINAL.has(state.status)) return state;
  if (state.status !== 'verifying') state = await transition(root, lock, id, state.revision, 'verifying');
  const deadline = state.started_at + policy.wall_seconds * 1000;
  const checks = state.checks.filter((check) => check.phase !== 'candidate');
  const check = async (spec, workspace, phase) => {
    const result = await executeCheck({ root, lock, state, task, check: spec, workspace, phase, deadline, execute });
    checks.push(result);
    await lock.append('check/result', { task_id: id, run_id: state.run_id ?? null, ...result });
    return result;
  };
  const acceptance = task.acceptance ? { id: 'acceptance', argv: ['node', '--test', '--test-reporter=tap', '/acceptance/' + task.acceptance.file],
    timeout_seconds: 60, tests: task.acceptance.tests } : null;
  try {
    const candidate = await candidateTree(state, task, root);
    try {
      if (state.fingerprint === candidate.fingerprint) return transition(root, lock, id, state.revision, 'blocked', { reason: 'no-progress' });
      for (const spec of [...task.checks, ...(acceptance ? [acceptance] : [])]) await check(spec, candidate.directory, 'candidate');
      const passed = checks.filter((item) => item.phase === 'candidate').every((item) => item.status === 'PASS');
      const evidence = await putArtifact(root, encode({ base_sha: state.base_sha, checks, manifest: candidate.manifest, patch: candidate.patch }));
      if (!passed) return transition(root, lock, id, state.revision, 'failed', { reason: 'verification-failed', checks, evidence, fingerprint: candidate.fingerprint });
      // Freeze a content-addressed Git tree without changing HEAD or the user's checkout.
      for (const file of candidate.files) {
        if (digest(await fs.readFile(await regularFile(state.workspace, file))) !== candidate.manifest.find((item) => item.file === file).sha256) throw new Error('Candidate changed during verification');
      }
      git(state.workspace, 'add', '--', ...candidate.files);
      const tree = git(state.workspace, 'write-tree');
      const candidateSHA = git(state.workspace, '-c', 'user.name=qi-maintenance', '-c', 'user.email=maintenance@localhost',
        'commit-tree', tree, '-p', state.base_sha, '-m', `maintenance: ${id}`);
      git(state.repository, 'update-ref', `refs/maintenance/${id}/${state.run_id ?? 'manual'}`, candidateSHA);
      return transition(root, lock, id, state.revision, 'review_ready', { checks, evidence, fingerprint: candidate.fingerprint,
        candidate_sha: candidateSHA, candidate_tree: tree, verified_base: state.base_sha, manifest: candidate.manifest });
    } finally { await fs.rm(candidate.directory, { recursive: true, force: true }); }
  } catch (error) {
    // Evidence write failures may also prevent this transition; never hide that failure.
    return transition(root, lock, id, state.revision, 'uncertain', { reason: error.message, checks });
  }
}

export async function implement({ root, id, lock, driver, execute = containerCommand }) {
  let { state, task, policy, events } = await loadTask(root, id);
  if (state.status !== 'scoped') throw new Error('Implementation requires a freshly scoped task');
  const usage = usageLedger(events.filter((event) => event.type === 'usage/request' && event.data.task_id === id).map((event) => event.data));
  const denied = mayAttempt({ policy, startedAt: state.started_at, attempts: state.attempts, usage, paid: driver.paid, unattended: driver.unattended });
  if (denied) return transition(root, lock, id, state.revision, 'blocked', { reason: denied });
  if (driver.unattended || !['offline', 'qi-supervised'].includes(driver.mode)) throw new Error('Pilot requires an offline driver or explicit supervised qi run');
  if ((driver.mode === 'offline') !== (driver.paid === false)) throw new Error('Paid status must match the driver mode');
  state = await preflight({ root, id, lock, execute });
  if (TERMINAL.has(state.status)) return state;
  const afterPreflight = mayAttempt({ policy, startedAt: state.started_at, attempts: state.attempts, usage, paid: driver.paid, unattended: driver.unattended });
  if (afterPreflight) return transition(root, lock, id, state.revision, 'blocked', { reason: afterPreflight });
  const runId = randomUUID();
  const driverArtifact = await putArtifact(root, encode(driver));
  state = await transition(root, lock, id, state.revision, 'implementing', { run_id: runId, attempts: state.attempts + 1,
    container: 'qi-maint-' + runId, driver: driverArtifact });
  const deadline = state.started_at + (policy.wall_seconds - policy.verification_reserve_seconds) * 1000;
  const argv = driver.mode === 'qi-supervised' ? ['bb', '--classpath', '/controller/src:/controller/plugins', '/controller/maintenance/worker.clj',
    '/profile/agent.edn', task.goal + '\nAllowed deliverables: ' + task.allowed_files.join(', ')] : driver.argv;
  const execution = await execute({ image: task.image, argv, workspace: state.workspace, readonly: false,
    mounts: [{ source: path.join(state.material, 'controller'), target: '/controller' }, { source: path.join(state.material, 'profile'), target: '/profile' }],
    timeoutMs: Math.max(1, deadline - Date.now()), network: driver.paid === true,
    envNames: driver.paid === true ? ['OPENAI_API_KEY'] : [], name: state.container });
  const artifact = await putArtifact(root, encode(execution));
  await lock.append('implementation/result', { task_id: id, run_id: runId, execution: artifact,
    usage: { accounting_complete: false, total_cost_usd: null } });
  // Keep accounting from unsuccessful runs too. A malformed/missing envelope stays unknown.
  if (driver.mode === 'qi-supervised') {
    for (const line of execution.stdout.split('\n').filter(Boolean)) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'event' && event.event === 'usage/request' && event.data?.request_id) {
        await lock.append('usage/request', { ...event.data, task_id: id, run_id: runId, agent_id: event.agent_id ?? null });
      }
    }
  }
  if (!succeeded(execution)) return transition(root, lock, id, state.revision, 'failed', { reason: execution.timed_out ? 'wall-budget' : 'driver-failed' });
  if (driver.mode === 'qi-supervised') {
    let records;
    try { records = execution.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch { return transition(root, lock, id, state.revision, 'uncertain', { reason: 'malformed-qi-output' }); }
    const terminal = records.filter((record) => record.type === 'result').at(-1);
    if (terminal?.ok !== true || terminal.result?.status !== 'completed' || terminal.result?.error) {
      return transition(root, lock, id, state.revision, 'failed', { reason: 'qi-did-not-complete' });
    }
  }
  return verify({ root, id, lock, execute });
}

export async function retry({ root, id, lock, expectedRevision }) {
  const { state, policy, events } = await loadTask(root, id);
  if (state.status !== 'failed' || state.revision !== expectedRevision) throw new Error('Only a known failure at the expected revision can be retried');
  const usage = usageLedger(events.filter((e) => e.type === 'usage/request' && e.data.task_id === id).map((e) => e.data));
  const driver = state.driver ? JSON.parse(await readArtifact(root, state.driver)) : { paid: false };
  const denied = mayAttempt({ policy, startedAt: state.started_at, attempts: state.attempts, usage, paid: driver.paid, unattended: false });
  if (denied) throw new Error('Retry blocked: ' + denied);
  return transition(root, lock, id, expectedRevision, 'scoped', { retry_of: state.run_id, reason: null });
}

export async function accept({ root, id, lock, review, expectedRevision, baseRef = 'refs/heads/main' }) {
  const { state, task } = await loadTask(root, id);
  if (state.status !== 'review_ready' || state.revision !== expectedRevision) throw new Error('Task is not at the reviewed revision');
  if (review.decision !== 'approve' || !review.reviewer || !review.summary || review.role !== 'human') throw new Error('An explicit human review record is required');
  const currentBase = git(state.repository, 'rev-parse', baseRef + '^{commit}');
  if (!checkReview({ reviewedHead: review.head_sha, currentHead: state.candidate_sha, verifiedBase: state.verified_base,
    currentBase, verification: state.checks.filter((check) => check.phase === 'candidate').every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL' })) throw new Error('Review head or integration base is stale');
  const candidate = await candidateTree(state, task, root);
  try {
    if (candidate.fingerprint !== state.fingerprint || git(state.workspace, 'write-tree') !== state.candidate_tree) throw new Error('Candidate changed after verification');
  } finally { await fs.rm(candidate.directory, { recursive: true, force: true }); }
  const artifact = await putArtifact(root, encode(review));
  return transition(root, lock, id, expectedRevision, 'accepted', { review: artifact, accepted_at: new Date().toISOString() });
}

export async function recover({ root, lock }) {
  const events = await readJournal(root);
  await validateArtifacts(root, events);
  const states = [];
  for (const id of new Set(events.filter((event) => event.type === 'task/created').map((event) => event.data.task_id))) {
    const state = taskState(events, id);
    if (['queued', 'implementing', 'verifying'].includes(state.status)) states.push(await transition(root, lock, id, state.revision, 'uncertain', { reason: 'interrupted-process-reconcile-before-new-task' }));
  }
  return states;
}

export async function restoreCandidate({ root, id, lock }) {
  const { state, task } = await loadTask(root, id);
  if (state.status !== 'review_ready' || !state.manifest?.length) throw new Error('Only a durably verified candidate can be restored');
  try { await fs.lstat(state.workspace); throw new Error('Candidate workspace already exists; never overwrite it'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await lock.append('candidate/restore-intent', { task_id: id, candidate_sha: state.candidate_sha, workspace: state.workspace });
  git(state.repository, 'worktree', 'add', '--force', '--detach', state.workspace, state.base_sha);
  for (const entry of state.manifest) {
    if (!task.allowed_files.includes(entry.file)) throw new Error('Restored file is outside the contract');
    const destination = path.join(state.workspace, relative(entry.file));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, await readArtifact(root, entry.content));
    await fs.chmod(destination, entry.mode);
  }
  git(state.workspace, 'add', '--', ...state.manifest.map((entry) => entry.file));
  if (git(state.workspace, 'write-tree') !== state.candidate_tree) throw new Error('Restored candidate tree mismatch');
  await lock.append('candidate/restored', { task_id: id, candidate_sha: state.candidate_sha });
  return { task_id: id, status: state.status, workspace: state.workspace, candidate_sha: state.candidate_sha,
    note: 'Source restored; no worker, credential, container or external action was replayed.' };
}
