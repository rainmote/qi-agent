import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const encode = (value) => JSON.stringify(value, null, 2) + '\n';
export const identifier = (value) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value ?? '')) throw new Error('Invalid task/run identity');
  return value;
};

export async function durableWrite(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function readJournal(root) {
  let raw;
  try { raw = await fs.readFile(path.join(root, 'events.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (raw && !raw.endsWith('\n')) throw new Error('Incomplete journal tail; reconcile before continuing');
  const events = [];
  let previous = null;
  for (const line of raw.split('\n').slice(0, -1)) {
    const { hash, ...event } = JSON.parse(line);
    if (event.seq !== events.length + 1 || event.previous !== previous || hash !== digest(JSON.stringify(event))) {
      throw new Error('Journal hash/sequence mismatch');
    }
    events.push({ ...event, hash }); previous = hash;
  }
  return events;
}

// A local, non-expiring lease. Never steal from a live/remote/unknown owner.
// Reclaim only a demonstrably dead local PID; each write also checks the token.
export async function lockStore(root, { recover = false } = {}) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('State root cannot be a symlink');
  const file = path.join(root, 'writer.lock');
  const owner = { token: randomUUID(), pid: process.pid, host: os.hostname() };
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(encode(owner)); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST' || !recover) throw new Error('Maintenance store has a writer; use recover only after it has stopped');
    const old = JSON.parse(await fs.readFile(file, 'utf8'));
    if (old.host !== os.hostname() || !Number.isSafeInteger(old.pid) || old.pid < 1) throw new Error('Unknown lock owner; manual reconciliation required');
    let dead = false;
    try { process.kill(old.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
    if (!dead) throw new Error('Cannot recover a live writer');
    // Serialize stale-lock recovery itself so two reclaimers cannot unlink a new lock.
    const recovery = await fs.open(file + '.recovery', 'wx', 0o600);
    try {
      if ((await fs.readFile(file, 'utf8')) !== encode(old)) throw new Error('Lock changed during recovery');
      await fs.unlink(file);
      return { ...await lockStore(root), recovered: true };
    } finally { await recovery.close(); await fs.unlink(file + '.recovery'); }
  }
  let closed = false;
  const assertOwner = async () => {
    if (closed || JSON.parse(await fs.readFile(file, 'utf8')).token !== owner.token) throw new Error('Stale writer fencing token');
  };
  // The broker and controller share one process/lease. Serialize their writes
  // as well as fencing other processes, so concurrent events form one chain.
  let pending = Promise.resolve();
  let transaction = Promise.resolve();
  const append = (type, data) => {
    const operation = pending.then(async () => {
      await assertOwner();
      const events = await readJournal(root);
      const event = { seq: events.length + 1, previous: events.at(-1)?.hash ?? null, at: new Date().toISOString(), fence: owner.token, type, data };
      const record = { ...event, hash: digest(JSON.stringify(event)) };
      const handle = await fs.open(path.join(root, 'events.jsonl'), 'a', 0o600);
      try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); } finally { await handle.close(); }
      return record;
    });
    pending = operation;
    return operation;
  };
  return {
    assertOwner, append,
    exclusive(fn) {
      const operation = transaction.then(fn);
      transaction = operation.catch(() => {});
      return operation;
    },
    async close() { await transaction; await pending; await assertOwner(); await fs.unlink(file); closed = true; },
  };
}

export async function putArtifact(root, bytes) {
  const hash = digest(bytes);
  const relative = `artifacts/${hash}`;
  await durableWrite(path.join(root, relative), bytes);
  return { path: relative, sha256: hash };
}

export async function readArtifact(root, artifact) {
  if (!/^artifacts\/[a-f0-9]{64}$/.test(artifact?.path ?? '') || artifact.path !== 'artifacts/' + artifact.sha256) throw new Error('Invalid artifact identity');
  const file = path.join(root, artifact.path);
  if (!(await fs.lstat(file)).isFile()) throw new Error('Artifact must be a regular file');
  const bytes = await fs.readFile(file);
  if (digest(bytes) !== artifact.sha256) throw new Error('Artifact hash mismatch');
  return bytes;
}

export async function validateArtifacts(root, events) {
  const visit = async (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string' && value.path.startsWith('artifacts/')) await readArtifact(root, value);
    else for (const child of Object.values(value)) await visit(child);
  };
  for (const event of events) await visit(event.data);
}
