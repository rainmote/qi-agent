import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const safe = value => typeof value === 'string' && !isAbsolute(value) && !/[\\\0\r\n]/.test(value)
  && value.split('/').every(part => part && !['.', '..', '.git'].includes(part));
const gitEnvironment = { PATH: '/usr/bin:/bin', HOME: homedir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' };
export async function verificationGit(root, args) {
  return (await exec('/usr/bin/git', ['-c', 'core.fsmonitor=false', '--literal-pathspecs', ...args],
    { cwd: root, env: gitEnvironment, timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })).stdout;
}

export function verificationKey(workspacePath, turnId) {
  if (typeof turnId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(turnId)) throw new Error('Invalid verification turn identity');
  return hash(JSON.stringify([workspacePath, turnId]));
}

/** All tracked and nonignored files, including hidden files and binary files; no source is executed. */
export async function workspaceManifest(root, objectFormat) {
  if (objectFormat && !["sha1", "sha256"].includes(objectFormat)) throw new Error("Unknown Git object format");
  if (!isAbsolute(root) || await realpath(root) !== root || (await lstat(root)).isSymbolicLink()) throw new Error('Workspace root changed');
  const paths = [...new Set((await verificationGit(root, ['ls-files', '-co', '--exclude-standard', '-z'])).split('\0').filter(Boolean))].sort();
  if (!paths.length || paths.length > 4096) throw new Error('Incomplete source file set');
  const files = []; let bytes = 0;
  for (const file of paths) {
    if (!safe(file)) throw new Error('Unsafe source file');
    let cursor = root;
    for (const part of file.split('/')) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Source symlinks cannot be verified');
    }
    const handle = await open(cursor, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > 4n * 1024n * 1024n) throw new Error('Incomplete source file');
      bytes += Number(before.size); if (bytes > 64 * 1024 * 1024) throw new Error('Source exceeds verification limit');
      const buffer = Buffer.alloc(Number(before.size) + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat({ bigint: true }), pathInfo = await lstat(cursor, { bigint: true });
      for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs']) {
        if (before[key] !== after[key] || before[key] !== pathInfo[key]) throw new Error('Source changed while reading');
      }
      if (bytesRead !== Number(before.size)) throw new Error('Source changed while reading');
      const data = buffer.subarray(0, bytesRead);
      files.push({ file, mode: before.mode & 0o111n ? '100755' : '100644', sha256: hash(data),
        ...(objectFormat ? { object: createHash(objectFormat).update(`blob ${data.length}\0`).update(data).digest('hex') } : {}) });
    } finally { await handle.close(); }
  }
  return files;
}

export function validateReceiptBindings(receipt, controllerSha) {
  const bindings = receipt?.bindings;
  if (receipt?.schema_version !== 1 || receipt.status !== 'PASS' || !sha(receipt.candidate_sha)
      || !Number.isFinite(Date.parse(receipt.created_at)) || !sha(controllerSha)
      || bindings?.controller_sha !== controllerSha
      || !['contract_sha256','material_sha256','profile_sha256','verifier_sha256'].every(key => sha256(bindings[key]))
      || !/^(?:[\w./:-]+@)?sha256:[a-f0-9]{64}$/.test(bindings?.image ?? '')) throw new Error('Unconfirmed verifier bindings');
  const ids = receipt.required_checks, checks = receipt.checks;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
      || !Array.isArray(checks) || checks.length !== ids.length
      || ids.some(id => checks.filter(check => check?.id === id && check.status === 'PASS').length !== 1)) throw new Error('Required checks are incomplete');
  if (!Array.isArray(receipt.source_files) || !receipt.source_files.length || receipt.source_files.length > 4096
      || receipt.source_files.some(file => !safe(file.file) || !sha256(file.sha256) || !['100644','100755'].includes(file.mode))) throw new Error('Incomplete source fingerprint');
}

export async function readWorkspaceVerification(config, workspacePath, changes) {
  if (!config) return { status: 'NOT_RUN', reason: 'not-configured' };
  let receiptFound = false;
  try {
    const directory = resolve(config.directory);
    if (directory === workspacePath || directory.startsWith(workspacePath + sep) || workspacePath.startsWith(directory + sep)) throw new Error('Receipt store overlaps the candidate');
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || await realpath(directory) !== directory) throw new Error('Receipt store is not private');
    const file = join(directory, verificationKey(workspacePath, changes.turnId) + '.json');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    receiptFound = true;
    let receipt;
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > 2n * 1024n * 1024n || (before.mode & 0o077n) !== 0n) throw new Error('Invalid private receipt');
      const buffer = Buffer.alloc(Number(before.size) + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat({ bigint: true }), pathInfo = await lstat(file, { bigint: true });
      for (const key of ['dev','ino','size','mtimeNs','ctimeNs']) if (before[key] !== after[key] || before[key] !== pathInfo[key]) throw new Error('Receipt changed while reading');
      if (bytesRead !== Number(before.size)) throw new Error('Receipt changed while reading');
      receipt = JSON.parse(buffer.subarray(0, bytesRead).toString());
    } finally { await handle.close(); }
    validateReceiptBindings(receipt, config.controllerSha);
    if (receipt.workspace_path !== workspacePath || receipt.turn_id !== changes.turnId || changes.partial) throw new Error('Receipt belongs to a different or partial snapshot');
    const source = await workspaceManifest(workspacePath);
    if (JSON.stringify(source) !== JSON.stringify(receipt.source_files)) throw new Error('Source fingerprint changed');
    const byFile = new Map(source.map(file => [file.file, file]));
    for (const file of changes.files) {
      if (file.status === 'deleted' ? byFile.has(file.path) : byFile.get(file.path)?.sha256 !== hash(file.after)) throw new Error('Turn snapshot does not match the verified source');
    }
    // Catch writes during the complete scan, including file-set and executable-mode changes.
    if (JSON.stringify(await workspaceManifest(workspacePath)) !== JSON.stringify(source)) throw new Error('Source changed during reconciliation');
    return { status: 'PASS', candidateSha: receipt.candidate_sha, checkedAt: receipt.created_at,
      checks: receipt.checks.map(check => ({ id: check.id, status: check.status })) };
  } catch (error) {
    return !receiptFound && error.code === 'ENOENT' ? { status: 'NOT_RUN', reason: 'receipt-missing' }
      : { status: 'UNKNOWN', reason: 'receipt-or-source-mismatch' };
  }
}
