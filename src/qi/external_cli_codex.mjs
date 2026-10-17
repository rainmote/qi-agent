// Decoder for documented exec JSONL and explicitly attributed observed failures.
export const CODEX_PROTOCOL = 'codex-exec-jsonl-v1';
export const CODEX_VERSION = '0.157.1';
export const codexDescriptor = Object.freeze({ provider: 'codex', protocol: CODEX_PROTOCOL,
  cli_version: CODEX_VERSION, multi_turn: false, persona: false, tool_filter: false,
  output_schema: false, approvals: false, sandbox: 'read-only', max_depth: 1 });

const itemTypes = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change',
  'mcp_tool_call', 'web_search', 'todo_list', 'error']);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const detail = value => {
  const message = typeof value === 'string' ? value : value?.message;
  if (typeof message !== 'string' || !message.trim()) throw new Error('Invalid Codex diagnostic');
  return message.slice(0, 2048);
};
const failureReason = message => {
  // Do not classify arbitrary prose as a provider code. The observed CLI wraps
  // the structured provider rejection in a JSON string.
  try {
    const error = JSON.parse(message).error;
    if (error?.type === 'invalid_request_error' && typeof error.message === 'string' &&
        /model is not supported|model.*not available/iu.test(error.message)) return 'codex-model-unavailable';
  } catch { /* Unstructured reasons remain the generic failure. */ }
  return 'codex-turn-failed';
};

export function codexDecoder() {
  let thread, started = false, terminal, pendingError, progressCount = 0, unknownTruncated = false;
  const messages = new Map(), progress = [], unknown = new Set(), unknownItems = new Set();
  const diagnostics = [];
  const diagnose = (message, source) => {
    diagnostics.push({ source, message });
    if (diagnostics.length > 32) diagnostics.shift();
  };
  const remember = (set, type) => {
    if (set.size < 32 && type.length <= 128) set.add(type); else unknownTruncated = true;
  };
  const accept = event => {
    if (!text(event.type)) throw new Error('Missing Codex event type');
    switch (event.type) {
      case 'thread.started':
        if (thread || started || terminal || !text(event.thread_id)) throw new Error('Invalid Codex thread');
        thread = event.thread_id; break;
      case 'turn.started':
        if (!thread || started || terminal) throw new Error('Invalid Codex turn start');
        started = true; break;
      case 'item.started': case 'item.updated': case 'item.completed': {
        const item = event.item;
        if (terminal || !item || !text(item.id) || !text(item.type)) throw new Error('Invalid Codex item');
        const diagnostic = event.type === 'item.completed' && item.type === 'error';
        if (!started && !(thread && diagnostic)) throw new Error('Invalid Codex item');
        if (diagnostic) diagnose(detail(item.message), 'item');
        if (!itemTypes.has(item.type)) remember(unknownItems, item.type);
        progress.push({ event_type: event.type, item_id: item.id, item_type: item.type,
          status: typeof item.status === 'string' ? item.status.slice(0, 128) : null });
        if (progress.length > 32) progress.shift(); progressCount++;
        if (event.type === 'item.completed' && item.type === 'agent_message') {
          if (messages.has(item.id) || typeof item.text !== 'string') throw new Error('Invalid Codex answer');
          messages.set(item.id, item.text);
        }
        break;
      }
      case 'turn.completed': case 'turn.failed': case 'turn.interrupted': case 'turn.cancelled': {
        if (!started || terminal) throw new Error('Invalid or duplicate Codex terminal');
        const usage = {};
        for (const key of ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens']) {
          const value = event.usage?.[key];
          if (value !== undefined) {
            if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Codex usage');
            usage[key] = value;
          }
        }
        if (usage.cached_input_tokens !== undefined && usage.input_tokens !== undefined &&
            usage.cached_input_tokens > usage.input_tokens) throw new Error('Invalid Codex cached subset');
        const completed = event.type === 'turn.completed';
        if (completed && (!messages.size || pendingError)) throw new Error('Completed Codex turn has no answer or has an unresolved error');
        const failureDetail = event.type === 'turn.failed' ?
          (event.error === undefined ? pendingError : detail(event.error)) : undefined;
        terminal = { status: completed ? 'completed' : event.type === 'turn.failed' ? 'failed' : 'cancelled',
          reason: completed ? 'completed' : event.type === 'turn.failed' ? failureReason(failureDetail) : 'codex-interrupted',
          output: [...messages.values()].join('\n\n'), usage,
          ...(failureDetail ? { detail: failureDetail } : {}) };
        break;
      }
      case 'error':
        if (terminal) throw new Error('Error after Codex terminal');
        pendingError = detail(event.message ?? event.error);
        diagnose(pendingError, 'error'); break;
      default: remember(unknown, event.type);
    }
    return terminal;
  };
  return { accept, finish: () => terminal ?? (pendingError ?
    { status: 'failed', reason: 'codex-error', detail: pendingError, output: '', usage: {} } : undefined),
    metadata: () => ({ thread_id: thread ?? null, progress, diagnostics,
    progress_count: progressCount, unknown_event_types: [...unknown], unknown_item_types: [...unknownItems],
    unknown_types_truncated: unknownTruncated, usage_scope: 'external-turn-reported',
    external_descriptor: codexDescriptor }) };
}
