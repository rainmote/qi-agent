#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockStore, readJournal, encode, durableWrite, putArtifact } from './lib/store.mjs';
import { prepare, implement, verify, accept, retry, recover, restoreCandidate, loadTask, transition } from './lib/controller.mjs';
import { reviewWindow, recordReview, lessonState } from './lib/reflection.mjs';
import { actionIntent, usageLedger } from './lib/ledger.mjs';

const controller = fileURLToPath(new URL('..', import.meta.url));
const readJSON = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const definitions = Object.fromEntries(['state', 'repo', 'task', 'id', 'driver', 'review', 'revision', 'start', 'end', 'limit', 'output', 'window', 'incident', 'action', 'result', 'evidence'].map((key) => [key, { type: 'string' }]));
definitions['supervised-live'] = { type: 'boolean', default: false };
definitions.help = { type: 'boolean' };
const usage = `qi maintenance (controller checkout must be clean for prepare)
  prepare --state ABS --repo ABS --task contract.json
  run --state ABS --id ID --driver offline-driver.json
  run --state ABS --id ID --supervised-live
  verify|status|cancel|restore --state ABS --id ID
  retry --state ABS --id ID --revision N
  accept --state ABS --id ID --revision N --review human-review.json
  recover --state ABS
  review-window --state ABS --repo ABS --start SHA --end SHA --output window.json
  review-record --state ABS --repo ABS --window window.json --review report.json
  lesson --state ABS --incident incident.json
  action-intent --state ABS --action ID --evidence description.json
  action-result --state ABS --action ID --result confirmed|not-applied --evidence proof.json
No command pushes, merges, publishes, or creates schedules. No network in offline task containers.
`;

let lock;
try {
  const { values: args, positionals: [command] } = parseArgs({ options: definitions, allowPositionals: true });
  if (args.help || !command) { console.log(usage); }
  else {
    if (!args.state || !path.isAbsolute(args.state)) throw new Error('--state must be an absolute directory outside repositories');
    const root = args.state;
    lock = await lockStore(root, { recover: command === 'recover' });
    let result;
    const common = { root, lock, id: args.id };
    switch (command) {
      case 'prepare': result = await prepare({ ...common, repo: args.repo, controller, task: await readJSON(args.task),
        policy: await readJSON(path.join(controller, 'maintenance/policy.json')) }); break;
      case 'run': {
        if (!!args.driver === !!args['supervised-live']) throw new Error('Choose an offline driver or --supervised-live');
        const driver = args['supervised-live'] ? { mode: 'qi-supervised', paid: true, unattended: false } : await readJSON(args.driver);
        if (args.driver && driver.mode !== 'offline') throw new Error('Paid admission requires the explicit --supervised-live flag');
        result = await implement({ ...common, driver }); break;
      }
      case 'verify': result = await verify(common); break;
      case 'retry': result = await retry({ ...common, expectedRevision: Number(args.revision) }); break;
      case 'accept': result = await accept({ ...common, expectedRevision: Number(args.revision), review: await readJSON(args.review) }); break;
      case 'cancel': {
        const { state } = await loadTask(root, args.id);
        result = await transition(root, lock, args.id, state.revision, 'cancelled', { reason: 'operator-cancelled' }); break;
      }
      case 'status': {
        const { state, events } = await loadTask(root, args.id);
        result = { ...state, usage: usageLedger(events.filter((e) => e.type === 'usage/request' && e.data.task_id === args.id).map((e) => e.data)) }; break;
      }
      case 'recover': result = await recover(common); break;
      case 'restore': result = await restoreCandidate(common); break;
      case 'review-window': result = await reviewWindow({ root, repo: args.repo, start: args.start, end: args.end, limit: Number(args.limit ?? 50) }); break;
      case 'review-record': result = await recordReview({ root, lock, repo: args.repo, window: await readJSON(args.window), report: await readJSON(args.review) }); break;
      case 'lesson': {
        const incident = await readJSON(args.incident);
        const events = await readJournal(root);
        const incidents = events.filter((e) => e.type === 'lesson/incident').map((e) => e.data);
        result = lessonState([...incidents, incident], incident.pattern_key);
        if (!incidents.some((item) => item.pattern_key === incident.pattern_key && item.incident_id === incident.incident_id)) await lock.append('lesson/incident', incident);
        break;
      }
      case 'action-intent': {
        if (!args.action) throw new Error('Stable --action identity required');
        result = actionIntent(await readJournal(root), args.action, await readJSON(args.evidence));
        if (result.allowed) await lock.append('action/intent', { action_id: args.action, payload: result.payload });
        break;
      }
      case 'action-result': {
        if (!['confirmed', 'not-applied'].includes(args.result)) throw new Error('Reconcile a known effect before recording its result');
        const current = actionIntent(await readJournal(root), args.action, null);
        if (current.status !== 'uncertain') throw new Error('No unresolved intent with that identity');
        const evidence = await putArtifact(root, encode(await readJSON(args.evidence)));
        result = { action_id: args.action, result: args.result, evidence };
        await lock.append('action/result', result); break;
      }
      default: throw new Error(usage);
    }
    if (args.output) await durableWrite(path.resolve(args.output), encode(result));
    if (!result?.quiet) console.log(encode(result));
    if (['failed', 'blocked', 'uncertain'].includes(result?.status)) process.exitCode = 1;
  }
} catch (error) { console.error(encode({ status: 'UNKNOWN', reason: error.message })); process.exitCode = 1; }
finally { if (lock) await lock.close(); }
