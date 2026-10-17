import path from 'node:path';

const AGENTS = new Set(['qi', 'codex', 'claude']);

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${name} must be a nonempty single-line string without NUL`);
  }
  return value;
}

function absolutePath(value, name) {
  requiredText(value, name);
  if (!path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return path.normalize(value);
}

function identifier(value, name) {
  requiredText(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(value)) {
    throw new TypeError(`${name} must be an explicit model/provider identifier`);
  }
  if (/(?:^|[/:])(?:REPLACE[_-]|YOUR[_-])|PLACEHOLDER/iu.test(value)) {
    throw new TypeError(`${name} contains a placeholder; supply an explicit model/provider identifier`);
  }
  return value;
}

/** Build an argv-only plan. The caller owns credentials, isolation, cwd and execution. */
export function buildInvocation({ agent, workspace, prompt, config = {}, runDir } = {}) {
  if (!AGENTS.has(agent)) throw new TypeError(`Unsupported agent: ${String(agent)}`);
  const cwd = absolutePath(workspace, 'workspace');
  const output = absolutePath(runDir, 'runDir');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')) {
    throw new TypeError('prompt must be a nonempty string without NUL');
  }
  const settings = config?.[agent];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new TypeError(`config.${agent} is required`);
  }

  if (agent === 'qi') {
    const source = absolutePath(settings.source_root, 'qi.source_root');
    if (source.includes(path.delimiter)) {
      throw new TypeError('qi.source_root must not contain the classpath delimiter');
    }
    const profile = absolutePath(settings.profile_path, 'qi.profile_path');
    const provider = identifier(settings.provider, 'qi.provider');
    return {
      command: requiredText(settings.bb_path ?? 'bb', 'qi.bb_path'),
      args: ['--classpath', [path.join(source, 'src'), path.join(source, 'plugins')].join(path.delimiter),
        '-m', 'qi.cli', '--config', profile, '--provider', provider, '--mode', 'json', '--once', prompt],
    };
  }

  const model = identifier(settings.model, `${agent}.model`);
  const command = requiredText(settings.command ?? agent, `${agent}.command`);
  if (agent === 'codex') {
    const effort = identifier(settings.reasoning_effort, 'codex.reasoning_effort');
    // JSON string quoting is valid for this TOML string value; this is never shell text.
    return {
      command,
      args: ['exec', '--json', '-m', model, '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
        '--sandbox', 'workspace-write', '-C', cwd, '-o', path.join(output, 'final.txt'), '--', prompt],
    };
  }

  const args = ['-p', '--output-format', 'json', '--model', model];
  if (settings.max_budget_usd !== undefined) {
    if (typeof settings.max_budget_usd !== 'number' || !Number.isFinite(settings.max_budget_usd)
        || settings.max_budget_usd <= 0) {
      throw new TypeError('claude.max_budget_usd must be a finite positive number');
    }
    args.push('--max-budget-usd', String(settings.max_budget_usd));
  }
  args.push('--', prompt);
  return { command, args };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteNonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Keep provider-specific accounting fields, including nested cache/reasoning fields,
// without converting subsets into extra tokens or manufacturing absent zero values.
function numericUsage(value) {
  if (!isObject(value)) return null;
  const entries = [];
  for (const [key, child] of Object.entries(value)) {
    if (finiteNonnegative(child)) entries.push([key, child]);
    else if (isObject(child)) {
      const nested = numericUsage(child);
      if (nested) entries.push([key, nested]);
    }
  }
  return entries.length ? Object.fromEntries(entries) : null;
}

function mergeUsage(left, right) {
  if (!right) return left;
  if (!left) return structuredClone(right);
  const entries = new Map(Object.entries(left));
  for (const [key, value] of Object.entries(right)) {
    const previous = entries.get(key);
    if (isObject(value)) {
      if (previous === undefined || isObject(previous)) entries.set(key, mergeUsage(previous, value));
      // A changed schema cannot safely be added; keep only the latest reported field.
      else entries.set(key, structuredClone(value));
    } else entries.set(key, (finiteNonnegative(previous) ? previous : 0) + value);
  }
  return Object.fromEntries(entries);
}

function parseTranscript(text) {
  if (typeof text !== 'string') throw new TypeError('transcript must be a string');
  const trimmed = text.replace(/^\uFEFF/u, '').trim();
  if (!trimmed) return { events: [], parseErrors: 0 };
  const events = [];
  let parseErrors = 0;
  function append(value) {
    if (Array.isArray(value)) {
      for (const item of value) append(item);
    } else if (isObject(value)) events.push(value);
    else parseErrors += 1;
  }
  // Claude's non-streaming JSON may span multiple lines or contain an event array.
  try {
    append(JSON.parse(trimmed));
    return { events, parseErrors };
  } catch { /* Otherwise read independent JSONL events, retaining valid neighbors. */ }
  for (const line of trimmed.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try { append(JSON.parse(line)); } catch { parseErrors += 1; }
  }
  return { events, parseErrors };
}

function rootQiEvent(event) {
  return !event.agent_id && !event.parent_agent_id;
}

function normalizeQi(events, result) {
  let terminal;
  for (const event of events) {
    if (!rootQiEvent(event)) continue;
    if (event.type === 'result') terminal = event;
    if (event.type === 'event' && ['agent/error', 'agent/aborted'].includes(event.event)) {
      result.status = 'failed';
    }
    if (event.type === 'event' && event.event === 'agent.message/end'
        && event.data?.message?.role === 'assistant' && typeof event.data.message.content === 'string') {
      result.final_text = event.data.message.content;
    }
  }
  if (terminal) {
    const payload = terminal.result;
    result.status = terminal.ok === false ? 'failed' : terminal.ok === true ? 'completed' : 'unknown';
    if (payload?.cancelled || payload?.aborted) result.status = 'failed';
    result.reported_usage = numericUsage(payload?.usage);
    if (typeof payload?.content === 'string') result.final_text = payload.content;
    if (payload?.terminated) result.notes.push('qi ended through a terminating tool; this is not task acceptance.');
  } else result.notes.push('No top-level qi result envelope was found.');
  result.notes.push('qi usage is incomplete task accounting: only the parent result is retained; child, compaction, and failed-call costs are not reconstructed.');
}

function normalizeCodex(events, result) {
  let rootThread;
  let ignoredChildren = false;
  let missingTurnUsage = false;
  const turnUsages = [];
  const turnIndexes = new Map();
  for (const event of events) {
    if (!rootThread && event.type === 'thread.started' && !event.parent_thread_id) rootThread = event.thread_id;
    if (event.parent_thread_id || event.parent_agent_id
        || (rootThread && event.thread_id && event.thread_id !== rootThread)) {
      ignoredChildren = true;
      continue;
    }
    if (event.type === 'turn.started') result.status = 'unknown';
    if (event.type === 'turn.failed' || event.type === 'error') result.status = 'failed';
    if (event.type === 'turn.completed') {
      result.status = 'completed';
      const usage = numericUsage(event.usage);
      if (!usage) missingTurnUsage = true;
      // Only deduplicate when the producer supplies an actual turn identity.
      // Distinct turns can legitimately report exactly the same token counts.
      const turnId = event.turn_id;
      if (typeof turnId === 'string' && turnIndexes.has(turnId)) {
        turnUsages[turnIndexes.get(turnId)] = usage;
        result.notes.push('Duplicate completed turn identity found; retained its latest usage report.');
      } else {
        if (typeof turnId === 'string') turnIndexes.set(turnId, turnUsages.length);
        turnUsages.push(usage);
      }
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message'
        && typeof event.item.text === 'string') result.final_text = event.item.text;
  }
  result.reported_usage = turnUsages.reduce(mergeUsage, null);
  if (missingTurnUsage) result.notes.push('At least one completed turn omitted numeric usage; the aggregate is partial.');
  if (ignoredChildren) result.notes.push('Non-root thread events were excluded to avoid mixing or double-counting usage.');
  result.notes.push('Codex usage sums top-level completed turns only; cached/reasoning fields remain separate subsets, and failed or child-call coverage is unverified.');
  result.notes.push('Codex JSONL does not supply verified monetary cost; absent cost is unknown, not zero.');
}

function normalizeClaude(events, result) {
  let terminal;
  for (const event of events) {
    if (event.type === 'result' && !event.parent_tool_use_id) terminal = event;
  }
  if (!terminal) {
    result.notes.push('No top-level Claude result envelope was found.');
    return;
  }
  if (terminal.is_error === true || (typeof terminal.subtype === 'string' && terminal.subtype.startsWith('error'))) {
    result.status = 'failed';
  } else if (terminal.is_error === false || terminal.subtype === 'success') result.status = 'completed';
  result.reported_usage = numericUsage(terminal.usage);
  if (typeof terminal.result === 'string') result.final_text = terminal.result;
  if (finiteNonnegative(terminal.total_cost_usd)) {
    result.cost_usd = terminal.total_cost_usd;
    result.notes.push('Claude total_cost_usd is a client-side estimate, not verified billed spend; continued sessions can include earlier runs.');
  }
  if (Array.isArray(terminal.permission_denials) && terminal.permission_denials.length) {
    result.notes.push(`Claude reported ${terminal.permission_denials.length} permission denial(s); independent grading still determines task success.`);
  }
  result.notes.push('Claude usage comes only from the final result; per-model and nested message usage are not added again.');
}

/** Normalize execution evidence only. A completed agent turn never means the task passed. */
export function normalizeTranscript(agent, text) {
  if (!AGENTS.has(agent)) throw new TypeError(`Unsupported agent: ${String(agent)}`);
  const { events, parseErrors } = parseTranscript(text);
  const result = {
    status: 'unknown',
    reported_usage: null,
    cost_usd: null,
    // True is reserved for a verified full-run cost ledger, which these streams do not provide.
    cost_complete: false,
    final_text: null,
    parse_errors: parseErrors,
    notes: [],
  };
  if (agent === 'qi') normalizeQi(events, result);
  else if (agent === 'codex') normalizeCodex(events, result);
  else normalizeClaude(events, result);
  if (parseErrors) result.notes.push(`${parseErrors} malformed or non-object JSON record(s) could not be normalized; retain the raw transcript.`);
  if (!result.reported_usage) result.notes.push('No numeric usage was reported; missing usage is unknown, not zero.');
  result.notes.push('Execution status is not an acceptance-test result.');
  result.notes = [...new Set(result.notes)];
  return result;
}
