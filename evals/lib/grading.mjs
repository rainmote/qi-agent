/** Validate the external Node test runner's TAP, not the agent's completion claim.
 * This catches missing/skipped/early-exit tests. It is not a proof against arbitrary
 * malicious code exploiting the runtime; run submitted code in a separate container.
 */
export function assessTap(stdout, expectedNames) {
  const fail = (reason, extra = {}) => ({ passed: false, complete: false, reason, tests: null, passed_tests: null, ...extra });
  if (typeof stdout !== 'string' || !Array.isArray(expectedNames) || !expectedNames.length ||
      expectedNames.some((name) => typeof name !== 'string' || !name || /[\r\n]/.test(name)) ||
      new Set(expectedNames).size !== expectedNames.length) return fail('invalid_expected_tests');
  const lines = stdout.split(/\r?\n/);
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = lines.map((line) => line.match(new RegExp('^# ' + key + ' ([0-9]+)$'))).filter(Boolean);
    if (matches.length !== 1) return fail('missing_or_duplicate_summary_' + key);
    counts[key] = Number(matches[0][1]);
  }
  const completions = lines.map((line) => line.match(/^(ok|not ok) ([0-9]+) - (.*)$/)).filter(Boolean);
  const completedNames = completions.map((match) => match[3]);
  const expected = new Set(expectedNames);
  const complete = counts.tests === expected.size && completions.length === expected.size &&
    new Set(completedNames).size === expected.size && completedNames.every((name) => expected.has(name)) &&
    counts.pass + counts.fail === counts.tests && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0;
  if (!complete) return fail('acceptance_tests_incomplete', { tests: counts.tests, passed_tests: counts.pass });
  const passed = counts.fail === 0 && counts.pass === expected.size && completions.every((match) => match[1] === 'ok');
  return { passed, complete: true, reason: passed ? null : 'acceptance_assertions_failed',
    tests: counts.tests, passed_tests: counts.pass };
}
