import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { runProcess } from '../../evals/lib/core.mjs';

export function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trimEnd();
}

export function relative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || /[\\\0\r\n]/.test(value) ||
      value.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')) throw new Error('Unsafe relative path');
  return value;
}

export async function regularFile(root, file) {
  relative(file);
  let current = root;
  for (const part of file.split('/')) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symlink deliverables are forbidden');
  }
  if (!(await fs.stat(current)).isFile()) throw new Error('Deliverable must be a regular file');
  if ((await fs.stat(current)).size > 4 * 1024 * 1024) throw new Error('Deliverable exceeds 4 MiB');
  return current;
}

export async function snapshot(repo, sha, target) {
  await fs.mkdir(target, { recursive: true, mode: 0o755 });
  const archive = execFileSync('git', ['-C', repo, 'archive', '--format=tar', sha], { maxBuffer: 128 * 1024 * 1024 });
  // BSD tar can exit successfully at the end marker before consuming padded
  // stdin, which spawnSync reports as EPIPE. A private file has no pipe race.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-maint-snapshot-'));
  try {
    const file = path.join(temporary, 'source.tar');
    await fs.writeFile(file, archive, { mode: 0o600 });
    execFileSync('tar', ['-xf', file, '-C', target]);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export function changedFiles(workspace, base) {
  const tracked = git(workspace, 'diff', '--name-only', '--no-renames', '-z', base, '--').split('\0').filter(Boolean);
  const staged = git(workspace, 'diff', '--cached', '--name-only', '--no-renames', '-z', base, '--').split('\0').filter(Boolean);
  const untracked = git(workspace, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  return [...new Set([...tracked, ...staged, ...untracked])].sort();
}

export async function verifiedTree(repo, base, directory, manifest, root) {
  // A private index prevents staged-but-unverified bytes or Git filters from entering the commit.
  const index = path.join(root, 'candidate-index-' + randomUUID());
  const run = (...args) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: index }, maxBuffer: 32 * 1024 * 1024,
  }).trimEnd();
  try {
    run('read-tree', base);
    for (const entry of manifest) {
      const blob = run('hash-object', '-w', '--no-filters', '--', path.join(directory, entry.file));
      run('update-index', '--add', '--cacheinfo', entry.mode & 0o111 ? '100755' : '100644', blob, entry.file);
    }
    return run('write-tree');
  } finally { await fs.rm(index, { force: true }); await fs.rm(index + '.lock', { force: true }); }
}

export function immutableImage(image) {
  if (typeof image !== 'string' || !/^(?:[\w./:-]+@)?sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Container image must be pinned by digest or local image ID');
  return image;
}

export function resourceLimits(resources = {}) {
  const limits = { cpus: 2, memory_mb: 2048, work_mb: 1024, tmp_mb: 256, pids: 256, ...resources };
  for (const [key, max] of Object.entries({ cpus: 4, memory_mb: 6144, work_mb: 6144, tmp_mb: 1024, pids: 1024 })) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > max) throw new Error('Invalid container resource limit: ' + key);
  }
  if (Object.keys(limits).length !== 5) throw new Error('Unknown container resource limit');
  return limits;
}

function dockerArgs(argv, environment) {
  if (!environment) return argv;
  if (typeof environment.host !== 'string' || !environment.host || environment.host.length > 4096 || /[\0\r\n]/.test(environment.host) ||
      createHash('sha256').update(environment.host).digest('hex') !== environment.endpoint ||
      typeof environment.engine !== 'string' || !environment.engine) throw new Error('Invalid original engine binding');
  return ['--host', environment.host, ...argv];
}

async function assertEngine(environment, run, timeoutMs = 5000) {
  if (!environment) return;
  const result = await run('docker', dockerArgs(['info', '--format', '{{.ID}}'], environment), { timeoutMs, maxOutputBytes: 65536 });
  if (result.exit_code !== 0 || result.error || result.signal || result.timed_out || result.output_limited ||
      typeof result.stdout !== 'string' || result.stdout.trim() !== environment.engine) throw new Error('Original engine identity remains unresolved');
}

export async function cleanupContainer(name, owner, run = runProcess, environment) {
  if (!/^qi-maint-(?:check-)?[a-f0-9-]{36}$/.test(name ?? '') || !/^[a-f0-9-]{36}$/.test(owner ?? '')) throw new Error('Missing container ownership receipt');
  await assertEngine(environment, run);
  const inspected = await run('docker', dockerArgs(['inspect', '--type=container', name], environment), { timeoutMs: 10_000 });
  if (inspected.error || inspected.signal || inspected.timed_out || inspected.output_limited) throw new Error('Container inspection is uncertain');
  if (inspected.exit_code !== 0) {
    if (/No such (object|container)/i.test(inspected.stderr)) return { status: 'absent', container: name };
    throw new Error('Container inspection is uncertain');
  }
  const container = JSON.parse(inspected.stdout)[0];
  if (container.Config?.Labels?.['qi.maintenance.owner'] !== owner || !/^[a-f0-9]{64}$/.test(container.Id ?? '')) throw new Error('Container ownership mismatch');
  const removed = await run('docker', dockerArgs(['rm', '-f', container.Id], environment), { timeoutMs: 15_000 });
  if (removed.error || removed.signal || removed.timed_out || removed.output_limited ||
      (removed.exit_code !== 0 && !/No such container/i.test(removed.stderr))) throw new Error('Container cleanup is uncertain');
  return { status: 'removed', container: name, container_id: container.Id };
}

export async function containerCommand({ image, argv, workspace, readonly = true, mounts = [], timeoutMs = 30000, envNames = [], network = false,
  name = 'qi-maint-' + randomUUID(), owner = randomUUID(), resources, environment, shouldStop = async () => false }) {
  const deadline = Date.now() + timeoutMs;
  if (!Array.isArray(envNames) || envNames.length) throw new Error('Credential passthrough is forbidden; use the host broker');
  if (network !== false) throw new Error('Network access is forbidden in maintenance containers; use the host broker');
  immutableImage(image);
  const limits = resourceLimits(resources);
  if (!Array.isArray(argv) || !argv.length || argv.some((v) => typeof v !== 'string' || v.includes('\0'))) throw new Error('Expected a nonempty argv array');
  // No shell evaluation of argv. The fixed wrapper only creates an ephemeral build tree.
  const args = ['run', '--rm', '--name', name, '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--label', 'qi.maintenance.owner=' + owner,
    '--pids-limit=' + limits.pids, '--memory=' + limits.memory_mb + 'm', '--memory-swap=' + limits.memory_mb + 'm', '--cpus=' + limits.cpus,
    `--user=${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`, '--network', 'none',
    '--tmpfs', '/tmp:rw,exec,mode=1777,size=' + limits.tmp_mb + 'm', '--env', 'HOME=/tmp/qi-home', '--env', 'NO_COLOR=1'];
  if (readonly) args.push('--mount', `type=bind,src=${workspace},dst=/inputs,readonly`, '--tmpfs', '/work:rw,exec,mode=1777,size=' + limits.work_mb + 'm');
  else args.push('--mount', `type=bind,src=${workspace},dst=/work`);
  for (const { source, target, writable = false } of mounts) {
    if (!path.isAbsolute(source) || !/^\/(controller|profile|acceptance|gateway)(\/|$)/.test(target) || /[,\0\r\n]/.test(source + target) ||
        (writable && target !== '/gateway')) throw new Error('Invalid trusted mount');
    args.push('--mount', `type=bind,src=${source},dst=${target}${writable ? '' : ',readonly'}`);
  }
  if (!path.isAbsolute(workspace) || /[,\0\r\n]/.test(workspace)) throw new Error('Invalid workspace');
  args.push('--workdir', '/work', image, 'sh', '-c',
    readonly ? 'mkdir -p "$HOME" && cp -R /inputs/. /work/ && exec "$@"' : 'mkdir -p "$HOME" && exec "$@"', 'qi-maint-command', ...argv);
  let stopping = false, stopError, poll, pendingStop = Promise.resolve();
  try {
    poll = setInterval(() => {
      if (stopping) return;
      stopping = true;
      pendingStop = (async () => {
        try { if (await shouldStop()) await cleanupContainer(name, owner, runProcess, environment); }
        catch (error) { stopError = error; }
        finally { stopping = false; }
      })();
    }, 500);
    await assertEngine(environment, runProcess, Math.min(5000, Math.max(1, deadline - Date.now())));
    if (Date.now() >= deadline) throw new Error('Original execution deadline exhausted');
    return await runProcess('docker', dockerArgs(args, environment), { timeoutMs: deadline - Date.now(), maxOutputBytes: 10_000_000 });
  } finally {
    clearInterval(poll);
    await pendingStop;
    // Killing the Docker client does not guarantee that its container stopped.
    await cleanupContainer(name, owner, runProcess, environment);
    if (stopError) throw stopError;
  }
}
