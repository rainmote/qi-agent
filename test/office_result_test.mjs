// Pure production-result policy, no React/browser/Host/native operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { officeResult } from '../apps/web/src/office-result.ts';

test('only a confirmed canonical result permits opening the generated PDF', () => {
  assert.deepEqual(officeResult({ converted: true, output: 'nested/result.pdf', bytes: 100 }),
    { output: 'nested/result.pdf', bytes: 100, previewable: true });
  for (const result of [null, { blocked: true }, { converted: false, output: 'result.pdf', bytes: 10 },
    { converted: true, output: '../result.pdf', bytes: 10 }, { converted: true, output: '/result.pdf', bytes: 10 },
    { converted: true, output: 'result.html', bytes: 10 }, { converted: true, output: 'result.pdf', bytes: 40_000_001 }]) {
    assert.throws(() => officeResult(result));
  }
});

test('large successful output remains distinct from an allowed inline preview', () => {
  assert.equal(officeResult({ converted: true, output: 'large.pdf', bytes: 20_000_000 }).previewable, false);
});
