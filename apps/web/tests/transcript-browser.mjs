// Production DOM + deterministic worker protocol. Driven by headless-e2e.mjs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { transcriptSpecs } from './ui-cases.mjs';
import { transcript, progress, answer } from './fixtures/transcript.mjs';

const output = resolve(process.env.QI_AGENT_BROWSER_ARTIFACTS);
await mkdir(output, { recursive: false });
const report = { status: 'RUNNING', engine: process.env.QI_AGENT_BROWSER_ENGINE || 'chromium', headless: true,
  scope: 'Core Preview production transcript; offline synthetic worker events', startedAt: new Date().toISOString(),
  cases: transcriptSpecs.map(spec => ({ ...spec, assertions: {}, status: 'NOT_RUN' })), errors: [], cleanup: {} };
const save = () => writeFile(resolve(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
await save();
let browser, interrupted = false;
const interrupt = () => { interrupted = true; void browser?.close().catch(error => report.errors.push(String(error))); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);

async function expandTurn(page) {
  const toggle = page.locator('.turn-process-toggle');
  if (await toggle.count() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
async function expandGroups(page) {
  for (const toggle of await page.locator('.compact-step-toggle').all()) {
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  }
}
async function dispatch(page, events, phase = 'idle') {
  await page.evaluate(({ events, phase }) => {
    const source = window.sources.findLast(source => !source.closed);
    if (!source) throw new Error('No active worker stream');
    for (const event of events) source.dispatchEvent(new MessageEvent('worker', { data: JSON.stringify({
      type: 'event', event: event.type, event_id: event.id, seq: event.seq, durable: true, data: event.data,
    }) }));
    source.dispatchEvent(new MessageEvent('worker', { data: JSON.stringify({
      type: 'event', event: 'agent/state', data: { phase, revision: 3 },
    }) }));
  }, { events, phase });
}

try {
  const module = await import('./browser-fixture.mjs');
  browser = module.browser;
  const { fixture, snapshot, base, errors, settle } = module;
  report.browserVersion = browser.version();
  for (const row of report.cases) {
    if (interrupted) break;
    row.status = 'RUNNING'; row.startedAt = new Date().toISOString();
    let page, tracing = false;
    const check = (name, value) => {
      row.assertions[name] = value === true;
      assert.equal(value, true, name);
    };
    try {
      let controls;
      ({ page, controls } = await fixture(0, { viewport: { width: row.width, height: row.height },
        reducedMotion: 'reduce', serviceWorkers: 'block' }));
      page.setDefaultTimeout(7000);
      await page.context().tracing.start({ screenshots: true, snapshots: true, sources: false }); tracing = true;
      await page.routeWebSocket('**/*', socket => { errors.push('Unexpected WebSocket'); socket.close(); });
      await page.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== base) { errors.push('External request blocked'); await route.abort(); }
        else await route.fallback();
      });
      await page.addInitScript(mode => {
        if (window !== window.top) return;
        localStorage.setItem('qi-agent.web-preferences.v1', JSON.stringify({ locale: 'zh' }));
        if (mode) localStorage.setItem('qi-agent.transcript-view', mode);
        else localStorage.removeItem('qi-agent.transcript-view');
      }, row.mode);
      const active = row.kind === 'default' || row.kind === 'focus';
      const events = transcript({ active, failure: row.kind === 'failure', extraCalls: row.kind === 'scroll' ? 24 : 0 });
      controls.snapshotOverride = { ...snapshot('A', 0), events, cursor: { generation: 1, sequence: events.length },
        state: { phase: active ? 'tool' : 'idle', revision: 2 } };
      await page.goto(base);
      await page.locator('.session-header-title button').waitFor();
      await page.locator('.virtualized-timeline').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await settle(page);

      if (row.kind === 'density') {
        const replies = page.locator('.message-assistant');
        check('all replies retained once', await replies.filter({ hasText: progress }).count() === 1 &&
          await replies.filter({ hasText: answer }).count() === 1);
        if (row.mode !== 'verbose') { await expandTurn(page); await expandGroups(page); }
        check('all seven calls accessible once', await page.locator('.tool-batch-row').count() === 7);
        row.metrics = await page.locator('.tool-batch-row').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        // Desktop density is exactly 24px; narrow screens may wrap to 36px.
        check('dense tool rows', row.metrics.every(height => height >= 24 && height <= (row.width === 1440 ? 25 : 36)));
        const panels = await page.locator('.process-body').evaluateAll(nodes => nodes.map(node => ({
          height: node.clientHeight, cap: Math.min(400, innerHeight / 2),
        })));
        check('bounded process panels', (row.mode === 'verbose' || panels.length === 2) && panels.every(panel => panel.height <= panel.cap));
        const tool = page.locator('.tool-batch-row').first();
        await tool.focus(); await page.keyboard.press('Enter'); await page.locator('.tool-details').first().waitFor();
        check('keyboard disclosure', await tool.getAttribute('aria-expanded') === 'true' &&
          (await page.locator('.tool-details').first().innerText()).includes('inventory.csv'));
        if (row.mode !== 'verbose') {
          const header = page.locator('.compact-step-toggle').first();
          await header.click(); await header.click();
        }
        check('tool details retained on group reopen', await tool.getAttribute('aria-expanded') === 'true');
      } else if (row.kind === 'default') {
        check('default detailed', await page.locator('.virtualized-timeline').getAttribute('data-transcript-view') === 'detailed');
        check('live process flat', await page.locator('.process-group').count() === 0);
        check('all seven calls accessible once', await page.locator('.tool-batch-row').count() === 7);
      } else if (row.kind === 'failure') {
        check('failure retained in turn', /1 失败/.test(await page.locator('.turn-process-toggle').innerText()));
        await expandTurn(page);
        const failed = page.locator('.process-group.is-error');
        check('failure retained in group', await failed.count() === 1 && /exit 127/.test(await failed.innerText()));
        await expandGroups(page);
        check('failed command visible', await page.locator('.tool-item-status.failed').count() === 1 &&
          /python: command not found/.test(await page.locator('.tool-failure').innerText()));
        check('all eight calls accessible once', await page.locator('.tool-batch-row').count() === 8);
        check('success does not erase failure', await page.locator('.message-assistant').filter({ hasText: answer }).count() === 1 &&
          /1 失败/.test(await page.locator('.turn-process-toggle').innerText()));
      } else if (row.kind === 'focus') {
        const tool = page.locator('.tool-batch-row').last();
        await tool.focus(); const handle = await tool.elementHandle();
        const completed = transcript();
        await dispatch(page, completed.slice(events.length));
        await page.locator('.run-outcome').waitFor(); await settle(page);
        check('focused control survives settlement', await handle.evaluate(node => node.isConnected && node === document.activeElement));
        await page.keyboard.press('Enter'); await page.locator('.tool-details').waitFor();
        const outer = page.locator('.turn-process-toggle'); await outer.click(); await outer.click();
        check('outer collapse resets details', await page.locator('.tool-details').count() === 0);
        const header = page.locator('.compact-step-toggle').last(); await header.focus();
        const headerHandle = await header.elementHandle(); await settle(page);
        check('group header keeps focus', await headerHandle.evaluate(node => node.isConnected && node === document.activeElement));
        await page.keyboard.press('Enter'); await page.locator('.tool-batch-row').last().click();
        check('reopened details accessible', /VERIFIED/.test(await page.locator('.tool-details').innerText()));
      } else if (row.kind === 'scroll') {
        await expandTurn(page); await expandGroups(page);
        const panel = page.locator('.process-body').last();
        row.metrics = await panel.evaluate(node => ({ height: node.clientHeight, scroll: node.scrollHeight,
          overflow: getComputedStyle(node).overflowY, cap: Math.min(400, innerHeight / 2) }));
        check('overflowing group is scrollable', row.metrics.scroll > row.metrics.height && row.metrics.overflow === 'auto');
        check('panel capped at half viewport', row.metrics.height <= row.metrics.cap);
        await page.locator('.tool-batch-row').last().click();
        check('last tool reachable', /VERIFIED/.test(await page.locator('.tool-details').innerText()));
      }
      check('no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      check('no runtime mutation', controls.rpcRequests.every(request => ['trust.status', 'runtime.status', 'plugins.ui-slots',
        'plugins.list', 'subagent.status', 'policy.status', 'context.status', 'model.list', 'session.snapshot'].includes(request.method)));
      row.screenshot = `${row.id}.png`;
      await page.screenshot({ path: resolve(output, row.screenshot), fullPage: true, animations: 'disabled' });
      row.status = 'PASS';
    } catch (error) {
      row.status = 'FAIL'; row.error = String(error.stack || error);
      try { row.screenshot = `${row.id}-failure.png`; await page?.screenshot({ path: resolve(output, row.screenshot), fullPage: true }); }
      catch (error) { row.screenshotError = String(error); }
    } finally {
      if (tracing) {
        try {
          if (row.status !== 'PASS') row.trace = `${row.id}-trace.zip`;
          await page.context().tracing.stop(row.trace ? { path: resolve(output, row.trace) } : {});
        } catch (error) { row.status = 'FAIL'; row.traceError = String(error); }
      }
      try { await page?.close(); } catch (error) { row.status = 'FAIL'; row.cleanupError = String(error); }
      row.finishedAt = new Date().toISOString(); await save();
      console.log(JSON.stringify({ id: row.id, status: row.status, error: row.error }));
    }
  }
  report.errors.push(...errors);
  assert(!interrupted && report.cases.every(row => row.status === 'PASS'), 'All transcript cases must pass');
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = String(error.stack || error); }
finally {
  try { await browser?.close(); report.cleanup.browser = browser ? 'closed' : 'not-started'; }
  catch (error) { report.status = 'FAIL'; report.cleanup.browser = String(error); }
  report.interrupted = interrupted;
  if (interrupted) report.status = 'FAIL';
  report.finishedAt = new Date().toISOString(); await save();
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  if (report.status !== 'PASS') process.exitCode = 1;
}
