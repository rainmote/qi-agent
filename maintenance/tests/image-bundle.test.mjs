import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedImageBundle } from '../lib/image-bundle.mjs';

const sha = 'a'.repeat(40), baseline = 'b'.repeat(40), id = 'sha256:' + 'c'.repeat(64);
const image = { source_sha: sha, image: id, platform: 'linux/arm64', baseline_sha: baseline, status: 'BUILT' };
const report = { source_sha: sha, image: id, status: 'PASS', model_calls: 0 };
const full = { ...report, base_sha: baseline, task_status: 'review_ready', current_source_suite: { exit_code: 0 },
  dependency_lock_rejection: { exit_code: 1, stdout: '', stderr: 'Dependency lock pair does not match a reviewed image source' } };

test('portable image bundles require matching source, architecture and all three verification reports', () => {
  const result = verifiedImageBundle(sha, image, full, report, report);
  assert.equal(result.image, id); assert.equal(result.live_model_qualification, 'NOT_RUN');
  for (const bad of [{ ...image, status: 'FAILED' }, { ...image, source_sha: baseline }, { ...image, platform: 'linux/amd64' }]) {
    assert.throws(() => verifiedImageBundle(sha, bad, full, report, report));
  }
  for (const bad of [undefined, { ...report, status: 'FAIL' }, { ...report, source_sha: baseline },
    { ...report, image: 'sha256:' + 'd'.repeat(64) }, { ...report, model_calls: 1 }]) {
    assert.throws(() => verifiedImageBundle(sha, image, full, bad, report));
    assert.throws(() => verifiedImageBundle(sha, image, full, report, bad));
  }
});

test('an aggregate PASS cannot hide failed current checks, truncated evidence or a bypassed lock gate', () => {
  for (const patch of [{ base_sha: sha }, { task_status: 'uncertain' }, { current_source_suite: { exit_code: 1 } },
    { current_source_suite: { exit_code: 0, timed_out: true } }, { current_source_suite: { exit_code: 0, output_limited: true } },
    { dependency_lock_rejection: { exit_code: 1, stderr: 'unrelated error' } },
    { dependency_lock_rejection: { ...full.dependency_lock_rejection, stdout: 'unreviewed process started' } }]) {
    assert.throws(() => verifiedImageBundle(sha, image, { ...full, ...patch }, report, report));
  }
});
