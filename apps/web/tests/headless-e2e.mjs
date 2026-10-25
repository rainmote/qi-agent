// One command builds Core Preview and runs the same composer oracle in two
// headless engines. Existing full Host E2E remains a separate, real backend test.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, readdir, realpath, lstat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { platform, release, arch } from 'node:os';

const { values } = parseArgs({ options: {
  browser: { type: 'string', default: 'all' }, 'source-root': { type: 'string' },
  'ui-root': { type: 'string' }, artifacts: { type: 'string' },
  'timeout-ms': { type: 'string', default: '180000' },
} });
assert(['all', 'chromium', 'webkit'].includes(values.browser), 'browser must be all, chromium or webkit');
const timeout = Number(values['timeout-ms']);
assert(Number.isInteger(timeout) && timeout >= 1000 && timeout <= 180000, 'timeout-ms must be 1000..180000');
const source = await realpath(resolve(values['source-root'] || resolve(import.meta.dirname, '../../..')));
const output = resolve(values.artifacts || resolve(source, 'out/web-headless'), new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID());
await mkdir(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const engines = values.browser === 'all' ? ['chromium', 'webkit'] : [values.browser];
const report = { status: 'RUNNING', startedAt: new Date().toISOString(), source,
  platform: { os: platform(), release: release(), arch: arch(), node: process.version },
  profile: 'offline-api-fixture; no real model/LCU calls', output,
  groups: engines.map(engine => ({ engine, status: 'NOT_RUN' })), staticErrors: [], cleanup: {} };
const save = () => writeFile(resolve(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
await save();
console.log(`Headless UI evidence: ${output}`);
let server, interrupted = false, currentChild, currentBrowser;

function stopChild(signal = 'SIGTERM') {
  if (!currentChild?.pid) return;
  // The suite group can outlive its leader. The separately detached browser is
  // owned by this parent via BrowserServer, never inferred from the suite PID.
  try { process.kill(process.platform === 'win32' ? currentChild.pid : -currentChild.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') (report.cleanup.errors ||= []).push(String(error)); }
}
const interrupt = () => {
  interrupted = true; stopChild();
  void currentBrowser?.kill().catch(error => (report.cleanup.errors ||= []).push(String(error)));
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

async function inventory(root, relative = '') {
  const result = {};
  for (const item of await readdir(resolve(root, relative), { withFileTypes: true })) {
    const name = relative ? relative + '/' + item.name : item.name;
    assert(!item.isSymbolicLink(), 'UI assets must not contain symlinks');
    if (item.isDirectory()) Object.assign(result, await inventory(root, name));
    else { assert(item.isFile()); result[name] = sha(await readFile(resolve(root, name))); }
  }
  return result;
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function runGroup(group, url) {
  group.status = 'RUNNING';
  group.startedAt = new Date().toISOString();
  group.timeoutMs = timeout;
  const folder = resolve(output, group.engine);
  const log = [];
  group.cleanup = {};
  group.log = `${group.engine}.log`;
  let owner, child, watchdog, forced;
  try {
    const playwrightPath = process.env.QI_AGENT_PLAYWRIGHT_MODULE || resolve(source, 'node_modules/playwright/index.mjs');
    const playwright = await import(pathToFileURL(playwrightPath).href);
    // Playwright launches browsers in separate process groups. Keep their real
    // owner here so a crashed or killed test suite cannot orphan its browser.
    owner = await playwright[group.engine].launchServer({ headless: true, host: '127.0.0.1', timeout: 30000,
      ...(group.engine === 'chromium' && process.env.QI_AGENT_BROWSER_CHANNEL ? { channel: process.env.QI_AGENT_BROWSER_CHANNEL } : {}) });
    currentBrowser = owner;
    group.browserPid = owner.process().pid;
    assert(!interrupted, 'Run interrupted during browser startup');
    child = spawn(process.execPath, [resolve(import.meta.dirname, 'composer-browser.mjs')], {
      cwd: source, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QI_AGENT_WEB_TEST_URL: url, QI_AGENT_BROWSER_ENGINE: group.engine,
        QI_AGENT_BROWSER_ARTIFACTS: folder,
        QI_AGENT_PLAYWRIGHT_MODULE: playwrightPath, QI_AGENT_BROWSER_WS_ENDPOINT: owner.wsEndpoint() },
    });
    currentChild = child;
    group.pid = child.pid;
    group.command = [process.execPath, resolve(import.meta.dirname, 'composer-browser.mjs')];
    child.stdout.on('data', bytes => { log.push(bytes); process.stdout.write(bytes); });
    child.stderr.on('data', bytes => { log.push(bytes); process.stderr.write(bytes); });
    watchdog = setTimeout(() => {
      group.timedOut = true;
      stopChild();
      void owner.kill().catch(error => (report.cleanup.errors ||= []).push(String(error)));
      forced = setTimeout(() => { group.forcedKill = true; stopChild('SIGKILL'); }, 3000);
    }, timeout);
    const exit = await bounded(new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => done({ code, signal }));
    }), timeout + 5000, 'Suite did not close after bounded shutdown');
    group.exit = exit;
    const result = JSON.parse(await readFile(resolve(folder, 'result.json'), 'utf8'));
    group.result = `${group.engine}/result.json`;
    group.browserVersion = result.browserVersion;
    group.counts = { total: result.cases.length, passed: result.cases.filter(row => row.status === 'PASS').length,
      failed: result.cases.filter(row => row.status === 'FAIL').length, notRun: result.cases.filter(row => row.status === 'NOT_RUN').length };
    assert(!group.timedOut && !interrupted, 'Suite timed out or was interrupted');
    assert(exit.code === 0 && !exit.signal, 'Suite process did not succeed');
    assert(result.status === 'PASS' && result.headless === true && result.engine === group.engine, 'Suite result is not PASS');
    assert(group.counts.total === 11 && group.counts.passed === 11, 'Missing required scenarios');
    for (const row of result.cases) {
      assert(row.screenshot && (await lstat(resolve(folder, row.screenshot))).size > 0, 'Missing screenshot');
      assert(Object.keys(row.assertions).length === 12 && Object.values(row.assertions).every(Boolean), 'Missing or failing geometry oracle');
    }
    group.status = 'PASS';
  } catch (error) { group.status = 'FAIL'; group.error = String(error.stack || error); }
  finally {
    clearTimeout(watchdog); clearTimeout(forced);
    if (group.status !== 'PASS') stopChild('SIGKILL');
    if (child) {
      group.cleanup.suite = child.exitCode !== null || child.signalCode !== null ? 'exited' : 'UNCONFIRMED';
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      if (group.cleanup.suite === 'UNCONFIRMED') group.status = 'FAIL';
    } else group.cleanup.suite = 'not-started';
    if (owner) {
      try {
        try { await bounded(owner.close(), 3000, 'Browser close timed out'); }
        catch { group.cleanup.browserForced = true; await bounded(owner.kill(), 3000, 'Browser kill timed out'); }
        assert(owner.process().exitCode !== null || owner.process().signalCode !== null, 'Browser exit unconfirmed');
        group.cleanup.browser = 'exited';
      } catch (error) { group.status = 'FAIL'; group.cleanup.browser = String(error); }
    } else group.cleanup.browser = 'not-started';
    currentChild = undefined; currentBrowser = undefined;
    group.finishedAt = new Date().toISOString();
    const bytes = Buffer.concat(log);
    await writeFile(resolve(output, group.log), bytes);
    group.logSha256 = sha(bytes);
    await save();
  }
}

try {
  report.sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  report.dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim());
  report.controllers = {};
  for (const name of ['headless-e2e.mjs', 'composer-browser.mjs', 'browser-fixture.mjs']) {
    report.controllers[name] = sha(await readFile(resolve(import.meta.dirname, name)));
  }
  report.inputHashes = {};
  for (const name of ['package-lock.json', 'agent.edn', 'vite.config.ts']) report.inputHashes[name] = sha(await readFile(resolve(source, name)));
  let root;
  if (values['ui-root']) {
    root = await realpath(resolve(values['ui-root']));
    report.build = 'EXISTING_ASSETS';
    // A packaged app has its own source identity; the runner HEAD is not it.
    try {
      const manifest = JSON.parse(await readFile(resolve(root, '../../../runtime-manifest.json'), 'utf8'));
      report.targetSource = { sha: manifest.source_sha, fingerprint: manifest.source_fingerprint, edition: manifest.edition };
    } catch (error) { if (error.code !== 'ENOENT') throw error; report.targetSource = null; }
  } else {
    root = resolve(output, 'site');
    const require = createRequire(resolve(source, 'package.json'));
    const { build } = await import(pathToFileURL(require.resolve('vite')).href);
    await build({ configFile: resolve(source, 'vite.config.ts'), envDir: false,
      define: { __QI_DESKTOP_EDITION__: JSON.stringify('core-preview') },
      build: { outDir: root, sourcemap: false, emptyOutDir: true } });
    report.build = 'CORE_PREVIEW_PRODUCTION';
    report.targetSource = { sha: report.sourceSha, dirty: report.dirty, edition: 'core-preview' };
  }
  assert((await lstat(resolve(root, 'index.html'))).isFile(), 'Production index.html required');
  report.uiRoot = root;
  report.uiAssets = await inventory(root);
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'GET');
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const path = await realpath(resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1)));
      assert(path.startsWith(root + sep) && (await lstat(path)).isFile(), 'Static request escaped asset root');
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
        '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[extname(path)] || 'application/octet-stream');
      response.end(await readFile(path));
    } catch (error) { report.staticErrors.push(String(error)); response.writeHead(404).end(); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const group of report.groups) { if (interrupted) break; await runGroup(group, url); }
  assert(!interrupted && report.groups.every(group => group.status === 'PASS'), 'All requested engines must pass');
  assert(!report.cleanup.errors?.length, 'Process cleanup failed');
  assert.deepEqual(report.staticErrors, []);
  assert.deepEqual(await inventory(root), report.uiAssets, 'UI assets changed during acceptance');
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = String(error.stack || error); }
finally {
  try {
    if (server?.listening) { server.closeAllConnections(); await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); }
    report.cleanup.server = 'closed';
  } catch (error) { report.status = 'FAIL'; report.cleanup.server = String(error); }
  report.interrupted = interrupted;
  if (interrupted) report.status = 'FAIL';
  report.finishedAt = new Date().toISOString();
  await save();
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  console.log(JSON.stringify({ status: report.status, evidence: output, groups: report.groups.map(({ engine, status, counts }) => ({ engine, status, counts })) }));
  if (report.status !== 'PASS') process.exitCode = 1;
}
