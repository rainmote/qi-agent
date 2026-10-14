import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkCommit, checkReview, resolveTag, allPages, githubClient, REQUIRED_JOBS } from '../lib/github.mjs';
import { TARGETS, checkAssets } from '../lib/assets.mjs';

const sha = 'a'.repeat(40), repository = 'rainmote/qi-agent';
const workflow = { id: 10, path: '.github/workflows/ci.yml', state: 'active' };
const green = { id: 20, workflow_id: 10, path: workflow.path, repository: { full_name: repository },
  head_repository: { full_name: repository }, head_sha: sha, head_branch: 'main', event: 'push',
  run_attempt: 2, status: 'completed', conclusion: 'success' };
const jobs = REQUIRED_JOBS.map((name, i) => ({ id: i + 100, name, head_sha: sha, run_id: 20, run_attempt: 2, status: 'completed', conclusion: 'success' }));
function fixture(runs = [green], checks = jobs, after = runs) {
  let listings = 0;
  return async (url) => {
    if (url.endsWith('/ci.yml')) return structuredClone(workflow);
    if (url.includes('/attempts/2/jobs')) return { total_count: checks.length, jobs: structuredClone(checks) };
    if (url.includes('/runs?')) {
      const value = listings++ ? after : runs;
      return { total_count: value.length, workflow_runs: structuredClone(value) };
    }
    throw new Error('Unexpected request ' + url);
  };
}

test('release requires all jobs of the exact main commit and exact latest attempt', async () => {
  assert.equal((await checkCommit({ repository, sha, api: fixture() })).status, 'PASS');
  const previous = { ...green, id: 19, run_attempt: 1 };
  const failure = { ...green, conclusion: 'failure' };
  assert.equal((await checkCommit({ repository, sha, api: fixture([previous, failure]) })).status, 'FAIL');
  assert.equal((await checkCommit({ repository, sha, api: fixture([{ ...green, head_sha: 'b'.repeat(40) }]) })).status, 'NOT_RUN');
  assert.equal((await checkCommit({ repository, sha, api: fixture([{ ...green, event: 'pull_request' }]) })).status, 'NOT_RUN');
});

test('missing, skipped, cancelled, timed out and stale jobs cannot qualify a release', async () => {
  for (const conclusion of ['skipped', 'cancelled', 'timed_out', 'neutral', null]) {
    const checks = [{ ...jobs[0], conclusion }, ...jobs.slice(1)];
    assert.equal((await checkCommit({ repository, sha, api: fixture([green], checks) })).status, 'FAIL');
  }
  for (const checks of [jobs.slice(1), [...jobs, { ...jobs[0], id: 999 }], [{ ...jobs[0], run_attempt: 1 }, ...jobs.slice(1)],
    [{ ...jobs[0], head_sha: 'b'.repeat(40) }, ...jobs.slice(1)]]) {
    assert.notEqual((await checkCommit({ repository, sha, api: fixture([green], checks) })).status, 'PASS');
  }
});

test('workflow origin, API errors and concurrent reruns fail closed', async () => {
  for (const run of [{ ...green, workflow_id: 11 }, { ...green, head_repository: { full_name: 'other/fork' } },
    { ...green, path: '.github/workflows/fake.yml' }]) {
    assert.equal((await checkCommit({ repository, sha, api: fixture([run]) })).status, 'UNKNOWN');
  }
  assert.equal((await checkCommit({ repository, sha, api: async () => { throw new Error('403'); } })).status, 'UNKNOWN');
  assert.equal((await checkCommit({ repository, sha, api: fixture([green], jobs, [{ ...green, run_attempt: 3 }]) })).status, 'UNKNOWN');
  await assert.rejects(githubClient({ fetchImpl: async () => ({ ok: false, status: 403 }) })('/repos/a/b'), /403/);
});

test('pagination collects every page and refuses truncation or races', async () => {
  const api = async (url) => ({ total_count: 101, jobs: url.endsWith('page=1') ?
    Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }] });
  assert.equal((await allPages(api, '/jobs', 'jobs')).length, 101);
  for (const api of [async () => ({ total_count: 2, jobs: [{ id: 1 }] }),
    async () => ({ total_count: 1000, jobs: [] }), async () => ({ total_count: 2, jobs: [] })]) {
    await assert.rejects(allPages(api, '/jobs', 'jobs'), /pagination|identity/);
  }
});

test('head and base movement invalidate review; annotated tags are peeled', async () => {
  const args = { reviewedHead: sha, currentHead: sha, verifiedBase: sha, currentBase: sha, verification: 'PASS' };
  assert.equal(checkReview(args), true);
  assert.equal(checkReview({ ...args, currentHead: 'b'.repeat(40) }), false);
  assert.equal(checkReview({ ...args, currentBase: 'b'.repeat(40) }), false);
  assert.equal(await resolveTag({ repository, tag: 'v0.1.0', api: async (url) => ({ object:
    { type: url.includes('/ref/') ? 'tag' : 'commit', sha } }) }), sha);
  await assert.rejects(resolveTag({ repository, tag: '../main' }), /version tag/);
});

test('all four source-bound release assets and original checksums are mandatory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-assets-'));
  try {
    const tag = 'v0.1.0';
    for (const target of TARGETS) {
      const asset = `qi-agent-${tag}-${target}.tar.gz`;
      const sha256 = createHash('sha256').update(target).digest('hex');
      await fs.writeFile(path.join(directory, asset), target);
      await fs.writeFile(path.join(directory, asset + '.sha256'), `${sha256}  ${asset}\n`);
      await fs.writeFile(path.join(directory, asset + '.source.json'), JSON.stringify({ asset, sha, tag, sha256 }));
    }
    assert.equal((await checkAssets({ directory, tag, sha })).status, 'PASS');
    await fs.writeFile(path.join(directory, `qi-agent-${tag}-${TARGETS[0]}.tar.gz`), 'tampered');
    await assert.rejects(checkAssets({ directory, tag, sha }), /checksum mismatch/);
    await fs.unlink(path.join(directory, `qi-agent-${tag}-${TARGETS[0]}.tar.gz`));
    await assert.rejects(checkAssets({ directory, tag, sha }), /incomplete/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
