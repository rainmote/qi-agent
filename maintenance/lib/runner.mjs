import { promises as fs } from 'node:fs';
import path from 'node:path';
import { digest, encode, readJournal, readArtifact, putArtifact, durableWrite } from './store.mjs';
import { git } from './execution.mjs';
import { prepare, implement, hashTree, loadTask, taskState, TERMINAL, validateContract } from './controller.mjs';
import { validateBudget, budgetSnapshot } from './budget.mjs';

export async function enqueue({ root, lock, controller, repo, task, policy, budget, approval }) {
  validateContract(task, policy); validateBudget(budget);
  if (approval?.role !== 'human' || !approval.reviewer?.trim() || approval.scope !== 'candidate-only' ||
      approval.task_id !== task.task_id || Date.parse(approval.expires_at) <= Date.now() || !Number.isFinite(Date.parse(approval.expires_at))) {
    throw new Error('An explicit unexpired human authorization for this task is required');
  }
  if (git(controller, 'status', '--porcelain')) throw new Error('Controller checkout must be clean');
  const controllerSHA = git(controller, 'rev-parse', 'HEAD');
  const entry = { task_id: task.task_id, repository: await fs.realpath(repo), controller_sha: controllerSHA,
    contract_hash: digest(encode(task)), budget_hash: digest(encode(budget)),
    profile_hash: digest(await fs.readFile(task.profile_path)), verifier_hash: await hashTree(task.verifier_dir) };
  const events = await readJournal(root);
  const previous = events.find((e) => e.type === 'queue/enqueued' && e.data.task_id === task.task_id);
  if (previous) {
    if (Object.entries(entry).some(([key, value]) => previous.data[key] !== value)) throw new Error('Queue identity has different approved materials');
    return previous.data;
  }
  await lock.append('queue/enqueued', { ...entry, contract: await putArtifact(root, encode(task)), budget: await putArtifact(root, encode(budget)),
    policy: await putArtifact(root, encode(policy)), approval: await putArtifact(root, encode(approval)) });
  return entry;
}

export function scheduleSlot(config, now = new Date()) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config?.time ?? '') || !Number.isInteger(config.window_minutes) ||
      config.window_minutes < 1 || config.window_minutes > 120) throw new Error('Invalid daily schedule window');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const [hour, min] = config.time.split(':').map(Number), start = hour * 60 + min;
  // Do not catch up missed slots or cross midnight; use a window within the day.
  if (start + config.window_minutes > 1440) throw new Error('Schedule window crosses midnight');
  return minute >= start && minute < start + config.window_minutes ? `${parts.year}-${parts.month}-${parts.day}@${config.timezone}` : null;
}

export async function pause(root, reason) {
  if (!reason?.trim()) throw new Error('Pause reason required');
  await durableWrite(path.join(root, 'pause.json'), encode({ reason, at: new Date().toISOString() }));
}

export async function resume({ root, lock, acknowledgement }) {
  const events = await readJournal(root);
  const uncertain = [...new Set(events.filter((e) => e.type === 'task/created').map((e) => e.data.task_id))]
    .filter((id) => taskState(events, id).status === 'uncertain');
  if (budgetSnapshot(events, '').uncertain.length) throw new Error('Unsettled provider effects require billing reconciliation; resume cannot erase them');
  if (uncertain.length && (acknowledgement?.role !== 'human' || !acknowledgement?.reviewer || !acknowledgement?.summary ||
      JSON.stringify([...new Set(acknowledgement.task_ids ?? [])].sort()) !== JSON.stringify(uncertain.sort()))) {
    throw new Error('Explicit acknowledgement of every uncertain task is required');
  }
  await lock.append('runner/resumed', { acknowledgement: acknowledgement ?? null });
  await fs.unlink(path.join(root, 'pause.json')).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  return { status: 'resumed' };
}

async function qualification(root, entry, config) {
  if (!Array.isArray(config.trial_ids) || config.trial_ids.length < 2) throw new Error('A supervised development trial and held-out trial must pass first');
  const splits = new Set();
  for (const id of new Set(config.trial_ids)) {
    const { state, task, events } = await loadTask(root, id);
    const driver = state.driver && JSON.parse(await readArtifact(root, state.driver));
    const target = JSON.parse(await readArtifact(root, entry.contract));
    if (!['review_ready', 'accepted', 'trial_passed'].includes(state.status) || driver?.mode !== 'qi-budgeted' || driver.unattended !== false ||
        state.controller_sha !== entry.controller_sha || task.image !== target.image || state.profile_hash !== entry.profile_hash ||
        !events.some((e) => e.type === 'budget/reserved' && e.data.task_id === id && e.data.config_hash === entry.budget_hash) ||
        budgetSnapshot(events, id).uncertain.length) throw new Error('Trial evidence does not match this controller, image, profile and budget');
    splits.add(task.split);
  }
  if (!splits.has('dev') || !splits.has('heldout')) throw new Error('Trial evidence must include development and held-out tasks');
}

async function notification(root, lock, result) {
  const key = digest(encode(result));
  const previous = (await readJournal(root)).filter((e) => e.type === 'runner/notice').at(-1);
  if (previous?.data.key === key) return { ...result, quiet: true };
  await lock.append('runner/notice', { key, result });
  return { ...result, notification: result };
}

export async function tick({ root, lock, controller, config, now = new Date(), run = implement, qualify = qualification }) {
  if (config?.enabled !== true) return { status: 'disabled', quiet: true };
  const slot = scheduleSlot(config.schedule, now);
  if (!slot) return { status: 'outside-window', quiet: true };
  const stopped = await fs.readFile(path.join(root, 'pause.json'), 'utf8').then(JSON.parse, (e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (stopped) return notification(root, lock, { status: 'paused', reason: stopped.reason });
  const events = await readJournal(root);
  if (events.some((e) => e.type === 'runner/slot' && e.data.slot === slot)) return { status: 'already-ran', quiet: true };
  const states = [...new Set(events.filter((e) => e.type === 'task/created').map((e) => e.data.task_id))].map((id) => taskState(events, id));
  const resumedAt = events.filter((e) => e.type === 'runner/resumed').at(-1)?.seq ?? 0;
  if (states.some((s) => !TERMINAL.has(s.status))) return notification(root, lock, { status: 'waiting', reason: 'active-task-or-human-review' });
  if (states.some((s) => s.status === 'uncertain' && s.revision > resumedAt) || budgetSnapshot(events, '').uncertain.length) {
    await pause(root, 'uncertain-results');
    return notification(root, lock, { status: 'paused', reason: 'uncertain-results' });
  }
  const entry = events.find((e) => e.type === 'queue/enqueued' && !states.some((s) => s.task_id === e.data.task_id))?.data;
  if (!entry) return { status: 'empty', quiet: true };
  try {
    if (!process.env.OPENAI_API_KEY && run === implement) throw new Error('Missing dedicated OPENAI_API_KEY');
    if (git(controller, 'status', '--porcelain') || git(controller, 'rev-parse', 'HEAD') !== entry.controller_sha ||
        config.controller_sha !== entry.controller_sha) throw new Error('Controller changed since authorization');
    const task = JSON.parse(await readArtifact(root, entry.contract));
    const budget = JSON.parse(await readArtifact(root, entry.budget)); validateBudget(budget);
    const policy = JSON.parse(await readArtifact(root, entry.policy));
    const approval = JSON.parse(await readArtifact(root, entry.approval));
    if (Date.parse(approval.expires_at) <= now.getTime()) throw new Error('Task authorization expired');
    if (git(entry.repository, 'rev-parse', 'refs/heads/main') !== task.base_sha) throw new Error('Approved base is stale');
    if (digest(await fs.readFile(task.profile_path)) !== entry.profile_hash || await hashTree(task.verifier_dir) !== entry.verifier_hash) throw new Error('Approved profile or verifier changed');
    await qualify(root, entry, config);
    await lock.append('runner/slot', { slot, task_id: task.task_id });
    await prepare({ root, lock, controller, repo: entry.repository, task, policy });
    const result = await run({ root, lock, id: task.task_id, budget,
      driver: { mode: 'qi-budgeted', paid: true, unattended: true } });
    if (result.status !== 'review_ready') await pause(root, result.reason ?? result.status);
    return notification(root, lock, { status: result.status, task_id: task.task_id, candidate_sha: result.candidate_sha ?? null, reason: result.reason ?? null });
  } catch (error) {
    await pause(root, error.message);
    return notification(root, lock, { status: 'paused', task_id: entry.task_id, reason: error.message });
  }
}
