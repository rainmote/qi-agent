import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suites } from './ui-cases.mjs';
import { validateUIResult } from './ui-results.mjs';

for (const suite of ['composer', 'transcript']) {
  test(`${suite}: incomplete or misleading browser evidence cannot pass`, async t => {
    const folder = await mkdtemp(join(tmpdir(), 'qi-ui-results-'));
    t.after(() => rm(folder, { recursive: true, force: true }));
    await writeFile(join(folder, 'capture.png'), 'nonempty fixture image');
    const good = { status: 'PASS', headless: true, engine: 'chromium', browserVersion: 'test-version',
      interrupted: false, errors: [], cleanup: { browser: 'closed' },
      cases: suites[suite].specs.map(spec => ({ id: spec.id, status: 'PASS', screenshot: 'capture.png',
        assertions: Object.fromEntries(spec.assertions.map(name => [name, true])) })) };
    const validate = result => validateUIResult(result, { suite, engine: 'chromium', folder });
    assert.equal((await validate(good)).total, good.cases.length);
    const bad = [
      ['zero cases', result => { result.cases = []; }],
      ['missing case', result => { result.cases.pop(); }],
      ['duplicate case', result => { result.cases[1] = result.cases[0]; }],
      ['missing assertion', result => { delete result.cases[0].assertions[Object.keys(result.cases[0].assertions)[0]]; }],
      ['false assertion', result => { result.cases[0].assertions[Object.keys(result.cases[0].assertions)[0]] = false; }],
      ['truthy non-boolean', result => { result.cases[0].assertions[Object.keys(result.cases[0].assertions)[0]] = 'PASS'; }],
      ['missing screenshot', result => { result.cases[0].screenshot = 'missing.png'; }],
      ['different engine', result => { result.engine = 'webkit'; }],
      ['interrupted', result => { result.interrupted = true; }],
      ['page error', result => { result.errors = ['render failed']; }],
      ['unconfirmed cleanup', result => { result.cleanup.browser = 'UNCONFIRMED'; }],
      ...['FAIL', 'NOT_RUN', 'SKIP', 'CANCELLED', 'TIMED_OUT', 'RUNNING'].map(status =>
        [status, result => { result.cases[0].status = status; }]),
    ];
    for (const [name, mutate] of bad) await t.test(name, async () => {
      const result = structuredClone(good); mutate(result); await assert.rejects(validate(result));
    });
  });
}
