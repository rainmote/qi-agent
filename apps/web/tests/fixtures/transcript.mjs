// Synthetic protocol fixture derived from the 2026-11-14 Magpie/Harness
// comparison. No private snapshot, local paths, provider or credentials needed.
export const progress = '已读取三个输入文件，接下来计算并校验汇总。';
export const answer = '售出 A 5 件、B 4 件；剩余 A 5 件、B 4 件；收入 94.5。校验输出 VERIFIED。';

export function transcript({ failure = false, extraCalls = 0, active = false } = {}) {
  const events = [];
  const emit = (type, data) => {
    const seq = events.length + 1;
    const event = { id: `ui-${seq}`, seq, at: '2026-11-14T00:00:00Z', type, data };
    events.push(event);
    return event;
  };
  const message = (role, content) => emit('message', { message: { role, content } });
  let step = 0;
  const call = (name, args, content, exit = 0) => {
    step++;
    const id = `call-${step}`;
    emit('step/start', { step });
    const assistant = emit('message', { message: { role: 'assistant', content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    'tool-dispatch-version': 1, step });
    const identity = { 'call-id': id, 'assistant-event-id': assistant.id, name, step };
    emit('tool/call', { ...identity, arguments: args });
    emit('tool/start', { ...identity, 'execution-id': `execution-${step}` });
    emit('tool/result', { ...identity, ok: true, status: exit ? 'error' : 'success',
      'is-error': exit !== 0, content, details: name === 'bash' ? { 'exit-code': exit } : { path: args.path } });
    // Native workers also persist a tool message. It must not duplicate the row.
    emit('message', { ...identity, message: { role: 'tool', tool_call_id: id, content } });
    emit('step/end', { step, 'tool-count': 1 });
  };
  message('user', '依次读取库存、订单、价格；列出文件，计算汇总，再读取并校验结果。');
  emit('agent/run/start', { 'run-id': 'ui-run' });
  call('read', { path: 'inventory.csv' }, 'sku,stock\nA,10\nB,8');
  call('read', { path: 'orders.csv' }, 'sku,quantity\nA,5\nB,4');
  call('read', { path: 'prices.json' }, '{"A":10.5,"B":10.5}');
  call('bash', { command: 'ls inventory.csv orders.csv prices.json' }, 'exit 0\nstdout:\ninventory.csv orders.csv prices.json');
  message('assistant', progress);
  if (failure) call('bash', { command: 'python calculate.py' }, 'exit 127\nstderr:\npython: command not found', 127);
  call('bash', { command: 'python3 calculate.py' }, 'exit 0\nstdout:\nsummary.json written');
  for (let i = 0; i < extraCalls; i++) call('read', { path: `extra-${i}.csv` }, `extra row ${i}`);
  call('read', { path: 'summary.json' }, '{"sold":{"A":5,"B":4},"remaining":{"A":5,"B":4},"revenue":94.5}');
  call('bash', { command: 'python3 verify.py' }, 'exit 0\nstdout:\nVERIFIED\nstderr:\nwarning: optional cache unavailable');
  if (active) {
    // Last call is still running, after six completed calls and a progress reply.
    events.splice(events.findLastIndex(event => event.type === 'tool/start') + 1);
  } else {
    emit('step/start', { step: step + 1 });
    message('assistant', answer);
    emit('step/end', { step: step + 1, 'tool-count': 0 });
    emit('agent/run/end', { 'run-id': 'ui-run', status: 'completed', verification: 'not-run' });
  }
  return events;
}
