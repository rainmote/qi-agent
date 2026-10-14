import { execFileSync } from 'node:child_process';
import { commitSHA } from './github.mjs';
import { putArtifact, encode, readJournal, validateArtifacts } from './store.mjs';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

export async function reviewWindow({ repo, root, start, end, limit = 50 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Review limit must be 1..500');
  const events = await readJournal(root);
  await validateArtifacts(root, events);
  const cursor = events.filter((event) => event.type === 'reflection/reviewed').at(-1)?.data.end_sha;
  if (cursor && start && start !== cursor) throw new Error('Explicit start disagrees with the durable review cursor');
  start = commitSHA(cursor ?? start);
  end = commitSHA(end);
  git(repo, 'merge-base', '--is-ancestor', start, end);
  // First-parent history makes each partial window a contiguous, replayable range.
  const commits = git(repo, 'rev-list', '--first-parent', '--reverse', `${start}..${end}`).split('\n').filter(Boolean);
  const selected = commits.slice(0, limit);
  return { start_sha: start, end_sha: selected.at(-1) ?? start, requested_end_sha: end,
    commits: selected, remaining: commits.length - selected.length, quiet: selected.length === 0 };
}

export async function recordReview({ repo, root, lock, window, report }) {
  const current = await reviewWindow({ repo, root, start: window.start_sha, end: window.requested_end_sha, limit: Math.max(1, window.commits.length) });
  if (JSON.stringify(current) !== JSON.stringify(window)) throw new Error('Review window changed');
  if (window.quiet) return { quiet: true };
  if (typeof report?.summary !== 'string' || !report.summary.trim() ||
      JSON.stringify(report.reviewed_commits) !== JSON.stringify(window.commits)) throw new Error('Report must cover exactly the declared commit window');
  // The journal is the cursor: no second mutable cursor can outrun the saved report.
  const artifact = await putArtifact(root, encode(report));
  await lock.append('reflection/reviewed', { ...window, report: artifact });
  return { end_sha: window.end_sha, report: artifact };
}

export function lessonState(incidents, patternKey) {
  const unique = new Map();
  for (const incident of incidents.filter((item) => item.pattern_key === patternKey)) {
    if (!incident.incident_id || !incident.occurred_at || !incident.evidence?.length) throw new Error('Lesson requires incident identity, date and evidence');
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(incident.occurred_at));
    if (unique.has(incident.incident_id) && unique.get(incident.incident_id) !== date) throw new Error('One incident cannot acquire a new occurrence date through repeated review');
    unique.set(incident.incident_id, date);
  }
  const days = [...new Set(unique.values())].sort();
  return { pattern_key: patternKey, seen: unique.size, distinct_days: days, proposal_ready: days.length >= 3,
    promoted: false, rule_review_required: true };
}
