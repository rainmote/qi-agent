// Read-only GitHub gates. Missing data, pagination races and API errors fail closed.
export const REQUIRED_JOBS = Object.freeze([
  'Test (ubuntu-24.04)', 'Test (macos-14)',
  'MSRV 1.88 (ubuntu-24.04)', 'MSRV 1.88 (macos-14)', 'Dependency audit',
]);
export const commitSHA = (sha) => {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('An exact 40-character commit SHA is required');
  return sha;
};

export function githubClient({ token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  return async (endpoint) => {
    if (!endpoint.startsWith('/repos/') || endpoint.includes('..')) throw new Error('Invalid API endpoint');
    const response = await fetchImpl('https://api.github.com' + endpoint, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${endpoint}`);
    return response.json();
  };
}

export function repositoryPath(repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Expected owner/repository');
  return '/repos/' + repository;
}

export async function allPages(api, endpoint, field) {
  const records = [], ids = new Set();
  let total;
  for (let page = 1; page <= 10; page++) {
    const data = await api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 || data.total_count >= 1000 ||
        !Array.isArray(data[field]) || (total !== undefined && total !== data.total_count)) {
      throw new Error('Incomplete or changing GitHub pagination');
    }
    total = data.total_count;
    for (const item of data[field]) {
      if (!Number.isSafeInteger(item.id) || ids.has(item.id)) throw new Error('Duplicate or missing GitHub record identity');
      ids.add(item.id); records.push(item);
    }
    if (records.length === total) return records;
    if (!data[field].length || records.length > total) throw new Error('Incomplete GitHub pagination');
  }
  throw new Error('GitHub pagination limit exceeded');
}

function latestRun(runs, workflow, repository, sha) {
  // A PR merge-ref green run cannot qualify a main commit for release.
  const eligible = runs.filter((run) => run.head_sha === sha && run.head_branch === 'main' &&
    ['push', 'workflow_dispatch'].includes(run.event));
  for (const run of eligible) {
    if (run.workflow_id !== workflow.id || run.path !== '.github/workflows/ci.yml' ||
        run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
        !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
      throw new Error('CI workflow/source identity mismatch');
    }
  }
  return eligible.sort((a, b) => b.id - a.id)[0];
}

export async function checkCommit({ repository, sha, api = githubClient() }) {
  const report = { schema_version: 1, status: 'UNKNOWN', sha, repository, checked_at: new Date().toISOString(), reasons: [] };
  try {
    commitSHA(sha);
    const root = repositoryPath(repository);
    const workflow = await api(root + '/actions/workflows/ci.yml');
    if (workflow.path !== '.github/workflows/ci.yml' || !Number.isSafeInteger(workflow.id) || workflow.state !== 'active') {
      throw new Error('Expected active CI workflow was not found');
    }
    const endpoint = `${root}/actions/workflows/${workflow.id}/runs?head_sha=${sha}&branch=main`;
    const run = latestRun(await allPages(api, endpoint, 'workflow_runs'), workflow, repository, sha);
    if (!run) return { ...report, status: 'NOT_RUN', reasons: ['No main CI run for the exact commit'] };
    report.workflow_id = workflow.id; report.run_id = run.id; report.run_attempt = run.run_attempt;
    report.url = run.html_url;
    const jobs = await allPages(api, `${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
    report.jobs = REQUIRED_JOBS.map((name) => {
      const matches = jobs.filter((job) => job.name === name);
      if (matches.length !== 1) return { name, status: 'UNKNOWN', reason: 'Required job missing or duplicated' };
      const job = matches[0];
      const identity = job.head_sha === sha && job.run_id === run.id && job.run_attempt === run.run_attempt;
      return { name, id: job.id, status: identity && job.status === 'completed' && job.conclusion === 'success' ? 'PASS' : 'FAIL',
        conclusion: job.conclusion, reason: identity ? null : 'Job identity mismatch' };
    });
    // Re-read after pagination: a newly started rerun invalidates the earlier evidence.
    const current = latestRun(await allPages(api, endpoint, 'workflow_runs'), workflow, repository, sha);
    if (!current || current.id !== run.id || current.run_attempt !== run.run_attempt ||
        current.status !== run.status || current.conclusion !== run.conclusion) throw new Error('CI changed during verification');
    report.status = run.status === 'completed' && run.conclusion === 'success' && report.jobs.every((job) => job.status === 'PASS') ? 'PASS' : 'FAIL';
    if (report.status !== 'PASS') report.reasons.push('Latest exact-commit CI attempt and every required job must succeed');
  } catch (error) { report.status = 'UNKNOWN'; report.reasons.push(error.message); }
  return report;
}

export async function resolveTag({ repository, tag, api = githubClient() }) {
  if (!/^v[0-9][A-Za-z0-9.+-]*$/.test(tag ?? '')) throw new Error('Expected a version tag beginning with v');
  const root = repositoryPath(repository);
  let object = (await api(`${root}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
  for (let depth = 0; depth < 5; depth++) {
    commitSHA(object?.sha);
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag') break;
    object = (await api(`${root}/git/tags/${object.sha}`)).object;
  }
  throw new Error('Tag does not resolve to a commit');
}

export function checkReview({ reviewedHead, currentHead, verifiedBase, currentBase, verification }) {
  [reviewedHead, currentHead, verifiedBase, currentBase].forEach(commitSHA);
  return verification === 'PASS' && reviewedHead === currentHead && verifiedBase === currentBase;
}
