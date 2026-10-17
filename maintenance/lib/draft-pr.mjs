// Connector handoff: host authorization and GitHub credentials never enter the writer.
import { assertVerifiedCandidate } from './codex-review.mjs';
import { git } from './execution.mjs';
import { repositoryPath } from './github.mjs';
import { readJournal, readArtifact, putArtifact, encode, digest } from './store.mjs';

export function validateDestination(repository, remote) {
  repositoryPath(repository);
  if (![ `git@github.com:${repository}.git`, `https://github.com/${repository}.git`, `https://github.com/${repository}` ].includes(remote)) throw new Error('Git remote does not match the explicitly selected GitHub repository');
}

export async function draftPlan({ root, id, lock, repository }) {
  const { state, task } = await assertVerifiedCandidate(root, id);
  const destinations = git(state.repository, 'remote', 'get-url', '--push', '--all', 'origin').split('\n');
  if (destinations.length !== 1) throw new Error('Exactly one Git push destination is required');
  const destination = destinations[0];
  validateDestination(repository, destination);
  const events = await readJournal(root);
  const review = events.filter(event => event.type === 'candidate/reviewed' && event.data.task_id === id).at(-1)?.data;
  if (!review || review.decision !== 'approve' || review.candidate_sha !== state.candidate_sha || review.fingerprint !== state.fingerprint) throw new Error('A fresh independent approval for this exact candidate is required');
  const report = JSON.parse(await readArtifact(root, review.evidence));
  if (report.head_sha !== state.candidate_sha || report.decision !== 'approve' || report.findings.length) throw new Error('Independent review evidence does not approve this candidate');
  const head = `codex/maintenance-${id}-${state.candidate_sha.slice(0, 12)}`;
  const action_id = `draft-pr-${digest(encode({ repository, head, sha: state.candidate_sha })).slice(0, 24)}`;
  const previous = events.find(event => event.type === 'action/intent' && event.data.action_id === action_id);
  const completed = events.find(event => event.type === 'candidate/pr-created' && event.data.action_id === action_id);
  if (completed) return { status: 'created', ...completed.data };
  const plan = { schema_version: 1, action_id, task_id: id, repository, head, base: 'main',
    head_sha: state.candidate_sha, base_sha: state.verified_base, draft: true,
    title: task.goal.split('\n')[0].slice(0, 120),
    body: `Task: ${task.goal}\n\nVerified candidate: ${state.candidate_sha}\nBase: ${state.verified_base}\nController: ${state.controller_sha}\nImage: ${task.image}\n\nChecks:\n${state.checks.filter(check => check.phase === 'candidate').map(check => `- ${check.id}: ${check.status}`).join('\n')}\n\nIndependent review: ${report.summary}\n\nThis draft is not accepted, merged, deployed, or released. Model usage is subscription-reported; full monetary cost is unknown.`,
    push_argv: ['git', '-C', state.repository, 'push', destination, `${state.candidate_sha}:refs/heads/${head}`],
    reconciliation: 'Before any push/create, read the remote base/head and existing PRs. Existing exact head/base draft is success; a differing or closed PR is a conflict. After an unknown result, reconcile before retry. Never force-push.',
    review: review.evidence };
  if (previous) {
    if (JSON.stringify(previous.data.payload) !== JSON.stringify(plan)) throw new Error('Draft publication intent changed');
    return { status: 'reconcile', ...plan };
  }
  await lock.append('action/intent', { task_id: id, action_id, payload: plan });
  return { status: 'ready', ...plan };
}

export function validateDraftReceipt(plan, receipt) {
  if (receipt.repository !== plan.repository || receipt.head !== plan.head || receipt.base !== plan.base ||
      receipt.head_sha !== plan.head_sha || receipt.base_sha !== plan.base_sha || receipt.draft !== true ||
      receipt.state !== 'open' || !Number.isSafeInteger(receipt.number) || receipt.number < 1 ||
      receipt.url !== `https://github.com/${plan.repository}/pull/${receipt.number}`) throw new Error('Draft PR receipt must match the exact approved source and destination');
}

export async function recordDraft({ root, id, lock, receipt }) {
  const events = await readJournal(root);
  const event = events.filter(event => event.type === 'action/intent' && event.data.task_id === id && event.data.payload?.head_sha === receipt.head_sha && event.data.action_id.startsWith('draft-pr-')).at(-1);
  if (!event) throw new Error('No matching publication intent');
  validateDraftReceipt(event.data.payload, receipt);
  const previous = events.find(item => item.type === 'candidate/pr-created' && item.data.action_id === event.data.action_id);
  if (previous) {
    if (previous.data.url !== receipt.url) throw new Error('Conflicting draft receipt');
    if (!events.some(item => item.type === 'action/result' && item.data.action_id === event.data.action_id))
      await lock.append('action/result', { task_id: id, action_id: event.data.action_id, result: 'confirmed', evidence: previous.data.evidence });
    return previous.data;
  }
  const evidence = await putArtifact(root, encode(receipt));
  const result = { task_id: id, action_id: event.data.action_id, head_sha: receipt.head_sha, url: receipt.url, evidence };
  await lock.append('candidate/pr-created', result);
  await lock.append('action/result', { task_id: id, action_id: event.data.action_id, result: 'confirmed', evidence });
  return result;
}
