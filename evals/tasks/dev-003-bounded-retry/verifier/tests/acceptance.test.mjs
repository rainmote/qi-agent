import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryable, runWithRetry } from '../src/retry.mjs';

test('classifier respects explicit overrides and abort precedence', () => {
  for (const error of [
    { retryable: true }, { status: 429 }, { status: 500 }, { status: 599 },
    { code: 'ETIMEDOUT' }, { code: 'ECONNRESET' }, { retryable: true, status: 400 },
  ]) assert.equal(isRetryable(error), true, JSON.stringify(error));
  for (const error of [
    null, undefined, 'timeout', 500, false, () => {}, {}, new Error('unknown'),
    { status: '500' }, { status: 500.5 }, { status: 499 }, { status: 600 },
    { code: 'EACCES' }, { retryable: false, status: 503 },
    { name: 'AbortError', retryable: true, status: 503 },
  ]) assert.equal(isRetryable(error), false, String(error));
});

test('immediate success returns identity with no sleep', async () => {
  const result = { ok: true };
  const attempts = [], delays = [];
  assert.strictEqual(await runWithRetry((attempt) => { attempts.push(attempt); return result; }, {
    sleep: async (delay) => { delays.push(delay); },
  }), result);
  assert.deepEqual(attempts, [1]);
  assert.deepEqual(delays, []);
});

test('exponential backoff is capped and attempt numbers are one-based', async () => {
  const attempts = [], delays = [];
  const result = await runWithRetry(async (attempt) => {
    attempts.push(attempt);
    if (attempt < 5) throw { status: 503, attempt };
    return 'recovered';
  }, { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 25, sleep: async (delay) => delays.push(delay) });
  assert.equal(result, 'recovered');
  assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
  assert.deepEqual(delays, [10, 20, 25, 25]);
});

test('default retry limit and final error identity', async () => {
  const errors = [1, 2, 3].map((n) => Object.assign(new Error(String(n)), { code: 'ETIMEDOUT' }));
  let calls = 0;
  const delays = [];
  await assert.rejects(runWithRetry(() => { throw errors[calls++]; }, {
    sleep: async (delay) => delays.push(delay),
  }), (actual) => actual === errors[2]);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test('fatal and abort failures stop immediately without sleep', async () => {
  for (const error of [Object.assign(new Error('fatal'), { status: 400 }),
    { name: 'AbortError', retryable: true }, { retryable: false, status: 503 }, null]) {
    let calls = 0, sleeps = 0;
    const promise = runWithRetry(() => { calls += 1; throw error; }, { sleep: async () => { sleeps += 1; } });
    const captured = await promise.then(() => ({ resolved: true }), (actual) => ({ actual }));
    assert.strictEqual(captured.actual, error);
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
  }
});

test('sleep must complete before the next attempt and its failure ends retries', async () => {
  const stopped = new Error('sleep failure');
  let calls = 0;
  await assert.rejects(runWithRetry(() => { calls += 1; throw { status: 429 }; }, {
    sleep: async () => { throw stopped; },
  }), (actual) => actual === stopped);
  assert.equal(calls, 1);
  const sequence = [];
  await runWithRetry((attempt) => {
    sequence.push(`attempt:${attempt}`);
    if (attempt === 1) throw { retryable: true };
  }, { sleep: async () => { await Promise.resolve(); sequence.push('sleep:done'); } });
  assert.deepEqual(sequence, ['attempt:1', 'sleep:done', 'attempt:2']);
});

test('zero delays and one-attempt budget have no extra waits', async () => {
  const delays = [];
  await runWithRetry((attempt) => { if (attempt < 4) throw { retryable: true }; }, {
    maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0, sleep: async (delay) => delays.push(delay),
  });
  assert.deepEqual(delays, [0, 0, 0]);
  const error = { retryable: true };
  await assert.rejects(runWithRetry(() => { throw error; }, {
    maxAttempts: 1, sleep: () => assert.fail('must not sleep'),
  }), (actual) => actual === error);
});

test('configuration validation happens before operation', async () => {
  const invalid = [
    { maxAttempts: 0 }, { maxAttempts: -1 }, { maxAttempts: 1.5 }, { maxAttempts: Infinity },
    { maxAttempts: Number.MAX_SAFE_INTEGER + 1 }, { maxAttempts: '3' },
    { baseDelayMs: -1 }, { baseDelayMs: NaN }, { baseDelayMs: '1' },
    { maxDelayMs: -1 }, { maxDelayMs: Infinity }, { maxDelayMs: null }, { sleep: 1 },
  ];
  for (const options of invalid) {
    let called = false;
    await assert.rejects(runWithRetry(() => { called = true; }, options), TypeError);
    assert.equal(called, false);
  }
  await assert.rejects(runWithRetry(null), TypeError);
});
