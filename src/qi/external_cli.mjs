// Opt-in JSONL process contract. This module never selects a real model CLI.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CODEX_PROTOCOL, CODEX_VERSION, codexDecoder } from './external_cli_codex.mjs';
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
  const protocol = options.protocol ?? 'generic-jsonl-v1';
  if (!['generic-jsonl-v1', CODEX_PROTOCOL].includes(protocol)) throw new Error('Unsupported CLI protocol');
  const codex = protocol === CODEX_PROTOCOL ? codexDecoder() : null;
  if (codex) {
    if (command.length !== 1 || options.cliVersion !== CODEX_VERSION ||
        !/^[a-f0-9]{64}$/u.test(options.cliSha256 ?? '') ||
        typeof (request.prompt ?? '') !== 'string' ||
        typeof options.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(options.model)) {
      throw new Error('Codex protocol requires pinned version, executable digest and explicit model');
    }
    const actual = createHash('sha256').update(await readFile(command[0])).digest('hex');
    if (actual !== options.cliSha256) throw new Error('Codex executable digest mismatch');
  }
  const root = await realpath(workspaceRoot);
  if (!(await stat(root)).isDirectory()) throw new Error('CLI workspace root must be a directory');
  const directory = await mkdtemp(path.join(root, 'external-'));
  const cwd = path.join(directory, 'work'), home = path.join(directory, 'home');
  await mkdir(cwd, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  const argv = codex ? ['--ask-for-approval', 'never', 'exec', '--json', '--ephemeral',
    '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check',
    '--model', options.model, '-'] : command.slice(1);
  const child = spawn(command[0], argv, {
    cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    // No ambient credentials, startup files, user HOME or provider variables.
    env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, ...(codex ? { CODEX_HOME: home } : {}) }
  });
  const started = performance.now();
  let stderr = Buffer.alloc(0), pending = '', total = 0, terminal, forced, closed = false;
  let exitCode, launchError, cleanupTimer, settlementTimer, deadline, resolveResult, settled = false;
  const cleanupErrors = [];
  const result = new Promise(resolve => { resolveResult = resolve; });
  const signalGroup = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) {
      if (error.code !== 'ESRCH') cleanupErrors.push({ signal, code: error.code ?? 'signal-error' });
    }
  };
  const terminate = (status, reason) => {
    if (closed || forced || settled) return false;
    forced = { status, reason }; // Wins over every later JSONL terminal.
    signalGroup('SIGTERM');
    cleanupTimer = setTimeout(() => {
      signalGroup('SIGKILL');
      // A denied signal must not leave result pending forever. Retain the PID
      // and uncertainty for reconciliation; this does not certify cleanup.
      settlementTimer = setTimeout(() => settle(), 200);
    }, 200);
    return true;
  };
  const parseLine = line => {
    if (!line.trim() || forced) return;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSONL object');
      if (codex) { terminal = codex.accept(value); return; }
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
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline); clearTimeout(cleanupTimer); clearTimeout(settlementTimer);
    const cleanupUncertain = cleanupErrors.length > 0 || !closed;
    const value = cleanupUncertain
      ? { status: 'uncertain', reason: forced?.reason === 'timeout' ? 'timeout' : 'cleanup-failed' }
      : forced ?? (launchError ? { status: 'failed', reason: 'launch-error' } :
      exitCode !== 0 ? (codex && terminal?.status === 'failed' ? terminal : { status: 'failed', reason: 'process-exit' }) :
      terminal ?? { status: 'uncertain', reason: 'missing-terminal' });
    const usage = {};
    for (const key of codex ? ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens'] : ['input_tokens', 'output_tokens']) {
      const number = terminal?.usage?.[key];
      if (Number.isSafeInteger(number) && number >= 0) usage[key] = number;
    }
    resolveResult({ status: value.status, reason: value.reason ?? value.status,
      ...(value.detail ? { detail: value.detail } : {}),
      output: forced || cleanupUncertain ? '' : terminal?.output ?? '', verification: 'not-run',
      accounting_complete: false, total_cost_usd: null, usage,
      exit_code: exitCode ?? null, launch_error: launchError ?? null,
      stderr_tail: stderr.toString('utf8'), stdout_bytes: total,
      cleanup: { status: cleanupUncertain ? 'uncertain' : 'signalled', pid: child.pid ?? null,
        process_closed: closed, errors: cleanupErrors.map(error => ({ ...error })),
        requested_outcome: forced ?? null },
      ...(codex ? { ...codex.metadata(), cli_sha256: options.cliSha256,
        cli_version_scope: 'host-declared-version-and-pinned-executable' } : {}),
      elapsed_ms: Math.round(performance.now() - started), cwd, home });
    if (!closed) {
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.unref?.();
    }
  };
  deadline = setTimeout(() => terminate('uncertain', 'timeout'), timeoutMs);
  child.on('error', error => { launchError = error.code ?? 'launch-error'; });
  child.on('exit', code => { exitCode = code; });
  child.on('close', () => {
    if (settled) return;
    if (pending) parseLine(pending);
    if (codex && !forced) terminal = codex.finish();
    closed = true;
    signalGroup('SIGKILL'); // Includes grandchildren whose parent already exited.
    settle();
  });
  child.stdin.end(codex ? request.prompt ?? '' :
    JSON.stringify({ type: 'start', prompt: request.prompt ?? '', run_id: request.run_id ?? null }) + '\n');
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
