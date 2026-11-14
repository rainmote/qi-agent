// Real production DOM, isolated API fixture. No model or desktop operation.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve(process.env.QI_AGENT_BROWSER_ARTIFACTS);
await mkdir(output, { recursive: false });
import { composerSpecs as specs } from './ui-cases.mjs';

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
      await page.addInitScript(theme => {
        localStorage.setItem('qi-agent.web-preferences.v1', JSON.stringify({ locale: 'zh' }));
        localStorage.setItem('qi-agent.transcript-view', 'compact');
        localStorage.setItem('qi-agent.theme', theme || 'dark');
      }, row.theme);
      const trust = { configured: true, root: '/mock', decision: row.trust, 'explicit?': true,
        'matched-root': '/mock', source: 'fixture', mutable: true };
      controls.trustStates = { A: trust, B: trust };
      controls.snapshotOverride = { ...snapshot('A', 0), trust, state: { phase: row.phase || 'idle', revision: 2 },
        interactions: row.approval ? [{ id: 'approval', title: '需要确认操作', message: '这是离线验收，请检查按钮可见性。',
          items: [{ value: 'allow', label: '允许' }] }] : [] };
      const events = [{ type: 'message', data: { message: { role: 'user', content: '库存核算' } } },
        { type: 'step/start', data: { step: 1 } },
        { type: 'usage/request', data: { request_id: 'one', scope: 'logical_request', status: 'started' } },
        { type: 'usage/request', data: { request_id: 'one', scope: 'logical_request', status: 'completed', duration_ms: 1000,
          usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } } } },
        // Replayed starts and repeated terminal facts must not double-count or erase settled usage.
        { type: 'usage/request', data: { request_id: 'one', scope: 'logical_request', status: 'started' } },
        { type: 'usage/request', data: { request_id: 'one', scope: 'logical_request', status: 'completed', duration_ms: 1000,
          usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } } } },
        { type: 'step/end', data: { step: 1 } },
        { type: 'agent/run/end', data: { status: 'completed', verification: 'not-run', usage: { total_tokens: 1100 } } }];
      if (row.stats) controls.snapshotOverride.events = events.map((event, i) => ({ ...event, id: `stats-${i}`, seq: i + 1, at: '2026-11-14T14:00:00Z' }));
      if (row.stats === 'unknown') controls.snapshotOverride.events.push({ id: 'unknown', seq: 20, at: '2026-11-14T14:01:00Z', type: 'usage/request', data: { request_id: 'two', scope: 'logical_request', status: 'failed' } });
      if (row.stats !== 'unknown') controls.snapshotOverride.context = { used_tokens: 2400, context_window: 10000, percent: 24, system_tokens: 800, tool_tokens: 600, message_tokens: 1000 };
      controls.modelCatalog = { current: { id: 'mock-a', model: 'Model A', 'context-window': 10000 }, providers: [{ id: 'mock-a', model: 'Model A', 'context-window': 10000 }] };
      controls.snapshotOverride.models = controls.modelCatalog;
      controls.contextStatus = controls.snapshotOverride.context;
      await page.goto(base);
      const input = page.locator('.session-view .composer textarea');
      await input.waitFor();
      await page.locator('.permission-trigger').waitFor();
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
      const dock = page.locator('.session-run-summary');
      const active = !!row.phase || !!row.approval;
      const contextBelow = await page.locator('.composer .context-control').count() === 0 &&
        (active ? await dock.locator('.context-control').count() === 0 : await dock.locator('.context-control').count() === 1);
      let statistics = true, details = true;
      if (row.stats) {
        const reading = await dock.innerText();
        statistics = /1 轮 1 步/.test(reading) && /1.1K tok/.test(reading) &&
          (row.stats === 'unknown' ? /已知/.test(reading) && /上下文未知/.test(reading) && !/缓存命中/.test(reading) : /缓存命中 80%/.test(reading) && /24%/.test(reading));
        if (statistics) {
          const usage = dock.locator('[data-composer-stat="usage"] button');
          await usage.focus(); await usage.press('Enter');
          await page.getByRole('dialog', { name: '会话用量', exact: true }).waitFor();
          details = /1,000/.test(await page.getByRole('dialog', { name: '会话用量', exact: true }).innerText());
          await page.keyboard.press('Escape');
          details = details && await usage.evaluate(el => el === document.activeElement);
          const context = dock.locator('.context-trigger'); await context.click();
          await page.getByRole('dialog', { name: '上下文占用', exact: true }).waitFor();
          await page.keyboard.press('Escape');
          details = details && await context.evaluate(el => el === document.activeElement);
        } else details = false;
      }
      await page.locator('.permission-trigger').click();
      const trustReading = await page.locator('.permission-menu').innerText();
      const reviewReachable = /管理项目信任/.test(trustReading) && /仍受权限和审批约束/.test(trustReading);
      await page.keyboard.press('Escape');
      await settleLayout(page);
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
        'trusted notice in permission menu; restricted notice above card': row.trust === 'allow' ? !b['.composer-trust'] : b['.composer-trust']?.bottom <= card.top + 1,
        'context below card and absent during activity': contextBelow,
        'session statistics use durable records': statistics,
        'statistics keyboard details and focus return': details,
        'trust review remains reachable without mutation': reviewReachable,
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
  assert.equal(report.cases.length, 15);
  assert(report.cases.every(row => row.status === 'PASS'), 'All 15 scenarios must pass');
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
