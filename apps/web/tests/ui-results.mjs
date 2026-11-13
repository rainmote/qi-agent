import assert from 'node:assert/strict';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { suites } from './ui-cases.mjs';

// Exit 0 alone is insufficient: skipped, duplicate or missing cases/assertions
// and receipts for a different engine must never qualify the UI check.
export async function validateUIResult(result, { suite, engine, folder }) {
  const expected = suites[suite].specs;
  assert.equal(result.status, 'PASS', 'Suite result is not PASS');
  assert.equal(result.headless, true);
  assert.equal(result.engine, engine, 'Wrong browser engine');
  assert.equal(typeof result.browserVersion, 'string');
  assert(result.browserVersion.length > 0, 'Missing browser version');
  assert.equal(result.interrupted, false, 'Interrupted suite');
  assert.deepEqual(result.errors, [], 'Browser errors');
  assert.equal(result.cleanup?.browser, 'closed', 'Browser cleanup unconfirmed');
  assert.deepEqual(result.cases.map(row => row.id).sort(), expected.map(row => row.id).sort(), 'Missing or duplicate required scenarios');
  const root = await realpath(folder);
  for (const row of result.cases) {
    assert.equal(row.status, 'PASS', `Scenario ${row.id} did not pass`);
    const spec = expected.find(spec => spec.id === row.id);
    assert.deepEqual(Object.keys(row.assertions).sort(), [...spec.assertions].sort(), `Missing assertions for ${row.id}`);
    assert(Object.values(row.assertions).every(value => value === true), `Failed assertions for ${row.id}`);
    assert.equal(typeof row.screenshot, 'string', 'Missing screenshot');
    const path = await realpath(resolve(root, row.screenshot));
    assert(path.startsWith(root + sep), 'Screenshot escaped evidence directory');
    const stat = await lstat(path);
    assert(stat.isFile() && stat.size > 0, 'Missing screenshot');
  }
  return { total: result.cases.length, passed: result.cases.length, failed: 0, notRun: 0 };
}
