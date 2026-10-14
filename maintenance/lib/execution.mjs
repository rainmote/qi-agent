import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
  execFileSync('tar', ['-xf', '-', '-C', target], { input: archive });
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

export async function containerCommand({ image, argv, workspace, readonly = true, mounts = [], timeoutMs, envNames = [], network = false, name = 'qi-maint-' + randomUUID() }) {
  immutableImage(image);
  if (!Array.isArray(argv) || !argv.length || argv.some((v) => typeof v !== 'string' || v.includes('\0'))) throw new Error('Expected a nonempty argv array');
  // No shell evaluation of argv. The fixed wrapper only creates an ephemeral build tree.
  const args = ['run', '--rm', '--name', name, '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=256', '--memory=2g', '--cpus=2', `--user=${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`, '--network', network ? 'bridge' : 'none',
    '--tmpfs', '/tmp:rw,exec,mode=1777,size=256m', '--env', 'HOME=/tmp/qi-home', '--env', 'NO_COLOR=1'];
  if (readonly) args.push('--mount', `type=bind,src=${workspace},dst=/inputs,readonly`, '--tmpfs', '/work:rw,exec,mode=1777,size=1g');
  else args.push('--mount', `type=bind,src=${workspace},dst=/work`);
  for (const { source, target } of mounts) {
    if (!path.isAbsolute(source) || !/^\/(controller|profile|acceptance)(\/|$)/.test(target) || /[,\0\r\n]/.test(source + target)) throw new Error('Invalid trusted mount');
    args.push('--mount', `type=bind,src=${source},dst=${target},readonly`);
  }
  for (const key of envNames) {
    if (key !== 'OPENAI_API_KEY') throw new Error('Only the explicit maintenance provider credential is allowed');
    if (!process.env[key]) throw new Error('Missing provider credential: ' + key);
    args.push('--env', key);
  }
  if (!path.isAbsolute(workspace) || /[,\0\r\n]/.test(workspace)) throw new Error('Invalid workspace');
  args.push('--workdir', '/work', image, 'sh', '-c',
    readonly ? 'mkdir -p "$HOME" && cp -R /inputs/. /work/ && exec "$@"' : 'mkdir -p "$HOME" && exec "$@"', 'qi-maint-command', ...argv);
  try {
    return await runProcess('docker', args, { timeoutMs, maxOutputBytes: 10_000_000 });
  } finally {
    // Killing the Docker client does not guarantee that its container stopped.
    const cleanup = await runProcess('docker', ['rm', '-f', name], { timeoutMs: 15_000 });
    if (cleanup.exit_code !== 0 && !/No such container/i.test(cleanup.stderr)) throw new Error('Container cleanup is uncertain: ' + name);
  }
}
