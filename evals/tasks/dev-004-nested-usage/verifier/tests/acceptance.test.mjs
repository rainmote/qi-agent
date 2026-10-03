import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateUsage } from '../src/usage.mjs';

const counts = (input = 0, output = 0, cached = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached });
const event = (run, id, parent = null, usage = {}) => ({ run_id: run, event_id: id, parent_run_id: parent, usage });

test('empty ledger and missing counters', () => {
  assert.deepEqual(aggregateUsage([]), { total: counts(), runs: [] });
  const result = aggregateUsage([event('root', '1', null, { output_tokens: 4 })]);
  assert.deepEqual(result, { total: counts(0, 4), runs: [{
    run_id: 'root', parent_run_id: null, own: counts(0, 4), subtree: counts(0, 4),
  }] });
});

test('out-of-order nested runs, multi-root totals, duplicates, and cached subset', () => {
  const leaf = event('leaf', 'call', 'child', counts(2, 3, 1));
  const events = [leaf, event('z-root', 'call', null, counts(5, 1)),
    event('root', 'call', null, counts(10, 2, 4)), event('child', 'call', 'root', counts(7, 2, 2)),
    structuredClone(leaf), event('root', 'compression', null, counts(3, 1, 1))];
  const before = structuredClone(events);
  const actual = aggregateUsage(events);
  assert.deepEqual(actual, { total: counts(27, 9, 8), runs: [
    { run_id: 'child', parent_run_id: 'root', own: counts(7, 2, 2), subtree: counts(9, 5, 3) },
    { run_id: 'leaf', parent_run_id: 'child', own: counts(2, 3, 1), subtree: counts(2, 3, 1) },
    { run_id: 'root', parent_run_id: null, own: counts(13, 3, 5), subtree: counts(22, 8, 8) },
    { run_id: 'z-root', parent_run_id: null, own: counts(5, 1), subtree: counts(5, 1) },
  ] });
  assert.deepEqual(events, before);
  assert.deepEqual(aggregateUsage([...events].reverse()), actual);
  actual.runs[1].own.input_tokens = 999;
  assert.equal(actual.runs[1].subtree.input_tokens, 2);
  assert.equal(actual.total.input_tokens, 27);
});

test('deduplication uses a tuple, ignores extras, and normalizes absent counters', () => {
  const events = [event('a', 'b:c'), event('a:b', 'c'),
    { ...event('a', 'b:c', null, counts()), ignored: true }];
  const result = aggregateUsage(events);
  assert.deepEqual(result.runs.map((run) => run.run_id), ['a', 'a:b']);
  assert.deepEqual(result.total, counts());
  assert.deepEqual(aggregateUsage([event('x', 'same', null, {}),
    event('x', 'same', null, { input_tokens: undefined })]).total, counts());
});

test('duplicate conflicts and inconsistent run parents are rejected', () => {
  assert.throws(() => aggregateUsage([event('r', '1'), event('r', '1', null, counts(1))]), TypeError);
  assert.throws(() => aggregateUsage([event('p', '1'), event('r', '1'), event('r', '1', 'p')]), TypeError);
  assert.throws(() => aggregateUsage([event('p', '1'), event('r', '1'), event('r', '2', 'p')]), TypeError);
});

test('missing parents, self references, and disconnected cycles are rejected', () => {
  for (const events of [
    [event('r', '1', 'missing')], [event('r', '1', 'r')],
    [event('ok', '1'), event('a', '1', 'b'), event('b', '1', 'a')],
  ]) assert.throws(() => aggregateUsage(events), TypeError);
});

test('validation rejects malformed ledgers and unsafe or inconsistent counters', () => {
  for (const input of [null, {}, 1, 'events']) assert.throws(() => aggregateUsage(input), TypeError);
  for (const record of [null, [], {}, event('', '1'), event('r', ''), event('r', '1', ''),
    { ...event('r', '1'), parent_run_id: undefined }, event('r', '1', null, null),
    event('r', '1', null, []), event('r', '1', null, counts(1, 0, 2))]) {
    assert.throws(() => aggregateUsage([record]), TypeError);
  }
  for (const value of [-1, 1.2, NaN, Infinity, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of Object.keys(counts())) {
      assert.throws(() => aggregateUsage([event('r', '1', null, { [key]: value })]), TypeError);
    }
  }
});

test('aggregated overflow is rejected within a run, subtree, or separate roots', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  for (const events of [
    [event('r', '1', null, counts(maximum)), event('r', '2', null, counts(1))],
    [event('r', '1', null, counts(maximum)), event('c', '1', 'r', counts(1))],
    [event('a', '1', null, counts(maximum)), event('b', '1', null, counts(1))],
  ]) assert.throws(() => aggregateUsage(events), RangeError);
});

test('deep frozen input is accepted and deeply nested runs do not overflow the call stack', () => {
  const size = 12000;
  const events = Array.from({ length: size }, (_, index) => Object.freeze(event(
    String(index), '1', index === 0 ? null : String(index - 1), Object.freeze(counts(1)),
  )));
  const result = aggregateUsage(Object.freeze(events));
  assert.equal(result.total.input_tokens, size);
  assert.equal(result.runs.find((run) => run.run_id === '0').subtree.input_tokens, size);
});
