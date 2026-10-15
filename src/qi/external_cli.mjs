// Opt-in JSONL process contract. This module never selects a real model CLI.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const statuses = new Set(['completed', 'failed', 'cancelled', 'uncertain']);
const bounded = (value, fallback, max) => {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error('Invalid CLI limit');
  return value;
};

export async function startExternalRun(options, request = {}) {
  const { command, workspaceRoot } = options;
  if (!Array.isArray(command) || !path.isAbsolute(command[0] ?? '') ||
      command.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('CLI command requires an absolute executable and argv');
  if (process.platform === 'win32') throw new Error('External CLI process groups require POSIX');
  const timeoutMs = bounded(options.timeoutMs, 30000, 300000);
  const maxOutputBytes = bounded(options.maxOutputBytes, 262144, 1048576);
  const stderrBytes = bounded(options.stderrBytes, 4096, 65536);
  const root = await realpath(workspaceRoot);
  if (!(await stat(root)).isDirectory()) throw new Error('CLI workspace root must be a directory');
  const directory = await mkdtemp(path.join(root, 'external-'));
  const cwd = path.join(directory, 'work'), home = path.join(directory, 'home');
  await mkdir(cwd, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  const child = spawn(command[0], command.slice(1), {
    cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    // No ambient credentials, startup files, user HOME or provider variables.
    env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home }
  });
  const started = performance.now();
  let stderr = Buffer.alloc(0), pending = '', total = 0, terminal, forced, closed = false;
  let exitCode, launchError, cleanupTimer;
  const signalGroup = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const terminate = (status, reason) => {
    if (closed || forced) return false;
    forced = { status, reason }; // Wins over every later JSONL terminal.
    signalGroup('SIGTERM');
    cleanupTimer = setTimeout(() => signalGroup('SIGKILL'), 200);
    return true;
  };
  const parseLine = line => {
    if (!line.trim() || forced) return;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSONL object');
      if (value.type === 'progress') return;
      if (value.type !== 'result' || terminal || !statuses.has(value.status) || typeof value.output !== 'string') throw new Error('Invalid or duplicate CLI terminal');
      terminal = value;
    } catch { terminate('failed', 'invalid-jsonl'); }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', text => {
    total += Buffer.byteLength(text);
    if (total > maxOutputBytes) { terminate('failed', 'output-limit'); return; }
    pending += text;
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index); pending = pending.slice(index + 1); parseLine(line);
    }
  });
  child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]).subarray(-stderrBytes); });
  child.stdin.on('error', () => {}); // Early stdin closure is reconciled by exit and JSONL.
  const deadline = setTimeout(() => terminate('uncertain', 'timeout'), timeoutMs);
  const result = new Promise(resolve => {
    child.on('error', error => { launchError = error.code ?? 'launch-error'; });
    child.on('exit', code => { exitCode = code; });
    child.on('close', () => {
      if (pending) parseLine(pending);
      closed = true; clearTimeout(deadline); clearTimeout(cleanupTimer);
      signalGroup('SIGKILL'); // Includes grandchildren whose parent already exited.
      const value = forced ?? (launchError ? { status: 'failed', reason: 'launch-error' } :
        exitCode !== 0 ? { status: 'failed', reason: 'process-exit' } :
        terminal ?? { status: 'uncertain', reason: 'missing-terminal' });
      const usage = {};
      for (const key of ['input_tokens', 'output_tokens']) {
        const number = terminal?.usage?.[key];
        if (Number.isSafeInteger(number) && number >= 0) usage[key] = number;
      }
      resolve({ status: value.status, reason: value.reason ?? value.status,
        output: forced ? '' : terminal?.output ?? '', verification: 'not-run',
        accounting_complete: false, total_cost_usd: null, usage,
        exit_code: exitCode ?? null, launch_error: launchError ?? null,
        stderr_tail: stderr.toString('utf8'), stdout_bytes: total,
        elapsed_ms: Math.round(performance.now() - started), cwd, home });
    });
  });
  child.stdin.end(JSON.stringify({ type: 'start', prompt: request.prompt ?? '', run_id: request.run_id ?? null }) + '\n');
  return { result, pid: child.pid, cwd, home,
    interrupt: () => terminate('cancelled', 'cancelled'), stop: () => terminate('cancelled', 'stopped') };
}

async function bridge() {
  let handle;
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const message = JSON.parse(line);
    if (message.type === 'start' && !handle) {
      handle = await startExternalRun(message.options, message.request);
      handle.result.then(value => { process.stdout.write(JSON.stringify(value) + '\n'); lines.close(); process.stdin.destroy(); });
    } else if (message.type === 'interrupt') handle?.interrupt();
    else if (message.type === 'stop') handle?.stop();
  }
  if (handle) { handle.stop(); await handle.result; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bridge().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
