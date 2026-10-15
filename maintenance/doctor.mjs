#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { git, immutableImage } from './lib/execution.mjs';
import { validateBudget, budgetSnapshot } from './lib/budget.mjs';
import { providerConfig, providerCredential } from './lib/provider.mjs';
import { readJournal, encode } from './lib/store.mjs';
import { scheduleSlot } from './lib/runner.mjs';
import { runProcess } from '../evals/lib/core.mjs';

const { values: args } = parseArgs({ options: Object.fromEntries(['state', 'image', 'budget', 'config'].map((key) => [key, { type: 'string' }])) });
const controller = fileURLToPath(new URL('..', import.meta.url));
const checks = [];
async function check(name, fn) {
  try { checks.push({ name, status: 'PASS', detail: await fn() }); }
  catch (error) { checks.push({ name, status: 'BLOCKED', reason: error.message }); }
}
await check('controller', () => { if (git(controller, 'status', '--porcelain')) throw new Error('Controller must be committed and clean'); return git(controller, 'rev-parse', 'HEAD'); });
await check('budget', async () => { validateBudget(JSON.parse(await fs.readFile(args.budget, 'utf8'))); return 'Reviewed model, price ceiling and limits configured'; });
await check('credential', async () => {
  const budget = JSON.parse(await fs.readFile(args.budget, 'utf8'));
  providerCredential(budget);
  return providerConfig(budget).credentialEnv + ' present (value not printed)';
});
await check('image', async () => {
  immutableImage(args.image);
  const result = await runProcess('docker', ['image', 'inspect', '--format', '{{.Id}} {{.Os}}/{{.Architecture}}', args.image], { timeoutMs: 10_000 });
  if (result.exit_code !== 0) throw new Error('Pinned toolchain image is unavailable');
  return result.stdout.trim();
});
await check('schedule', async () => { const config = JSON.parse(await fs.readFile(args.config, 'utf8')); scheduleSlot(config.schedule);
  return { enabled: config.enabled === true, controller_sha: config.controller_sha, trial_ids: config.trial_ids ?? [] }; });
await check('state', async () => { const events = await readJournal(args.state); const budget = budgetSnapshot(events, '');
  if (budget.uncertain.length) throw new Error('Unknown provider effects require reconciliation');
  return { approved_tasks: events.filter((e) => e.type === 'queue/enqueued').length, budget }; });
console.log(encode({ status: checks.every((c) => c.status === 'PASS') ? 'CONFIGURED' : 'BLOCKED', checks,
  note: 'Readiness inspection only. tick independently checks task authorization, stale materials, exact live trial evidence and the schedule; doctor never enables anything.' }));
if (checks.some((c) => c.status !== 'PASS')) process.exitCode = 1;
