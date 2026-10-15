// Decoder for the documented exec JSONL stream; replay fixtures are not live evidence.
export const CODEX_PROTOCOL = 'codex-exec-jsonl-v1';
export const CODEX_VERSION = '0.157.1';
export const codexDescriptor = Object.freeze({ provider: 'codex', protocol: CODEX_PROTOCOL,
  cli_version: CODEX_VERSION, multi_turn: false, persona: false, tool_filter: false,
  output_schema: false, approvals: false, sandbox: 'read-only', max_depth: 1 });

const itemTypes = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change',
  'mcp_tool_call', 'web_search', 'todo_list']);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

export function codexDecoder() {
  let thread, started = false, terminal, progressCount = 0, unknownTruncated = false;
  const messages = new Map(), progress = [], unknown = new Set(), unknownItems = new Set();
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
        if (!started || terminal || !item || !text(item.id) || !text(item.type)) throw new Error('Invalid Codex item');
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
        if (completed && !messages.size) throw new Error('Completed Codex turn has no answer');
        terminal = { status: completed ? 'completed' : event.type === 'turn.failed' ? 'failed' : 'cancelled',
          reason: completed ? 'completed' : event.type === 'turn.failed' ? 'codex-turn-failed' : 'codex-interrupted',
          output: [...messages.values()].join('\n\n'), usage };
        break;
      }
      case 'error':
        if (terminal) throw new Error('Error after Codex terminal');
        terminal = { status: 'failed', reason: 'codex-error', output: '', usage: {} }; break;
      default: remember(unknown, event.type);
    }
    return terminal;
  };
  return { accept, metadata: () => ({ thread_id: thread ?? null, progress,
    progress_count: progressCount, unknown_event_types: [...unknown], unknown_item_types: [...unknownItems],
    unknown_types_truncated: unknownTruncated, usage_scope: 'external-turn-reported',
    external_descriptor: codexDescriptor }) };
}
