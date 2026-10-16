#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockStore, encode } from './lib/store.mjs';
import { defaults, codexArgs, checkCodex, codexLoop } from './lib/codex.mjs';
import { loadTask } from './lib/controller.mjs';
import { git } from './lib/execution.mjs';
import { reviewCandidate } from './lib/codex-review.mjs';

const usage = `Supervised Codex development loop (default: gpt-6.1-sol / xhigh)
  node maintenance/codex.mjs doctor
  node maintenance/codex.mjs plan --state ABS --id ID
  node maintenance/codex.mjs run --state ABS --id ID --codex ABS_EXECUTABLE [--review]
Prepare a task with maintenance/run.mjs first. plan does not start Codex.
run uses the existing ChatGPT CLI login; it stops at a verified candidate for human review.
`;
let lock;
try {
  const { values: args, positionals: [command] } = parseArgs({ options: {
    state: { type: 'string' }, id: { type: 'string' }, codex: { type: 'string', default: 'codex' }, review: { type: 'boolean', default: false }, help: { type: 'boolean' },
  }, allowPositionals: true });
  if (!command || args.help) console.log(usage);
  else if (command === 'doctor') console.log(encode({ ...await checkCodex(args.codex), defaults }));
  else {
    if (!['plan', 'run'].includes(command) || !path.isAbsolute(args.state ?? '')) throw new Error(usage);
    if (command === 'plan') {
      const { state, task } = await loadTask(args.state, args.id);
      console.log(encode({ task_id: task.task_id, goal: task.goal, status: state.status, defaults,
        workspace: state.workspace, argv: codexArgs(state.workspace), live_model_call: false }));
    } else {
      lock = await lockStore(args.state);
      const { state } = await loadTask(args.state, args.id);
      const controller = fileURLToPath(new URL('..', import.meta.url));
      if (git(controller, 'rev-parse', 'HEAD') !== state.controller_sha || git(controller, 'status', '--porcelain', '--untracked-files=all')) {
        throw new Error('Run from the clean controller commit frozen by prepare');
      }
      if (args.review && !path.isAbsolute(args.codex)) throw new Error('Independent review requires an explicit pinned executable path');
      const result = await codexLoop({ root: args.state, id: args.id, lock, command: args.codex,
        ...(args.review ? { reviewCandidate } : {}) });
      console.log(encode(result));
      if (result.status !== 'review_ready') process.exitCode = 1;
    }
  }
} catch (error) { console.error(encode({ status: 'UNKNOWN', reason: error.message })); process.exitCode = 1; }
finally { if (lock) await lock.close(); }
