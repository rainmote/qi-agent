import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildInvocation, normalizeTranscript } from '../lib/adapters.mjs';

const workspace = path.resolve('/tmp/qi eval workspace');
const runDir = path.resolve('/tmp/qi eval run');
const config = {
  qi: { source_root: path.resolve('/tmp/qi source'), profile_path: path.resolve('/tmp/eval.edn'), provider: 'pinned-provider' },
  codex: { model: 'pinned-model', reasoning_effort: 'high' },
  claude: { model: 'pinned-claude', max_budget_usd: 1.25 },
};
const plan = (agent, overrides = {}) => buildInvocation({ agent, workspace, runDir, config, prompt: 'Fix the bug.', ...overrides });
const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join('\n');

test('qi invocation selects actual module entrypoint and explicit provider without a shell', () => {
  const invocation = plan('qi', { prompt: 'Fix `x`; $(do-not-run)\nThen test.' });
  assert.equal(invocation.command, 'bb');
  assert.deepEqual(invocation.args, ['--classpath',
    [path.join(config.qi.source_root, 'src'), path.join(config.qi.source_root, 'plugins')].join(path.delimiter),
    '-m', 'qi.cli', '--config', config.qi.profile_path, '--provider', 'pinned-provider', '--mode', 'json', '--once',
    'Fix `x`; $(do-not-run)\nThen test.']);
  assert.equal(invocation.env, undefined);
});

test('Codex uses explicit model/effort and workspace-write without bypass flags', () => {
  const invocation = plan('codex', { prompt: '--help is part of this task' });
  assert.equal(invocation.command, 'codex');
  assert.deepEqual(invocation.args, ['exec', '--json', '-m', 'pinned-model', '-c', 'model_reasoning_effort="high"',
    '--sandbox', 'workspace-write', '-C', workspace, '-o', path.join(runDir, 'final.txt'), '--', '--help is part of this task']);
  assert.ok(!invocation.args.some((arg) => arg.includes('bypass')));
});

test('Claude emits structured output with an optional explicit spend limit', () => {
  assert.deepEqual(plan('claude'), { command: 'claude', args: ['-p', '--output-format', 'json', '--model', 'pinned-claude',
    '--max-budget-usd', '1.25', '--', 'Fix the bug.'] });
  const noBudget = plan('claude', { config: { claude: { command: '/opt/Claude Code/claude', model: 'pinned-claude' } } });
  assert.equal(noBudget.command, '/opt/Claude Code/claude');
  assert.ok(!noBudget.args.includes('--max-budget-usd'));
});

test('plans reject missing identities, malformed options and ambiguous paths', () => {
  for (const agent of ['qi', 'codex', 'claude']) assert.throws(() => plan(agent, { config: {} }));
  assert.throws(() => plan('codex', { config: { codex: { model: 'pinned-model' } } }), /reasoning_effort/u);
  assert.throws(() => plan('claude', { config: { claude: { model: '--dangerously-skip-permissions' } } }), /identifier/u);
  for (const model of ['REPLACE_WITH_EXPLICIT_MODEL', 'your-model', 'provider/REPLACE_WITH_MODEL', 'placeholder']) {
    assert.throws(() => plan('claude', { config: { claude: { model } } }), /placeholder/u);
  }
  assert.throws(() => plan('qi', { config: { qi: { ...config.qi, provider: '' } } }), /provider/u);
  assert.throws(() => plan('qi', { config: { qi: { ...config.qi, source_root: `/tmp/a${path.delimiter}b` } } }), /delimiter/u);
  for (const max_budget_usd of [0, -1, Infinity, NaN, '1']) {
    assert.throws(() => plan('claude', { config: { claude: { model: 'pinned-claude', max_budget_usd } } }), /budget/u);
  }
  assert.throws(() => plan('codex', { workspace: 'relative' }), /absolute/u);
  assert.throws(() => plan('qi', { prompt: '\0' }), /prompt/u);
  assert.throws(() => plan('mock'), /Unsupported agent/u);
});

test('empty or missing usage stays unknown rather than becoming zero', () => {
  for (const agent of ['qi', 'codex', 'claude']) {
    const result = normalizeTranscript(agent, '');
    assert.equal(result.status, 'unknown');
    assert.equal(result.reported_usage, null);
    assert.equal(result.cost_usd, null);
    assert.equal(result.cost_complete, false);
    assert.equal(result.parse_errors, 0);
  }
  assert.equal(normalizeTranscript('qi', jsonl({ type: 'result', ok: true, result: { usage: {} } })).reported_usage, null);
  assert.equal(normalizeTranscript('claude', jsonl({ type: 'result', is_error: false })).status, 'completed');
});

test('qi uses only the parent final usage, preserving incomplete accounting', () => {
  const result = normalizeTranscript('qi', jsonl(
    { type: 'event', event: 'subagent/end', data: { usage: { input_tokens: 80 } } },
    { type: 'result', agent_id: 'child', ok: true, result: { content: 'child', usage: { input_tokens: 80 } } },
    { type: 'result', ok: true, result: { content: 'Done, awaiting grading.', usage: { input_tokens: 20, output_tokens: 5 } } },
  ));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.reported_usage, { input_tokens: 20, output_tokens: 5 });
  assert.equal(result.final_text, 'Done, awaiting grading.');
  assert.equal(result.cost_complete, false);
  assert.match(result.notes.join(' '), /incomplete.*child.*compaction/u);
  assert.equal(Object.hasOwn(result, 'passed'), false);
});

test('qi failure and cancellation are not a successful execution', () => {
  assert.equal(normalizeTranscript('qi', jsonl({ type: 'result', ok: false, error: { message: 'limit' } })).status, 'failed');
  assert.equal(normalizeTranscript('qi', jsonl({ type: 'result', ok: true, result: { cancelled: true } })).status, 'failed');
  assert.equal(normalizeTranscript('qi', jsonl({ type: 'event', event: 'agent/aborted' })).status, 'failed');
  assert.equal(normalizeTranscript('qi', jsonl({ type: 'event', event: 'tool.execution/end', data: { ok: false } })).status, 'unknown');
});

test('Codex aggregates top-level turn counters without adding cached or nested subsets to total', () => {
  const result = normalizeTranscript('codex', jsonl(
    { type: 'thread.started', thread_id: 'root' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'First', usage: { input_tokens: 900 } } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 10 } } },
    { type: 'turn.completed', thread_id: 'child', usage: { input_tokens: 800 } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 5 } } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Final' } },
  ));
  assert.deepEqual(result.reported_usage, { input_tokens: 200, cached_input_tokens: 160, output_tokens: 40,
    output_tokens_details: { reasoning_tokens: 15 } });
  assert.equal(result.final_text, 'Final');
  assert.equal(result.status, 'completed');
  assert.equal(result.cost_usd, null);
  assert.match(result.notes.join(' '), /Non-root/u);
});

test('Codex deduplicates identified turns and marks missing usage as partial', () => {
  const result = normalizeTranscript('codex', jsonl(
    { type: 'turn.completed', turn_id: 'one', usage: { input_tokens: 4 } },
    { type: 'turn.completed', turn_id: 'one', usage: { input_tokens: 5 } },
    { type: 'turn.completed' },
  ));
  assert.deepEqual(result.reported_usage, { input_tokens: 5 });
  assert.match(result.notes.join(' '), /Duplicate.*partial/u);
});

test('Codex preserves failure and an unfinished later turn overrides earlier completion', () => {
  const completed = { type: 'turn.completed', usage: { input_tokens: 8 } };
  assert.equal(normalizeTranscript('codex', jsonl(completed, { type: 'turn.failed', error: { message: 'network' } })).status, 'failed');
  assert.equal(normalizeTranscript('codex', jsonl(completed, { type: 'turn.started' })).status, 'unknown');
  assert.equal(normalizeTranscript('codex', jsonl({ type: 'error', message: 'retry' }, completed)).status, 'completed');
});

test('Claude parses pretty JSON and treats cost as an estimate without double counting', () => {
  const result = normalizeTranscript('claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: 'Done', usage: { input_tokens: 100, output_tokens: 15, cache_read_input_tokens: 80 },
    modelUsage: { 'pinned-claude': { inputTokens: 100, outputTokens: 15, costUSD: 0.02 } },
    total_cost_usd: 0.02,
  }, null, 2));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.reported_usage, { input_tokens: 100, output_tokens: 15, cache_read_input_tokens: 80 });
  assert.equal(result.cost_usd, 0.02);
  assert.equal(result.cost_complete, false);
  assert.match(result.notes.join(' '), /client-side estimate/u);
  assert.equal(result.parse_errors, 0);
});

test('Claude error results retain reported cost and usage; missing cost never becomes zero', () => {
  const result = normalizeTranscript('claude', jsonl({ type: 'result', subtype: 'error_max_turns', is_error: true,
    usage: { output_tokens: 2 }, total_cost_usd: 0.01, permission_denials: [{ tool_name: 'Bash' }] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.cost_usd, 0.01);
  assert.deepEqual(result.reported_usage, { output_tokens: 2 });
  assert.match(result.notes.join(' '), /permission denial/u);
  assert.equal(normalizeTranscript('claude', jsonl({ type: 'result', subtype: 'success' })).cost_usd, null);
  assert.equal(normalizeTranscript('claude', jsonl({ type: 'result', subtype: 'success', total_cost_usd: 0 })).cost_usd, 0);
});

test('malformed JSONL retains good records and counts non-object JSON separately', () => {
  const result = normalizeTranscript('codex', [
    '{broken', 'null', '17', 'log message', '',
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3 } }), '{"type":',
  ].join('\n'));
  assert.equal(result.parse_errors, 5);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.reported_usage, { input_tokens: 3 });
  assert.match(result.notes.join(' '), /raw transcript/u);
});

test('non-numeric or invalid counters are not accepted as measured values', () => {
  const result = normalizeTranscript('qi', jsonl({ type: 'result', ok: true,
    result: { usage: { input_tokens: '100', output_tokens: -1, total_tokens: null, details: {}, zero: 0 } } }));
  assert.deepEqual(result.reported_usage, { zero: 0 });
  assert.equal(normalizeTranscript('claude', jsonl({ type: 'result', is_error: false, total_cost_usd: '1.2' })).cost_usd, null);
  assert.throws(() => normalizeTranscript('unknown', ''), /Unsupported/u);
  assert.throws(() => normalizeTranscript('qi', null), /string/u);
});

test('Claude JSON arrays and BOM input are accepted without counting child final messages', () => {
  const result = normalizeTranscript('claude', '\uFEFF' + JSON.stringify([
    { type: 'result', is_error: false, result: 'parent' },
    { type: 'result', parent_tool_use_id: 'child', is_error: true, result: 'child' },
  ]));
  assert.equal(result.status, 'completed');
  assert.equal(result.final_text, 'parent');
  assert.equal(result.parse_errors, 0);
});

test('untrusted accounting keys remain own fields and never become object prototypes', () => {
  const result = normalizeTranscript('codex', [
    '{"type":"turn.completed","usage":{"__proto__":{"input_tokens":1},"input_tokens":2}}',
    '{"type":"turn.completed","usage":{"__proto__":{"input_tokens":3},"input_tokens":4}}',
  ].join('\n'));
  assert.equal(Object.getPrototypeOf(result.reported_usage), Object.prototype);
  assert.equal(Object.hasOwn(result.reported_usage, '__proto__'), true);
  assert.equal(result.reported_usage.__proto__.input_tokens, 4);
  assert.equal(result.reported_usage.input_tokens, 6);
  assert.equal(Object.prototype.input_tokens, undefined);
});
