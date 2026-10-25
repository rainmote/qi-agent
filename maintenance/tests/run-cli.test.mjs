import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// Run from the target repository root, including when this test is frozen outside it.
// This exercises the real CLI parser and dispatch wiring, not the real controller.
// Every non-builtin import is an explicit fixture; no Docker, broker or model runs.
const cliSource = path.resolve(process.cwd(), 'maintenance/run.mjs');
const imports = {
  'store.mjs': ['lockStore', 'readJournal', 'encode', 'durableWrite', 'putArtifact'],
  'controller.mjs': ['prepare', 'implement', 'verify', 'accept', 'retry', 'recover', 'restoreCandidate', 'loadTask', 'transition', 'recordTrial'],
  'reflection.mjs': ['reviewWindow', 'recordReview', 'lessonState'],
  'ledger.mjs': ['actionIntent', 'usageLedger'],
  'budget.mjs': ['budgetSnapshot', 'reconcileBudget'],
  'runner.mjs': ['enqueue', 'tick', 'pause', 'resume'],
};
const budget = {
  schema_version: 1, model: 'fixture-model', effort: 'medium', task_usd: 1, daily_usd: 2,
  max_requests: 3, context_window_tokens: 4096, max_output_tokens: 512,
  input_usd_per_million: 1, output_usd_per_million: 2,
  price_valid_until: '2099-01-01T00:00:00Z', price_source: 'https://example.invalid/ceiling',
};
const offline = { mode: 'offline', paid: false, unattended: false, argv: ['node', 'fixture-only.mjs'] };

async function runCli(flags, { driver, withBudget = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-maint-cli-'));
  try {
    const maintenance = path.join(root, 'maintenance'), library = path.join(maintenance, 'lib');
    const paths = { state: path.join(root, 'state'), budget: path.join(root, 'budget.json'), driver: path.join(root, 'driver.json') };
    const receipts = path.join(root, 'dispatch.jsonl');
    await fs.mkdir(library, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
    const original = await fs.readFile(cliSource);
    const fixtureCli = path.join(maintenance, 'run.mjs');
    await fs.writeFile(fixtureCli, original, { flag: 'wx' });
    assert.deepEqual(await fs.readFile(fixtureCli), original, 'CLI source must be copied without rewriting its logic');
    const dependencies = [...original.toString('utf8').matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
    assert.deepEqual(dependencies.filter(specifier => !specifier.startsWith('node:')).sort(),
      Object.keys(imports).map(name => './lib/' + name).sort(), 'new CLI dependencies require explicit fixture review');
    const extra = [...new Set(Object.values(imports).flat())].filter(name => !['lockStore', 'implement', 'encode'].includes(name));
    await fs.writeFile(path.join(library, 'fixture.mjs'), `
import { appendFileSync } from 'node:fs';
const record = (type, data = {}) => appendFileSync(process.env.QI_CLI_FIXTURE_RECEIPTS, JSON.stringify({ type, ...data }) + '\\n');
export const encode = JSON.stringify;
export async function lockStore(root) {
  record('lock', { root });
  return { async close() { record('close'); } };
}
export async function implement({ root, id, driver, budget }) {
  const dispatch = { root, id, driver, budget };
  record('implement', dispatch);
  return { status: 'fixture-dispatched', ...dispatch };
}
${extra.map(name => `export function ${name}() { record('unexpected', { name: '${name}' }); throw new Error('Unexpected fixture import: ${name}'); }`).join('\n')}
`, { flag: 'wx' });
    for (const [name, names] of Object.entries(imports)) {
      await fs.writeFile(path.join(library, name), `export { ${names.join(', ')} } from './fixture.mjs';\n`, { flag: 'wx' });
    }
    if (withBudget) await fs.writeFile(paths.budget, JSON.stringify(budget), { flag: 'wx' });
    if (driver !== undefined) await fs.writeFile(paths.driver, JSON.stringify(driver), { flag: 'wx' });
    const result = await new Promise(resolve => {
      execFile(process.execPath, [fixtureCli, 'run', '--state', paths.state, '--id', 'fixture-cli-task', ...flags(paths)], {
        cwd: root, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
        env: { PATH: path.dirname(process.execPath) + path.delimiter + '/usr/bin:/bin', HOME: root, TMPDIR: root,
          LANG: 'C', QI_CLI_FIXTURE_RECEIPTS: receipts },
      }, (error, stdout, stderr) => resolve({ exitCode: error?.code ?? 0, signal: error?.signal ?? null,
        killed: error?.killed ?? false, stdout, stderr }));
    });
    assert.equal(result.killed, false, 'CLI fixture must finish within its original timeout');
    assert.equal(result.signal, null, 'CLI fixture must exit normally');
    assert.equal(typeof result.exitCode, 'number', 'a spawn error is not a valid CLI rejection');
    const events = (await fs.readFile(receipts, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    })).split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(events.filter(event => event.type === 'unexpected'), [], 'only the intended dispatch path may run');
    assert.equal(events.filter(event => event.type === 'lock').length, 1);
    assert.equal(events.filter(event => event.type === 'close').length, 1, 'both success and rejection close their owned lock');
    return { ...result, events, paths, dispatches: events.filter(event => event.type === 'implement') };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function rejected(result, reason) {
  assert.equal(result.exitCode, 1, result.stdout + result.stderr);
  assert.equal(result.dispatches.length, 0, 'rejected CLI arguments must never reach implement');
  assert.equal(result.stdout.trim(), '');
  assert.match(JSON.parse(result.stderr.trim()).reason, reason);
}

test('both paid CLI aliases require an explicit budget before dispatch', async t => {
  for (const alias of ['--supervised-live', '--budgeted-live']) {
    await t.test(alias, async () => rejected(await runCli(() => [alias]), /Paid execution requires --budget and the host broker/));
  }
});

test('supervised and budgeted CLI aliases dispatch the same exact brokered driver and budget', async t => {
  for (const alias of ['--supervised-live', '--budgeted-live']) {
    await t.test(alias, async () => {
      const result = await runCli(paths => [alias, '--budget', paths.budget], { withBudget: true });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.dispatches.length, 1);
      const expected = { root: result.paths.state, id: 'fixture-cli-task',
        driver: { mode: 'qi-budgeted', paid: true, unattended: false }, budget };
      const { type, ...actual } = result.dispatches[0];
      assert.equal(type, 'implement');
      assert.deepEqual(actual, expected);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { status: 'fixture-dispatched', ...expected });
    });
  }
});

test('conflicting CLI driver selectors are rejected without dispatch', async t => {
  await t.test('both paid aliases', async () => rejected(
    await runCli(paths => ['--supervised-live', '--budgeted-live', '--budget', paths.budget], { withBudget: true }),
    /Choose one offline, supervised or budgeted driver/));
  for (const alias of ['--supervised-live', '--budgeted-live']) {
    await t.test(alias + ' with a driver file', async () => rejected(
      await runCli(paths => [alias, '--driver', paths.driver, '--budget', paths.budget], { driver: offline, withBudget: true }),
      /Choose one offline, supervised or budgeted driver/));
  }
});

test('offline CLI drivers keep their arguments and driver files cannot select a paid mode', async t => {
  await t.test('offline', async () => {
    const result = await runCli(paths => ['--driver', paths.driver], { driver: offline });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.dispatches.length, 1);
    const { type, ...actual } = result.dispatches[0];
    assert.equal(type, 'implement');
    assert.deepEqual(actual, { root: result.paths.state, id: 'fixture-cli-task', driver: offline });
    assert.equal(Object.hasOwn(actual, 'budget'), false);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { status: 'fixture-dispatched', ...actual });
  });
  for (const mode of ['qi-supervised', 'qi-budgeted']) {
    await t.test(mode, async () => rejected(
      await runCli(paths => ['--driver', paths.driver, '--budget', paths.budget], {
        driver: { mode, paid: true, unattended: false }, withBudget: true,
      }), /Paid admission requires --budgeted-live or --supervised-live with --budget/));
  }
});
