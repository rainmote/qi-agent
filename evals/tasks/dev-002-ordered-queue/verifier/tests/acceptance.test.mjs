import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/queue.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('different ids execute FIFO with only one pending handler', async () => {
  const gate = deferred();
  const starts = [];
  let active = 0, maximum = 0;
  const queue = createQueue(async (payload, id) => {
    active += 1;
    maximum = Math.max(maximum, active);
    starts.push([id, payload]);
    await gate.promise;
    active -= 1;
    return payload * 2;
  });
  const results = [queue.enqueue('a', 1), queue.enqueue('b', 2), queue.enqueue('c', 3)];
  await turn();
  const beforeRelease = starts.slice();
  gate.resolve();
  assert.deepEqual(await Promise.all(results), [2, 4, 6]);
  assert.deepEqual(beforeRelease, [['a', 1]]);
  assert.equal(maximum, 1);
  assert.deepEqual(starts, [['a', 1], ['b', 2], ['c', 3]]);
});

test('duplicate ids keep the first payload and exact promise before and after completion', async () => {
  const calls = [];
  const queue = createQueue((payload, id) => { calls.push([id, payload]); return payload; });
  const first = queue.enqueue('same', 10);
  const duplicate = queue.enqueue('same', 20);
  const identities = first === duplicate;
  await Promise.all([first, duplicate]);
  const after = queue.enqueue('same', 30);
  await after;
  assert.equal(identities, true);
  assert.strictEqual(after, first);
  assert.deepEqual(calls, [['same', 10]]);
});

test('rejected tasks are deduplicated and later tasks still run', async () => {
  const error = new Error('failed once');
  const calls = [];
  const queue = createQueue((payload, id) => {
    calls.push(id);
    if (id === 'bad') throw error;
    return payload;
  });
  const first = queue.enqueue('bad', 0);
  await assert.rejects(first, (actual) => actual === error);
  const again = queue.enqueue('bad', 1);
  await assert.rejects(again, (actual) => actual === error);
  const next = queue.enqueue('ok', 5);
  assert.equal(await next, 5);
  assert.strictEqual(first, again);
  assert.deepEqual(calls, ['bad', 'ok']);
  assert.equal(await queue.drain(), undefined);
});

test('drain resolves despite rejection', async () => {
  const queue = createQueue(() => Promise.reject(new Error('expected')));
  await assert.rejects(queue.enqueue('bad', null), /expected/);
  assert.equal(await queue.drain(), undefined);
});

test('drain captures only work accepted before its invocation', async () => {
  const firstGate = deferred(), secondGate = deferred();
  const queue = createQueue((payload) => payload);
  const first = queue.enqueue('first', firstGate.promise);
  let drained = false;
  const barrier = queue.drain().then((value) => { assert.equal(value, undefined); drained = true; });
  const second = queue.enqueue('second', secondGate.promise);
  await turn();
  assert.equal(drained, false);
  firstGate.resolve('first done');
  await turn();
  const capturedBoundary = drained;
  secondGate.resolve('second done');
  await Promise.all([first, second, barrier]);
  assert.equal(capturedBoundary, true);
});

test('validation, empty drain, unusual ids, and independent instances', async () => {
  assert.throws(() => createQueue(null), TypeError);
  let count = 0;
  const queue = createQueue(() => ++count);
  for (const id of ['', null, undefined, 7, {}]) assert.throws(() => queue.enqueue(id, 0), TypeError);
  assert.equal(await queue.drain(), undefined);
  assert.equal(await queue.enqueue('__proto__', 0), 1);
  assert.equal(await queue.enqueue(' ', 0), 2);
  const other = createQueue(() => 99);
  assert.equal(await other.enqueue('__proto__', 0), 99);
  assert.equal(count, 2);
});
