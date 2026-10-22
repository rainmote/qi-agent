// Deliberately fake LCU client for offline qì boundary tests, not desktop E2E.
import { appendFileSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
const record = value => appendFileSync(new URL('../events.jsonl', import.meta.url), `${JSON.stringify(value)}\n`);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
export const nativeAppApprovalOptions = params => params?._meta?.connector_id === 'computer-use'
  && params?._meta?.tool_params?.app && params.mode === 'form'
  ? { message: params.message, resource: params._meta.tool_params.app,
    choices: [{ value: 'once', label: 'Allow once' }, { value: 'session', label: 'Allow session' },
      { value: 'always', label: 'Always' }, { value: 'decline', label: 'Decline' }] } : undefined;
export const nativeAppApprovalResponse = (_params, choice) => choice === 'session'
  ? { action: 'accept', content: {}, _meta: { persist: 'session' } }
  : choice === 'once' ? { action: 'accept', content: {} }
    : { action: choice === 'decline' ? 'decline' : 'cancel' };
export function createCuaClient({ onElicitation, env, allowedOrigins }) {
  let failCleanup = false;
  const runtimeRoot = env?.CODEX_HOME;
  if (runtimeRoot && !basename(runtimeRoot).startsWith('qi-lcu-browser-')) throw new Error('Fixture refuses an unowned runtime root');
  const grantsPath = runtimeRoot && join(runtimeRoot, 'fixture-origin-grants.json');
  const grants = () => grantsPath && existsSync(grantsPath) ? JSON.parse(readFileSync(grantsPath, 'utf8')) : [];
  return {
    async connect() { record({ event: 'connect', pid: process.pid, surfaces: process.env.CUA_REPL_ENABLED_SURFACES,
      audio: process.env.SKY_ENABLE_AUDIO, replAudio: process.env.NODE_REPL_ENABLE_AUDIO,
      runtimeRoot, mode: runtimeRoot && (statSync(runtimeRoot).mode & 0o777), allowedOrigins });
      if (existsSync(new URL('../fail-connect', import.meta.url))) throw new Error('Fixture connect failure');
      if (existsSync(new URL('../idle-exit', import.meta.url))) setTimeout(() => process.exit(0), 100); },
    get instructions() { return existsSync(new URL('../blank-instructions', import.meta.url)) ? '' : 'ORIGINAL LCU INSTRUCTIONS: observe before input.'; },
    publicTools: () => ['js', 'js_reset'].map(name => ({ name, description: `Original ${name}`,
      inputSchema: { type: 'object', properties: { code: { type: 'string' } } } })),
    async call(name, args, identity) {
      record({ event: 'call', name, args, sessionId: identity.sessionId,
        turnId: identity.turnId, toolCallId: identity.toolCallId });
      if (args.code === 'approve') {
        const result = await onElicitation({ mode: 'form', message: 'Original app approval text',
          requestedSchema: { type: 'object', properties: {} },
          _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use',
            tool_name: 'get_app_state', tool_params: { app: 'qi.test' }, persist: ['session', 'always'] } },
          { signal: identity.signal });
        record({ event: 'approval', result });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.action !== 'accept' };
      }
      if (args.code.startsWith('browser:')) {
        const params = JSON.parse(args.code.slice(8));
        const origin = (params._meta ?? params.meta)?.origin;
        const key = `${identity.sessionId}:${origin}`;
        const saved = grants();
        const result = saved.includes(key) ? { action: 'accept', content: {} }
          : await onElicitation(params, { signal: identity.signal });
        record({ event: 'browser-approval', origin, result, cached: saved.includes(key) });
        const accepted = result.action === 'accept' && !identity.signal.aborted;
        if (accepted) {
          if (grantsPath) writeFileSync(grantsPath, JSON.stringify([...new Set([...saved, key])]));
          record({ event: 'browser-action', origin, sessionId: identity.sessionId, turnId: identity.turnId });
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !accepted };
      }
      if (args.code === 'cleanup-fail') failCleanup = true;
      if (args.code === 'throw') throw new Error('Fixture reply lost after input');
      if (args.code === 'hang') await new Promise(resolve => identity.signal.addEventListener('abort', resolve));
      return { content: [{ type: 'text', text: 'Observed fixture' },
        { type: 'image', mimeType: 'image/png', data: png }], isError: args.code === 'error' };
    },
    async turnEnded(identity) {
      record({ ...identity, event: 'turn-end', hook: identity.event });
      if (failCleanup) throw new Error('Fixture cleanup failed');
      return { content: [] };
    },
    async close() { record({ event: 'close' }); },
  };
}
