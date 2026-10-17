import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTap } from '../lib/grading.mjs';

const summary = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
test('TAP grader requires all expected tests with no skip, cancellation or early exit', () => {
  assert.equal(assessTap('ok 1 - case A\nok 2 - case B\n' + summary, ['case A', 'case B']).passed, true);
  assert.equal(assessTap('ok 1 - acceptance.test.mjs\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0', ['case A', 'case B']).passed, false);
  assert.equal(assessTap('ok 1 - case A\nok 2 - case B # SKIP\n' + summary.replace('# skipped 0', '# skipped 1'), ['case A', 'case B']).passed, false);
  assert.equal(assessTap('# ok 1 - case A\n# ok 2 - case B\n' + summary, ['case A', 'case B']).passed, false);
  assert.equal(assessTap('ok 1 - case A\nok 2 - case B\n' + summary + summary, ['case A', 'case B']).passed, false);
});
test('a complete failing baseline is distinguished from a broken verifier', () => {
  const baseline = assessTap('ok 1 - case A\nnot ok 2 - case B\n' + summary.replace('# pass 2', '# pass 1').replace('# fail 0', '# fail 1'), ['case A', 'case B']);
  assert.equal(baseline.complete, true);
  assert.equal(baseline.passed, false);
  assert.equal(baseline.reason, 'acceptance_assertions_failed');
  assert.equal(assessTap('SyntaxError', ['case A', 'case B']).complete, false);
});
