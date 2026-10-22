import { immutableImage } from './execution.mjs';

export function verifiedImageBundle(source, image, full, broker, worker) {
  if (!/^[a-f0-9]{40}$/.test(source ?? '') || image?.source_sha !== source || image.status !== 'BUILT' || image.platform !== 'linux/arm64') {
    throw new Error('A built ARM64 image from the exact clean source is required');
  }
  immutableImage(image.image);
  for (const report of [full, broker, worker]) {
    if (report?.status !== 'PASS' || report.source_sha !== source || report.image !== image.image || report.model_calls !== 0) {
      throw new Error('Complete offline verification must match the exact source and image');
    }
  }
  const webChecks = full.current_web_checks;
  if (!Array.isArray(webChecks) || webChecks.length !== 2 ||
      !['production-browser', 'daemon-web-e2e'].every(id => webChecks.some(check =>
        check.id === id && check.source_sha === source && check.image === image.image &&
        check.exit_code === 0 && !check.timed_out && !check.output_limited))) {
    throw new Error('Image export requires complete current-source browser checks');
  }
  if (full.base_sha !== image.baseline_sha || full.task_status !== 'review_ready' || full.current_source_suite?.exit_code !== 0 ||
      full.current_source_suite.timed_out || full.current_source_suite.output_limited ||
      full.dependency_lock_rejection?.exit_code !== 1 || !/Dependency lock pair does not match/.test(full.dependency_lock_rejection.stderr ?? '') ||
      full.dependency_lock_rejection.stdout?.includes('unreviewed process started')) {
    throw new Error('Image export requires successful current-source checks and dependency rejection');
  }
  return { schema_version: 1, source_sha: source, image: image.image, platform: image.platform,
    baseline_sha: image.baseline_sha, verification: 'CI_OFFLINE_VERIFIED', live_model_qualification: 'NOT_RUN' };
}
