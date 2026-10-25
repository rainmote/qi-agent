// Real production DOM, isolated API fixture. No model or desktop operation.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve(process.env.QI_AGENT_BROWSER_ARTIFACTS);
await mkdir(output, { recursive: false });
const specs = [
  { id: 'trusted-empty-1250x760', width: 1250, height: 760, trust: 'allow' },
  { id: 'trusted-empty-1280x840', width: 1280, height: 840, trust: 'allow' },
  { id: 'restricted-empty-1024x600', width: 1024, height: 600, trust: 'deny' },
  { id: 'trusted-empty-minimum', width: 360, height: 480, trust: 'allow' },
  { id: 'trusted-running-900x600', width: 900, height: 600, trust: 'allow', phase: 'model' },
  { id: 'trusted-long-minimum', width: 900, height: 480, trust: 'allow', long: true },
  { id: 'trusted-long-phone', width: 390, height: 844, trust: 'allow', long: true },
  { id: 'trusted-pending-900x600', width: 900, height: 600, trust: 'allow', phase: 'tool', approval: true },
  { id: 'trusted-resize-1280to480', width: 1280, height: 840, trust: 'allow', long: true, resize: true },
  { id: 'trusted-height-only', width: 900, height: 840, trust: 'allow', long: true, resize: true },
  { id: 'trusted-running-expand', width: 900, height: 480, trust: 'allow', long: true, phase: 'model', expand: true },
];
const report = { status: 'RUNNING', engine: process.env.QI_AGENT_BROWSER_ENGINE || 'chromium',
  headless: true, scope: 'Core Preview production UI with offline API fixture',
  startedAt: new Date().toISOString(), cases: specs.map(spec => ({ ...spec, status: 'NOT_RUN' })), errors: [], cleanup: {} };
const save = () => writeFile(resolve(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
await save();
let browser, interrupted = false;
const interrupt = () => { interrupted = true; void browser?.close().catch(error => report.errors.push(String(error))); };
process.on('SIGTERM', interrupt);
process.on('SIGINT', interrupt);

// Wait for React, fonts and ResizeObserver without requiring the layout to pass
// the oracle. The broken baseline must settle and fail a geometry assertion.
async function settleLayout(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const nodes = ['.composer', '.composer textarea', '.session-run-summary', '.run-overview'];
    const sample = JSON.stringify(nodes.map(selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height, getComputedStyle(element).overflowY];
    }));
    const old = window.__qiComposerLayout;
    const stable = old?.sample === sample ? old.stable + 1 : 0;
    const frames = (old?.frames || 0) + 1;
    window.__qiComposerLayout = { sample, stable, frames };
    return stable >= 4 && frames >= 6;
  }, undefined, { polling: 'raf', timeout: 7000 });
  await page.evaluate(() => { delete window.__qiComposerLayout; });
}

async function measure(page) {
  return page.evaluate(() => {
    const selectors = ['.main-panel', '.desktop-preview-notice', '.session-view', '.session-header', '.timeline',
      '.composer-wrap', '.composer-trust', '.composer', '.composer textarea', '.composer-footer', '.session-run-summary', '.approval-panel'];
    const boxes = {};
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      boxes[selector] = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
        width: rect.width, height: rect.height, clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight, overflowY: getComputedStyle(element).overflowY };
    }
    const buttons = [...document.querySelectorAll('.composer-footer button')]
      .filter(element => getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().height > 0)
      .map(element => { const box = element.getBoundingClientRect(); return {
        label: element.getAttribute('aria-label') || element.textContent,
        top: box.top, bottom: box.bottom, left: box.left, right: box.right,
      }; });
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, boxes, buttons };
  });
}

try {
  const module = await import('./browser-fixture.mjs');
  browser = module.browser;
  report.browserVersion = browser.version();
  const { fixture, snapshot, base, errors } = module;
  for (const row of report.cases) {
    if (interrupted) break;
    row.status = 'RUNNING';
    row.startedAt = new Date().toISOString();
    let page, tracing = false;
    try {
      let controls;
      ({ page, controls } = await fixture(0, { viewport: { width: row.width, height: row.height },
        serviceWorkers: 'block', reducedMotion: 'reduce' }));
      page.setDefaultTimeout(7000);
      await page.context().tracing.start({ screenshots: true, snapshots: true, sources: false });
      tracing = true;
      await page.routeWebSocket('**/*', socket => { errors.push('Unexpected WebSocket'); socket.close(); });
      await page.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== base) { errors.push('External request blocked'); await route.abort(); }
        else await route.fallback();
      });
      await page.addInitScript(() => {
        localStorage.setItem('qi-agent.web-preferences.v1', JSON.stringify({ locale: 'zh' }));
        localStorage.setItem('qi-agent.transcript-view', 'compact');
      });
      const trust = { configured: true, root: '/mock', decision: row.trust, 'explicit?': true,
        'matched-root': '/mock', source: 'fixture', mutable: true };
      controls.trustStates = { A: trust, B: trust };
      controls.snapshotOverride = { ...snapshot('A', 0), trust, state: { phase: row.phase || 'idle', revision: 2 },
        interactions: row.approval ? [{ id: 'approval', title: '需要确认操作', message: '这是离线验收，请检查按钮可见性。',
          items: [{ value: 'allow', label: '允许' }] }] : [] };
      await page.goto(base);
      const input = page.locator('.session-view .composer textarea');
      await input.waitFor();
      await page.locator('.composer-trust').waitFor();
      assert.equal(await page.locator('.desktop-preview-notice').count(), 1, 'Real Core Preview banner required');
      await input.focus();
      if (row.long) await input.fill(Array.from({ length: 40 }, (_, i) => `第${i + 1}行，检查输入框在窗口内的高度。`).join('\n'));
      await settleLayout(page);
      if (row.resize) { await page.setViewportSize({ width: 900, height: 480 }); await settleLayout(page); }
      if (row.expand) {
        const overview = page.locator('.session-view > .run-overview');
        const before = (await overview.boundingBox()).height;
        await page.locator('.compact-run-details > summary').click();
        await settleLayout(page);
        row.expansion = { before, after: (await overview.boundingBox()).height,
          open: await page.locator('.compact-run-details').evaluate(element => element.open) };
        assert.equal(row.expansion.open, true, 'Run details really expanded');
        assert(row.expansion.after > before, 'Expanded details occupy more height');
      }
      row.metrics = await measure(page);
      const m = row.metrics, b = m.boxes, card = b['.composer'], footer = b['.composer-footer'];
      const wrap = b['.composer-wrap'], summary = b['.session-run-summary'], textarea = b['.composer textarea'];
      row.assertions = {
        'main and session stay inside viewport': b['.main-panel'].bottom <= m.height + 1 && b['.session-view'].bottom <= m.height + 1,
        'composer has at least 28px below card': m.height - card.bottom >= 27,
        'summary is fully visible with bottom inset': summary.height >= 18 && summary.bottom <= m.height - 3 && summary.top >= card.bottom,
        'composer wrap stays in viewport': wrap.top >= b['.session-header'].bottom - 1 && wrap.bottom <= m.height + 1,
        'footer fully inside card': footer.top >= card.top && footer.bottom <= card.bottom + 1,
        'all footer buttons in viewport': m.buttons.length >= 3 && m.buttons.every(button => button.top >= 0 && button.bottom <= m.height - 8 && button.left >= 0 && button.right <= m.width + 1),
        'trust stays above input card': b['.composer-trust'].bottom <= card.top + 1,
        'no horizontal page overflow': m.documentWidth <= m.width,
        'empty placeholder cannot create scrollbar': row.long || textarea.overflowY === 'hidden',
        'long drafts remain scrollable': !row.long || textarea.scrollHeight <= textarea.clientHeight + 1 || textarea.overflowY === 'auto',
        'approval retained': !row.approval || (b['.approval-panel']?.height > 0 && b['.approval-panel'].top >= b['.session-header'].bottom - 1),
        'no mutation': !controls.rpcRequests.some(request => ['turn.submit', 'turn.follow-up', 'turn.steer', 'interaction.resolve', 'command.execute'].includes(request.method)),
      };
      row.screenshot = `${row.id}.png`;
      await page.screenshot({ path: resolve(output, row.screenshot), fullPage: true, animations: 'disabled' });
      assert(Object.values(row.assertions).every(Boolean), 'Composer geometry assertions failed');
      row.status = 'PASS';
    } catch (error) {
      row.status = 'FAIL';
      row.error = String(error.stack || error);
      try {
        row.screenshot = `${row.id}-failure.png`;
        await page?.screenshot({ path: resolve(output, row.screenshot), fullPage: true, animations: 'disabled' });
      } catch (captureError) { row.screenshotError = String(captureError); }
    } finally {
      if (tracing) {
        try {
          if (row.status !== 'PASS') row.trace = `${row.id}-trace.zip`;
          await page.context().tracing.stop(row.trace ? { path: resolve(output, row.trace) } : {});
        } catch (error) { row.status = 'FAIL'; row.traceError = String(error); }
      }
      try { await page?.close(); } catch (error) { row.status = 'FAIL'; row.cleanupError = String(error); }
      row.finishedAt = new Date().toISOString();
      await save();
      console.log(JSON.stringify({ id: row.id, status: row.status,
        failed: Object.entries(row.assertions || {}).filter(([, pass]) => !pass).map(([name]) => name), error: row.error }));
    }
  }
  report.errors.push(...errors);
  assert(!interrupted, 'Run interrupted');
  assert.equal(report.cases.length, 11);
  assert(report.cases.every(row => row.status === 'PASS'), 'All 11 scenarios must pass');
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = String(error.stack || error); }
finally {
  try { await browser?.close(); report.cleanup.browser = browser ? 'closed' : 'not-started'; }
  catch (error) { report.status = 'FAIL'; report.cleanup.browser = String(error); }
  if (interrupted) report.status = 'FAIL';
  report.interrupted = interrupted;
  report.finishedAt = new Date().toISOString();
  await save();
  process.off('SIGTERM', interrupt);
  process.off('SIGINT', interrupt);
  if (report.status !== 'PASS') process.exitCode = 1;
}
