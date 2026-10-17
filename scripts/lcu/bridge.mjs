// qì's stdio boundary around LCU's official shared client. Desktop execution,
// native approval semantics, reset handling and cleanup stay in LCU.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const home = process.argv[2];
if (!home) throw new Error('Usage: bridge.mjs <installed LCU release> [lcu args...]');
const { createCuaClient, nativeAppApprovalOptions, nativeAppApprovalResponse } =
  await import(pathToFileURL(resolve(home, 'adapters/client.mjs')));
const pending = new Map();
const calls = new Map();
let nextId = 0;
let turn;
let cleanupFailed = false;
let stopping = false;
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const cua = createCuaClient({
  command: [resolve(home, 'bin/lcu'), ...process.argv.slice(3)],
  cwd: process.cwd(), adapter: 'qi-agent',
  async onElicitation(params, { signal }) {
    const options = nativeAppApprovalOptions(params);
    if (!options || stopping || signal.aborted) return { action: 'cancel' };
    const id = `approval-${++nextId}`;
    const answer = await new Promise(resolveAnswer => {
      const abort = () => {
        pending.delete(id);
        send({ method: 'notifications/cancelled', params: { requestId: id } });
        resolveAnswer({ choice: 'cancel' });
      };
      pending.set(id, result => {
        signal.removeEventListener('abort', abort);
        resolveAnswer(result);
      });
      signal.addEventListener('abort', abort, { once: true });
      send({ id, method: 'qi/approval', params: { original: params, ...options } });
    });
    return nativeAppApprovalResponse(params, answer?.choice);
  },
});

async function endTurn(event) {
  if (!turn) return { content: [] };
  cleanupFailed = true;
  const result = await cua.turnEnded({ ...turn, event });
  turn = undefined;
  cleanupFailed = false;
  return result;
}

async function handle(message) {
  if (!message.method) {
    const answer = pending.get(message.id);
    if (answer) { pending.delete(message.id); answer(message.result); }
    return;
  }
  if (message.method === 'notifications/cancelled') {
    calls.get(message.params?.requestId)?.abort();
    return;
  }
  if (message.id === undefined) return;
  const controller = new AbortController();
  calls.set(message.id, controller);
  try {
    let result;
    switch (message.method) {
      case 'initialize':
        await cua.connect();
        result = { protocolVersion: '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name: 'qi-lcu', version: '1' }, instructions: cua.instructions };
        break;
      case 'tools/list': result = { tools: cua.publicTools() }; break;
      case 'tools/call': {
        const { name, arguments: args, _meta } = message.params;
        const identity = _meta?.['qi/turn'];
        if (!identity?.sessionId || !identity?.turnId) throw new Error('No active qì session/turn');
        if (cleanupFailed) throw new Error('LCU cleanup failed; reconnect before further input');
        if (turn && (turn.sessionId !== identity.sessionId || turn.turnId !== identity.turnId)) {
          throw new Error('Previous qì turn has not ended');
        }
        turn = { sessionId: identity.sessionId, turnId: identity.turnId };
        result = await cua.call(name, args, { ...turn, toolCallId: identity.toolCallId,
          signal: controller.signal });
        break;
      }
      case 'qi/turn-ended': result = await endTurn(message.params.event); break;
      case 'ping': result = {}; break;
      default: throw new Error(`Unsupported host method: ${message.method}`);
    }
    send({ id: message.id, result });
  } catch (error) {
    send({ id: message.id, error: { code: -32603, message: error.message } });
  } finally { calls.delete(message.id); }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const controller of calls.values()) controller.abort();
  for (const answer of pending.values()) answer({ choice: 'cancel' });
  pending.clear();
  try { await endTurn('Interrupt'); } catch {}
  await cua.close().catch(() => {});
  process.exit(0);
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  try { void handle(JSON.parse(line)); }
  catch { void shutdown(); }
});
input.on('close', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
