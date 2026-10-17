// Deliberately fake LCU client for offline qì boundary tests, not desktop E2E.
import { appendFileSync } from 'node:fs';
const record = value => appendFileSync(new URL('../events.jsonl', import.meta.url), `${JSON.stringify(value)}\n`);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
export const nativeAppApprovalOptions = params => params;
export const nativeAppApprovalResponse = (_params, choice) => ({ choice });
export function createCuaClient({ onElicitation }) {
  let failCleanup = false;
  return {
    async connect() { record({ event: 'connect', pid: process.pid }); },
    instructions: 'ORIGINAL LCU INSTRUCTIONS: observe before input.',
    publicTools: () => ['js', 'js_reset'].map(name => ({ name, description: `Original ${name}`,
      inputSchema: { type: 'object', properties: { code: { type: 'string' } } } })),
    async call(name, args, identity) {
      record({ event: 'call', name, args, sessionId: identity.sessionId,
        turnId: identity.turnId, toolCallId: identity.toolCallId });
      if (args.code === 'approve') {
        const result = await onElicitation({ message: 'Original app approval text', resource: 'qi.test',
          choices: [{ value: 'once', label: 'Allow once' }, { value: 'session', label: 'Allow session' },
            { value: 'always', label: 'Always' }, { value: 'decline', label: 'Decline' }] },
          { signal: identity.signal });
        record({ event: 'approval', result });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.choice !== 'session' };
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
