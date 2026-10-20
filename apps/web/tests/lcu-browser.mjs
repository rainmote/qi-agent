// Browser assertions use mock RPC data; never count these as native LCU/model E2E.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browser, base, errors, fixture, open, settle, gate } from './browser-fixture.mjs';

const initial = { enabled: true, provider: 'lcu', 'configured-provider': 'lcu', connected: false,
  state: 'disconnected', trusted: true, 'local-desktop': true, 'image-model': true,
  'input-scope': 'host-desktop', tools: [], uncertain: null,
  capabilities: { surfaces: ['computer'], 'browser-origin-consent': 'unsupported', 'system-permissions': 'unverified' } };
const output = process.env.QI_AGENT_BROWSER_ARTIFACTS;
const shot = async (page, name) => {
  if (!output) return;
  await fs.mkdir(output, { recursive: true }); await settle(page);
  await page.screenshot({ path: `${output}/lcu-mock-${name}.png`, animations: 'disabled', fullPage: true });
};
const settings = async page => {
  await page.locator('.session-header-title button').waitFor();
  await settle(page);
  await page.keyboard.press('Alt+Shift+KeyS');
  await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
  await page.getByRole('button', { name: '工具', exact: true }).click();
  await page.getByRole('region', { name: '电脑操作' }).waitFor();
};

let activePage;
try {
  const { page } = await fixture();
  activePage = page;
  const states = { A: structuredClone(initial), B: { ...initial, enabled: false, state: 'disabled' } };
  const requests = []; let hold, holdStatus, drop = false;
  await page.route('**/api/sessions/*/rpc', async route => {
    const input = route.request().postDataJSON(), id = new URL(route.request().url()).pathname.split('/')[3];
    if (input.method !== 'runtime.status' && !(input.method === 'command.execute' && input.params.command.startsWith('/computer '))) return route.fallback();
    let result;
    if (input.method === 'runtime.status') {
      result = { plugins: [], tools: states[id].tools.map(name => ({ name, description: 'Fixture desktop tool' })), commands: [], 'computer-use': structuredClone(states[id]) };
      if (holdStatus) { const g = holdStatus; holdStatus = null; g.seen.resolve(); await g.release.promise; g.done.resolve(); }
    } else {
      requests.push({ ...input, sessionId: id });
      if (hold) { const g = hold; hold = null; g.seen.resolve(); await g.release.promise; }
      const action = input.params.command.split(' ')[1];
      states[id] = action === 'disconnect' ? { ...states[id], connected: false, state: 'disconnected', tools: [] }
        : { ...states[id], connected: true, state: 'connected', uncertain: null, tools: ['computer_js', 'computer_js_reset'] };
      if (drop) { drop = false; await route.abort(); return; }
      result = { handled: true, output: states[id] };
    }
    await route.fulfill({ json: { ok: true, result } });
  });
  await page.goto(base); await open(page, 'A'); await settings(page);
  const panel = page.getByRole('region', { name: '电脑操作' });
  await shot(page, 'disconnected-1440');
  hold = gate('connect'); const connectGate = hold;
  await panel.getByRole('button', { name: '连接电脑操作', exact: true }).dblclick();
  await connectGate.seen.promise;
  assert.equal(requests.length, 1, 'double click admits one journaled connection command');
  assert.equal(requests[0].params.command, '/computer connect'); assert.match(requests[0].commandId, /^web-/);
  connectGate.release.resolve();
  await panel.getByRole('button', { name: '断开电脑操作' }).waitFor();
  assert.match(await panel.textContent(), /2 个模型工具/); await shot(page, 'connected-1440');
  await panel.getByRole('button', { name: '断开电脑操作' }).click();
  await panel.getByRole('button', { name: '连接电脑操作', exact: true }).waitFor();
  // Closing settings does not cancel a read. A pre-connect reply is stale even
  // when it belongs to the same session and its replacement panel is mounted.
  holdStatus = gate('same-A'); const sameSession = holdStatus;
  await panel.getByRole('button', { name: '刷新状态' }).click(); await sameSession.seen.promise;
  await page.keyboard.press('Escape'); await settings(page);
  await panel.getByRole('button', { name: '连接电脑操作', exact: true }).click();
  await panel.getByRole('button', { name: '断开电脑操作' }).waitFor();
  sameSession.release.resolve(); await sameSession.done.promise; await settle(page);
  assert.equal(await panel.getByRole('button', { name: '断开电脑操作' }).count(), 1, 'old same-session status cannot overwrite the completed connection');
  await panel.getByRole('button', { name: '断开电脑操作' }).click();
  await panel.getByRole('button', { name: '连接电脑操作', exact: true }).waitFor();
  states.A = { ...initial, state: 'uncertain', uncertain: { uncertain: true }, error: 'Fixture: input outcome unknown' };
  await panel.getByRole('button', { name: '刷新状态' }).click();
  const reconnect = panel.getByRole('button', { name: '核对后重新连接' });
  await reconnect.waitFor(); assert.equal(await reconnect.isDisabled(), true);
  await shot(page, 'uncertain-1440');
  await panel.getByRole('checkbox').check(); await reconnect.click();
  await panel.getByRole('button', { name: '断开电脑操作' }).waitFor();
  assert.equal(requests.at(-1).params.command, '/computer reconnect');
  states.A = { ...initial, trusted: false, state: 'untrusted' };
  await panel.getByRole('button', { name: '刷新状态' }).click();
  await panel.getByText('先查看项目信任范围；此处不会替你信任项目。').waitFor();
  assert.equal(await panel.getByRole('button', { name: '连接电脑操作', exact: true }).isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 }); await shot(page, 'untrusted-390');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.keyboard.press('Escape'); await page.reload(); await settings(page);
  assert.match(await panel.textContent(), /项目受限/);
  await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 1000 });
  // A late A status reply must not overwrite B after leaving settings/switching sessions.
  await settings(page); holdStatus = gate('old-A'); const stale = holdStatus;
  await panel.getByRole('button', { name: '刷新状态' }).click(); await stale.seen.promise;
  await page.keyboard.press('Escape'); await open(page, 'B');
  stale.release.resolve(); await stale.done.promise; await settings(page);
  await panel.getByText('lcu · 当前配置未启用', { exact: true }).waitFor(); await shot(page, 'disabled-B-1440');
  assert.equal(await panel.getByRole('button', { name: '连接电脑操作', exact: true }).count(), 0);
  await page.keyboard.press('Escape'); await open(page, 'A'); states.A = structuredClone(initial);
  await settings(page); await panel.getByRole('button', { name: '刷新状态' }).click();
  drop = true; await panel.getByRole('button', { name: '连接电脑操作', exact: true }).click();
  await panel.getByRole('alert').waitFor();
  assert.equal(requests.length, 6, 'lost reply does not replay the connection command');
  assert.equal(await panel.getByRole('button', { name: '连接电脑操作', exact: true }).isDisabled(), true);
  await shot(page, 'lost-reply-1440');
  await page.close();
  // A stale command continuation must not advance the current session's
  // request generation while B's initial runtime response is still pending.
  const second = await fixture(), next = second.page; activePage = next;
  second.controls.runtimeStatus = { plugins: [], tools: [], commands: [], 'computer-use': structuredClone(initial) };
  const oldSnapshot = gate('A'), runtimeB = gate('B'), continuedA = gate('continued-A');
  let releasedA = false;
  await next.route('**/api/sessions/*/rpc', async route => {
    const input = route.request().postDataJSON(), id = new URL(route.request().url()).pathname.split('/')[3];
    if (id === 'A' && input.method === 'trust.status' && releasedA) continuedA.seen.resolve();
    if (id !== 'B' || input.method !== 'runtime.status') return route.fallback();
    runtimeB.seen.resolve(); await runtimeB.release.promise;
    await route.fulfill({ json: { ok: true, result: { plugins: [], tools: [], commands: [], 'computer-use': states.B } } });
    runtimeB.done.resolve();
  });
  await next.goto(base); await open(next, 'A'); await settle(next);
  second.controls.holdSnapshot = oldSnapshot;
  const composer = next.getByRole('textbox', { name: '给代理发送消息', exact: true });
  await composer.fill('/computer status'); await composer.press('Enter'); await oldSnapshot.seen.promise;
  await open(next, 'B'); await runtimeB.seen.promise;
  releasedA = true; oldSnapshot.release.resolve(); await continuedA.seen.promise;
  runtimeB.release.resolve(); await runtimeB.done.promise; await settle(next); await settings(next);
  assert.match(await next.getByRole('region', { name: '电脑操作' }).textContent(), /当前配置未启用/,
    'a stale A command continuation must not invalidate B runtime');
  await shot(next, 'stale-command-B-1440');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, evidence: 'MOCK RPC + real production browser; no native LCU/model', commands: requests.length,
    coverage: ['double-click', 'connect/disconnect', 'same-session-stale-reply', 'uncertain inspection', 'untrusted', '390px', 'reload', 'late-session-reply', 'stale-command-continuation', 'lost-reply-no-replay'] }));
} catch (error) {
  if (activePage && output) {
    await shot(activePage, 'failure');
    await fs.writeFile(`${output}/lcu-mock-failure.json`, JSON.stringify({ error: String(error), pageErrors: errors,
      url: activePage.url(), text: await activePage.locator('body').innerText() }, null, 2));
  }
  throw error;
} finally { await browser.close(); }
