import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// CI can run this same regression against the frozen pre-fix implementation.
const { startExternalRun } = await import(process.env.QI_EXTERNAL_CLI_MODULE ?? '../../src/qi/external_cli.mjs');

async function fixture(t, denied) {
  const root = await mkdtemp(path.join(tmpdir(), 'qi-signal-test-'));
  const child = new EventEmitter();
  Object.assign(child, { pid: 424242, stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), unref: t.mock.fn() });
  const signals = [];
  t.mock.method(childProcess, 'spawn', () => child);
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -child.pid);
    signals.push(signal);
    const code = denied(signal);
    if (code) throw Object.assign(new Error(`kill ${code}`), { code });
    return true;
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports(); t.mock.timers.reset();
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const run = await startExternalRun({ command: [process.execPath], workspaceRoot: root, timeoutMs: 20 });
  return { child, run, signals };
}

test('close-time EPERM settles uncertain and withholds completed output', { timeout: 5000 }, async t => {
  const { child, run } = await fixture(t, () => 'EPERM');
  child.stdout.write('{"type":"result","status":"completed","output":"untrusted"}\n');
  child.emit('exit', 0);
  assert.doesNotThrow(() => child.emit('close'));
  const result = await run.result;
  assert.equal(result.status, 'uncertain'); assert.equal(result.reason, 'cleanup-failed');
  assert.equal(result.output, ''); assert.equal(result.cleanup.process_closed, true);
  assert.deepEqual(result.cleanup.errors, [{ signal: 'SIGKILL', code: 'EPERM' }]);
  assert.equal(run.stop(), false);
});

test('SIGTERM EPERM cannot escape the deadline callback', { timeout: 5000 }, async t => {
  const { child, run, signals } = await fixture(t, signal => signal === 'SIGTERM' ? 'EPERM' : null);
  assert.doesNotThrow(() => t.mock.timers.tick(20));
  t.mock.timers.tick(200);
  child.emit('exit', null); child.emit('close');
  const result = await run.result;
  assert.equal(result.status, 'uncertain'); assert.equal(result.reason, 'timeout');
  assert.equal(result.cleanup.status, 'uncertain');
  assert.deepEqual(result.cleanup.errors, [{ signal: 'SIGTERM', code: 'EPERM' }]);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL', 'SIGKILL']);
});

test('SIGKILL EPERM without close settles once with unresolved cleanup evidence', { timeout: 5000 }, async t => {
  const { child, run, signals } = await fixture(t, signal => signal === 'SIGKILL' ? 'EPERM' : null);
  t.mock.timers.tick(20);
  assert.doesNotThrow(() => t.mock.timers.tick(200));
  t.mock.timers.tick(200);
  const result = await run.result;
  assert.equal(result.status, 'uncertain'); assert.equal(result.reason, 'timeout');
  assert.equal(result.cleanup.pid, child.pid); assert.equal(result.cleanup.process_closed, false);
  assert.deepEqual(result.cleanup.errors, [{ signal: 'SIGKILL', code: 'EPERM' }]);
  assert.deepEqual(result.cleanup.requested_outcome, { status: 'uncertain', reason: 'timeout' });
  assert.equal(child.unref.mock.callCount(), 1);
  child.emit('exit', 0); child.emit('close');
  assert.equal(await run.result, result); assert.equal(run.interrupt(), false);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('ESRCH after normal close remains a successful terminal', { timeout: 5000 }, async t => {
  const { child, run } = await fixture(t, () => 'ESRCH');
  child.stdout.write('{"type":"result","status":"completed","output":"ok"}\n');
  child.emit('exit', 0); child.emit('close');
  const result = await run.result;
  assert.equal(result.status, 'completed'); assert.equal(result.output, 'ok');
});
