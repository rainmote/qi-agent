import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestStore } from '../src/request-store.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('initial state and independent snapshots', async () => {
  const store = createRequestStore();
  const initial = store.getState();
  assert.deepEqual(initial, { status: 'idle', value: null, error: null });
  initial.status = 'tampered';
  assert.equal(store.getState().status, 'idle');
  const snapshot = store.getState();
  const value = { nested: true };
  assert.strictEqual(await store.request(() => value), value);
  assert.strictEqual(store.getState().value, value);
  assert.equal(snapshot.status, 'idle');
});

test('newest success wins while each promise keeps its own value', async () => {
  const store = createRequestStore();
  const old = deferred(), latest = deferred();
  const first = store.request(() => old.promise);
  const second = store.request(() => latest.promise);
  latest.resolve('new');
  assert.equal(await second, 'new');
  old.resolve('old');
  assert.equal(await first, 'old');
  assert.deepEqual(store.getState(), { status: 'success', value: 'new', error: null });
});

test('older success cannot stop the newest loading state', async () => {
  const store = createRequestStore();
  await store.request(() => 'retained');
  const old = deferred(), latest = deferred();
  const first = store.request(() => old.promise);
  const second = store.request(() => latest.promise);
  old.resolve('obsolete');
  await first;
  const during = store.getState();
  latest.resolve('latest');
  await second;
  assert.deepEqual(during, { status: 'loading', value: 'retained', error: null });
});

test('stale rejection is delivered to caller without changing newer success', async () => {
  const store = createRequestStore();
  const old = deferred();
  const error = new Error('old failure');
  const first = store.request(() => old.promise);
  const rejected = assert.rejects(first, (actual) => actual === error);
  await store.request(() => 'new');
  old.reject(error);
  await rejected;
  assert.deepEqual(store.getState(), { status: 'success', value: 'new', error: null });
});

test('current failure preserves value, and next loading clears the error', async () => {
  const store = createRequestStore();
  await store.request(() => 17);
  const error = new Error('sync failure');
  await assert.rejects(store.request(() => { throw error; }), (actual) => actual === error);
  assert.deepEqual(store.getState(), { status: 'error', value: 17, error });
  const next = deferred();
  const pending = store.request(() => next.promise);
  const during = store.getState();
  next.resolve(0);
  await pending;
  assert.deepEqual(during, { status: 'loading', value: 17, error: null });
  assert.deepEqual(store.getState(), { status: 'success', value: 0, error: null });
});

test('reset invalidates pending success and pending failure', async () => {
  const store = createRequestStore();
  const old = deferred(), latest = deferred();
  const first = store.request(() => old.promise);
  const second = store.request(() => latest.promise);
  const failure = new Error('after reset');
  const rejected = assert.rejects(second, (actual) => actual === failure);
  store.reset('reset value');
  old.resolve('old');
  latest.reject(failure);
  await Promise.all([first, rejected]);
  assert.deepEqual(store.getState(), { status: 'idle', value: 'reset value', error: null });
  await store.request(() => 'after reset');
  assert.equal(store.getState().value, 'after reset');
  store.reset();
  assert.deepEqual(store.getState(), { status: 'idle', value: null, error: null });
});
