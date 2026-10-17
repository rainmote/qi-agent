#!/usr/bin/env node
// Deterministic local timer, no LLM bootstrap. Starting this program is explicit;
// checked-in runner.example.json remains disabled.
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pause } from './lib/runner.mjs';
const { values: args } = parseArgs({ options: { state: { type: 'string' }, config: { type: 'string' } } });
if (!path.isAbsolute(args.state ?? '') || !path.isAbsolute(args.config ?? '')) throw new Error('--state and --config must be absolute paths');
let stopping = false, child, wake, lastError = null;
async function stop() {
  if (stopping) return;
  stopping = true;
  await pause(args.state, 'service-stopped');
  wake?.();
  const running = child;
  if (running) { const timer = setTimeout(() => running.kill('SIGTERM'), 20_000); timer.unref(); running.once('close', () => clearTimeout(timer)); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop().catch((e) => { console.error(e.message); child?.kill('SIGTERM'); }); });
while (!stopping) {
  await new Promise((resolve) => {
    child = spawn(process.execPath, [fileURLToPath(new URL('run.mjs', import.meta.url)), 'tick', '--state', args.state, '--config', args.config],
      { stdio: ['ignore', 'inherit', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => { if (error.length < 8192) error += chunk.toString().slice(0, 8192 - error.length); });
    child.on('error', (e) => { error = e.message; });
    child.once('close', () => { if (error && error !== lastError) console.error(error.trim()); lastError = error || null; child = null; resolve(); });
  });
  if (!stopping) await new Promise((resolve) => { const timer = setTimeout(resolve, 30_000); wake = () => { clearTimeout(timer); resolve(); }; });
}
