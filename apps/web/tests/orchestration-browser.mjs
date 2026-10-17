// Real production App, fixed in-memory RPC data, no daemon or model requests.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.QI_AGENT_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.QI_AGENT_BROWSER_CHANNEL ? { channel: process.env.QI_AGENT_BROWSER_CHANNEL } : {}) });
const base = process.env.QI_AGENT_WEB_TEST_URL || 'http://127.0.0.1:4179';
const errors = [];
const session = { id: 'orchestration', workspaceId: 'ws', path: '/mock/session.jsonl', name: '编排测试',
  label: null, eventCount: 0, messageCount: 0, updatedAt: '2026-10-03T00:00:00Z', presetId: 'standard' };
const policy = { mode: 'ask', modes: [{ id: 'ask', label: 'Workspace Write' }] };
const models = { current: { id: 'mock', model: 'Mock' }, providers: [{ id: 'mock', model: 'Mock' }] };
const copy = value => JSON.parse(JSON.stringify(value));
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.sources = [];
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; window.sources.push(this); queueMicrotask(() => this.dispatchEvent(new Event('ready'))); }
      close() { this.closed = true; }
    };
  });
  const state = { plan: null, definitions: {}, runs: {}, tasks: {},
    mail: [{ id: 'mail-1', from: 'child-1', message: '资料核对完成，请检查来源。', created_at: '2026-10-03' }],
    members: [{ id: session.id, role: 'owner' }, { id: 'child-1', role: 'subagent', label: '资料核对员' }],
    calls: [], approval: null, seq: 0 };
  const snapshot = () => ({ session_id: session.id, path: session.path,
    cursor: { generation: 1, sequence: state.seq }, events: [], state: { phase: 'idle', revision: 0 },
    models, policy, interactions: [], interactions_revision: state.seq });
  async function emit(event, data) {
    await page.evaluate(envelope => window.sources.findLast(source => !source.closed)?.dispatchEvent(
      new MessageEvent('worker', { data: JSON.stringify(envelope) })),
    { type: 'event', event, event_id: `fixture-${++state.seq}`, seq: state.seq, durable: false, data });
  }
  const version = (record, expected) => assert.equal(expected, record.revision, 'UI sends the current record revision');
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) { errors.push(`Unexpected external request: ${url.origin}`); await route.abort(); return; }
    if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
    try {
      const path = url.pathname; let result;
      if (path === '/api/bootstrap') result = { workspaces: [{ id: 'ws', name: '隔离工作区', path: '/mock', addedAt: '2026-10-03' }],
        catalogs: [{ workspaceId: 'ws', sessions: [session] }], activeWorkspaceId: 'ws' };
      else if (path === '/api/presets') result = [{ id: 'standard', name: 'Standard', trust: 'system' }];
      else if (path.endsWith('/open')) result = { session, snapshot: snapshot(), eventCursor: 'mock:0' };
      else if (path.endsWith('/rpc')) {
        const { method, params = {} } = route.request().postDataJSON();
        state.calls.push({ method, params: copy(params) });
        switch (method) {
          case 'plugins.ui-slots': result = { slots: [] }; break;
          case 'runtime.status': result = { plugins: [], tools: [], commands: [] }; break;
          case 'subagent.status': result = { providers: [], jobs: [] }; break;
          case 'policy.status': result = policy; break;
          case 'model.list': result = models; break;
          case 'context.status': result = null; break;
          case 'session.snapshot': result = snapshot(); break;
          case 'planning.show': result = { plan: state.plan }; break;
          case 'workflow.show': result = { definitions: state.definitions, runs: state.runs }; break;
          case 'team.show': result = { owner_id: session.id, tasks: state.tasks, members: state.members, unread: state.mail.length }; break;
          case 'team.mailbox': result = { messages: state.mail }; break;
          case 'planning.create':
            state.plan = { id: 'plan-1', title: params.title, revision: 0, status: 'draft',
              steps: params.steps.map(step => ({ ...step, status: 'pending' })) }; result = { plan: state.plan }; break;
          case 'planning.submit': {
            version(state.plan, params.expected_revision);
            state.plan = { ...state.plan, status: 'awaiting_approval', revision: state.plan.revision + 1 };
            state.approval = deferred();
            await emit('interaction/request', { id: 'approve-plan', revision: state.seq + 1,
              title: '批准计划：离线核验', message: '检查资料，然后完成结果。', default: 'deny',
              items: [{ label: '批准当前计划', value: 'allow' }, { label: '拒绝', value: 'deny' }] });
            const decision = await state.approval.promise;
            if (state.plan.status === 'awaiting_approval') state.plan = { ...state.plan,
              status: decision === 'allow' ? 'approved' : 'rejected', revision: state.plan.revision + 1 };
            result = { plan: state.plan }; break;
          }
          case 'interaction.resolve':
            assert.equal(params.id, 'approve-plan');
            state.approval.resolve(params.decision);
            await emit('interaction/resolved', { id: 'approve-plan', decision: params.decision, revision: state.seq + 1 });
            result = { resolved: true }; break;
          case 'planning.start': case 'planning.pause': case 'planning.resume':
            version(state.plan, params.expected_revision);
            state.plan = { ...state.plan, revision: state.plan.revision + 1,
              status: { 'planning.start': 'executing', 'planning.pause': 'paused', 'planning.resume': 'draft' }[method] };
            result = { plan: state.plan }; break;
          case 'planning.step':
            version(state.plan, params.expected_revision);
            state.plan = { ...state.plan, revision: state.plan.revision + 1,
              steps: state.plan.steps.map(step => step.id === params.step_id ? { ...step, status: params.status } : step) };
            result = { plan: state.plan }; break;
          case 'planning.exit':
            version(state.plan, params.expected_revision); state.plan = null; result = { plan: null }; break;
          case 'workflow.define': {
            const definition = { ...params, revision: 0 };
            state.definitions[params.id] = definition; result = definition; break;
          }
          case 'workflow.run': {
            const definition = state.definitions[params.id]; version(definition, params.expected_revision);
            result = { ...definition, id: 'run-1', status: 'running', revision: 0,
              nodes: definition.nodes.map((node, index) => ({ ...node, status: index ? 'pending' : 'running' })) };
            state.runs[result.id] = result; break;
          }
          case 'workflow.cancel': {
            const run = state.runs[params.run_id]; version(run, params.expected_revision);
            result = { ...run, status: 'cancelled', revision: run.revision + 1,
              nodes: run.nodes.map(node => ({ ...node, status: 'cancelled' })) };
            state.runs[params.run_id] = result; break;
          }
          case 'team.create': result = { ...params, status: 'todo', revision: 0 }; state.tasks[params.id] = result; break;
          case 'team.claim': {
            const task = state.tasks[params.id]; version(task, params.expected_revision);
            assert.ok(task.depends_on.every(id => state.tasks[id].status === 'completed'));
            result = { ...task, status: 'claimed', assignee: session.id, revision: task.revision + 1 };
            state.tasks[params.id] = result; break;
          }
          case 'team.complete': {
            const task = state.tasks[params.id]; version(task, params.expected_revision);
            result = { ...task, status: 'completed', result: params.result, revision: task.revision + 1 };
            state.tasks[params.id] = result; break;
          }
          case 'team.ack': state.mail = state.mail.filter(message => !params.message_ids.includes(message.id)); result = { acknowledged: true }; break;
          case 'team.send': assert.equal(params.recipient, 'child-1'); result = { sent: true }; break;
          default: throw new Error(`Unmocked RPC ${method}`);
        }
      } else throw new Error(`Unmocked API ${path}`);
      await route.fulfill({ json: { ok: true, result: copy(result) } });
    } catch (error) {
      errors.push(error.stack || error.message);
      await route.fulfill({ status: 500, json: { ok: false, error: { message: error.message } } });
    }
  });
  await page.goto(base);
  await page.locator('.session-header-title button').waitFor();
  await page.getByRole('button', { name: '添加附件与工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '计划与协作', exact: true }).click();
  await page.getByRole('region', { name: '计划与协作', exact: true }).waitFor();
  return { page, state };
}

async function noOverflow(page, context) {
  await settle(page);
  const measurements = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth,
    panel: [...document.querySelectorAll('.orchestration-panel, .orchestration-card, .orchestration-form, .orchestration-panel fieldset')]
      .filter(element => element.getBoundingClientRect().height > 0)
      .map(element => ({ cls: element.className, width: element.clientWidth, scroll: element.scrollWidth })) }));
  assert.ok(measurements.page <= measurements.viewport, `${context}: ${JSON.stringify(measurements)}`);
  assert.ok(measurements.panel.every(element => element.scroll <= element.width + 1), `${context}: ${JSON.stringify(measurements)}`);
}

try {
  const { page, state } = await fixture();
  const panel = page.getByRole('region', { name: '计划与协作', exact: true });
  await panel.getByLabel('计划名称').fill('离线核验');
  await panel.getByLabel('步骤，每行一项').fill('检查资料\n整理结果');
  await panel.getByRole('button', { name: '创建计划', exact: true }).click();
  await panel.getByRole('button', { name: '提交批准', exact: true }).waitFor();
  await panel.getByRole('button', { name: '提交批准', exact: true }).click();
  const approval = page.getByRole('region', { name: '待确认操作', exact: true }).filter({ hasText: '批准计划：离线核验' });
  await approval.waitFor();
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 840 }); await settle(page);
    const box = await approval.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 840, JSON.stringify(box));
  }
  // Moving between the task context and composer must not dismiss or resolve approval.
  await page.getByRole('button', { name: '关闭工作台', exact: true }).click();
  assert.equal(await page.locator('.composer .approval-panel').count(), 1);
  await page.getByRole('button', { name: '添加附件与工具', exact: true }).click();
  await page.getByRole('menuitem', { name: '计划与协作', exact: true }).click();
  assert.equal(await page.locator('.workbench-approval .approval-panel').count(), 1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(state.plan.status, 'awaiting_approval');
  assert.equal(await approval.getByRole('button', { name: '本会话允许', exact: true }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: '开始执行', exact: true }).count(), 0);
  await approval.getByRole('button', { name: /仅允许一次|批准当前计划/ }).click();
  await panel.getByRole('button', { name: '开始执行', exact: true }).click();
  await panel.getByRole('button', { name: '开始步骤', exact: true }).first().click();
  await panel.getByText('进行中', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '暂停', exact: true }).click();
  await panel.getByText('已暂停', { exact: true }).waitFor();
  assert.equal(state.plan.steps[0].status, 'in_progress');
  await panel.getByRole('button', { name: '工作流', exact: true }).click();
  await panel.getByText('当前计划尚未进入执行状态，工作流启动已锁定。', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '计划', exact: true }).click();
  await panel.getByRole('button', { name: '恢复草稿', exact: true }).click();
  await panel.getByText('草稿', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: '开始执行', exact: true }).count(), 0);
  for (const width of [320, 375, 414, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await noOverflow(page, `plan:${width}`);
  }
  await panel.getByRole('button', { name: '退出计划模式', exact: true }).click();
  await panel.getByRole('button', { name: '创建计划', exact: true }).waitFor();
  await panel.getByRole('button', { name: '工作流', exact: true }).click();
  await panel.getByText('创建工作流', { exact: true }).click();
  await panel.getByLabel('工作流名称').fill('证据依赖工作流');
  await panel.getByLabel('执行方式').selectOption('dag');
  await panel.getByLabel('任务描述', { exact: true }).fill('读取原始证据');
  await panel.getByRole('button', { name: '添加步骤', exact: true }).click();
  await panel.getByRole('group', { name: '步骤 2', exact: true }).getByRole('textbox').fill('检查证据的一致性');
  await panel.getByRole('group', { name: '步骤 2', exact: true }).getByRole('listbox').selectOption('node1');
  await panel.getByLabel('同时运行数量').fill('2');
  await panel.getByRole('button', { name: '保存工作流', exact: true }).click();
  await panel.getByRole('button', { name: '运行工作流', exact: true }).waitFor();
  const definition = Object.values(state.definitions)[0];
  assert.equal(definition.kind, 'dag'); assert.deepEqual(definition.nodes[1].depends_on, ['node1']);
  await panel.getByRole('button', { name: '运行工作流', exact: true }).click();
  await panel.getByRole('button', { name: '取消运行', exact: true }).waitFor();
  for (const width of [320, 375, 414, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await noOverflow(page, `workflow:${width}`);
  }
  await panel.getByRole('button', { name: '取消运行', exact: true }).click();
  await panel.getByRole('button', { name: '移除运行记录', exact: true }).waitFor();
  await panel.getByRole('button', { name: /^团队/ }).click();
  await panel.getByLabel('新增任务').fill('资料核对');
  await panel.getByRole('button', { name: '添加任务', exact: true }).click();
  const baseTask = panel.locator('article').filter({ has: page.getByRole('heading', { name: /^资料核对/ }) });
  await baseTask.getByRole('button', { name: '当前会话领取', exact: true }).waitFor();
  await panel.getByLabel('新增任务').fill('整理结论');
  await panel.getByLabel('前置任务').selectOption(Object.keys(state.tasks)[0]);
  await panel.getByRole('button', { name: '添加任务', exact: true }).click();
  const dependent = panel.locator('article').filter({ has: page.getByRole('heading', { name: /^整理结论/ }) });
  await dependent.waitFor();
  assert.ok(await dependent.getByRole('button', { name: '当前会话领取', exact: true }).isDisabled());
  await baseTask.getByRole('button', { name: '当前会话领取', exact: true }).click();
  await baseTask.getByLabel('结果说明').fill('来源与时间均已核对');
  await baseTask.getByRole('button', { name: '确认完成', exact: true }).click();
  await baseTask.getByText('已完成', { exact: true }).waitFor();
  await dependent.getByRole('button', { name: '当前会话领取', exact: true }).click();
  await dependent.getByText('已领取', { exact: true }).waitFor();
  await panel.getByText('资料核对完成，请检查来源。', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '确认收到', exact: true }).click();
  await panel.getByText('没有未读消息', { exact: true }).waitFor();
  await panel.getByLabel(/^收件人/).selectOption('child-1');
  await panel.getByLabel('消息', { exact: true }).fill('收到，我会检查后整理结果。');
  await panel.getByRole('button', { name: '发送到成员邮箱', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.orchestration-panel button[type="submit"]:disabled'));
  assert.ok(state.calls.some(call => call.method === 'team.send' && call.params.message === '收到，我会检查后整理结果。'));
  for (const width of [320, 375, 414, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await noOverflow(page, `team:${width}`);
    if (process.env.QI_AGENT_ORCHESTRATION_SCREENSHOTS && [375, 1440].includes(width)) {
      await panel.evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: `/tmp/qi-harness-orchestration-${width}.png`, fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  assert.ok(!state.calls.some(call => /turn.submit|subagent.spawn/.test(call.method)));
  console.log(JSON.stringify({ orchestration: 'passed', cases: ['revisioned plan approval with pending RPC', 'execute and pause',
    'resume requires approval', 'DAG dependencies', 'cancel run', 'dependent task claim and completion', 'private mailbox acknowledgement and send'],
  noHorizontalOverflow: [320, 375, 414, 768, 1440], realProviderCalls: 0 }));
  await page.close();
} finally { await browser.close(); }
