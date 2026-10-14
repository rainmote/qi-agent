// Host-only provider access. The worker can write this mailbox, but cannot see
// the provider credential, budget journal, controller state or host network.
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { reserveRequest, settleRequest, validateBudget } from './budget.mjs';
import { durableWrite, encode } from './store.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
export function providerBody(body, config) {
  if (!body || typeof body !== 'object' || body.model !== config.model ||
      (body.tools ?? []).some((tool) => tool.type !== 'function') ||
      !Array.isArray(body.input)) throw new Error('Only the approved model and stateless text/function inputs are allowed');
  // Remote image/file URLs and provider-managed state/tools create unbounded
  // costs or network capabilities. Reject rather than silently stripping them.
  for (const item of body.input) {
    if (!item || !['message', 'function_call', 'function_call_output', 'reasoning'].includes(item.type ?? 'message')) throw new Error('Unsupported input item');
    if (item.type === 'reasoning') {
      if (typeof item.id !== 'string' || !Array.isArray(item.summary) ||
          (item.encrypted_content != null && typeof item.encrypted_content !== 'string')) throw new Error('Invalid self-contained reasoning item');
    } else if (item.type === 'function_call_output') {
      if (typeof item.output !== 'string') throw new Error('Only text function results are enabled');
    } else if (!item.type || item.type === 'message') {
      if (typeof item.content !== 'string' && (!Array.isArray(item.content) || item.content.some((c) => !['input_text', 'output_text'].includes(c.type) || typeof c.text !== 'string'))) throw new Error('Only text content is enabled');
    }
  }
  for (const field of ['previous_response_id', 'conversation', 'background', 'prompt']) {
    if (body[field] != null && body[field] !== false) throw new Error('Unsupported provider capability: ' + field);
  }
  if (body.include != null && (!Array.isArray(body.include) || body.include.some((value) => value !== 'reasoning.encrypted_content'))) throw new Error('Unsupported provider include');
  // Replay complete output items, including required reasoning IDs/ciphertext.
  // This is stateless context, not a server-side response/item reference; the
  // full-window reservation also covers its input tokens.
  return { model: config.model, instructions: body.instructions, input: body.input, tools: body.tools ?? [],
    include: ['reasoning.encrypted_content'],
    tool_choice: 'auto', parallel_tool_calls: true, reasoning: { effort: config.effort },
    store: false, stream: false, background: false, truncation: 'disabled', service_tier: 'default', max_output_tokens: config.max_output_tokens };
}

async function boundedJSON(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Invalid broker request file');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error('Broker request too large');
    return JSON.parse(buffer.subarray(0, bytesRead).toString());
  } finally { await handle.close(); }
}

export async function startBroker({ root, lock, config, taskId, runId, deadline, directory,
  credential = process.env.OPENAI_API_KEY, fetchImpl = fetch, stopped = async () => false }) {
  validateBudget(config);
  if (!credential) throw new Error('Missing dedicated OPENAI_API_KEY');
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  let closing = false, fatal = null, timer, activeAbort;
  const seen = new Set();
  const loop = (async () => {
    while (!closing) {
      if (await stopped()) { fatal = 'operator-paused'; break; }
      const names = [];
      const dir = await fs.opendir(directory);
      for await (const entry of dir) {
        if (entry.name.endsWith('.request.json')) names.push(entry.name);
        if (names.length > 4) throw new Error('Broker request concurrency exceeded');
      }
      for (const name of names.sort()) {
        if (!/^[a-f0-9-]{36}\.request\.json$/.test(name)) throw new Error('Invalid broker request identity');
        const requestId = runId + ':' + name.slice(0, 36);
        const responsePath = path.join(directory, name.replace('.request.', '.response.'));
        let reservation, result;
        try {
          if (seen.has(requestId)) throw new Error('duplicate-request');
          seen.add(requestId);
          const envelope = await boundedJSON(path.join(directory, name));
          if (envelope.method !== 'POST' || envelope.path !== '/v1/responses') throw new Error('Unsupported broker route');
          const body = providerBody(envelope.body, config);
          const accounting = envelope.accounting ?? {};
          for (const key of ['logical_request_id', 'native_run_id']) {
            if (accounting[key] != null && !/^[a-f0-9-]{36}$/.test(accounting[key])) throw new Error('Invalid accounting identity');
          }
          if (accounting.purpose != null && !['main', 'compaction'].includes(accounting.purpose)) throw new Error('Invalid request purpose');
          reservation = await reserveRequest({ root, lock, config, taskId, runId, requestId, deadline, accounting });
          activeAbort = new AbortController();
          const abortAt = setTimeout(() => activeAbort?.abort(), Math.max(1, Math.min(180_000, deadline - Date.now())));
          let response;
          try {
            const upstream = await fetchImpl('https://api.openai.com/v1/responses', { method: 'POST', redirect: 'error',
              headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' },
              body: JSON.stringify(body), signal: activeAbort.signal });
            // Read a bounded response without forwarding headers or error text.
            const chunks = []; let bytes = 0;
            for await (const chunk of upstream.body) {
              bytes += chunk.length;
              if (bytes > 8 * 1024 * 1024) { activeAbort.abort(); throw new Error('Provider response too large'); }
              chunks.push(chunk);
            }
            response = JSON.parse(Buffer.concat(chunks).toString());
            if (!upstream.ok) throw new Error('Provider HTTP ' + upstream.status);
          } finally { clearTimeout(abortAt); activeAbort = null; }
          const settled = await settleRequest({ lock, reservation, config, response });
          reservation = null;
          if (!settled.known) { fatal = 'unknown-cost'; throw new Error(fatal); }
          result = { status: 200, body: response };
        } catch (error) {
          if (reservation) await settleRequest({ lock, reservation, config, response: null });
          fatal = reservation ? 'unknown-cost' : (fatal ?? error.message);
          result = { status: 503, body: { error: { message: 'Maintenance broker stopped: ' + fatal, type: 'maintenance_budget' } } };
        }
        await durableWrite(responsePath, encode(result));
        await fs.unlink(path.join(directory, name)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
        if (fatal) break;
      }
      if (fatal) break;
      await new Promise((resolve) => { timer = setTimeout(resolve, 50); });
    }
  })().catch((error) => { fatal = error.message; });
  return { directory, failure: () => fatal,
    async close() { closing = true; activeAbort?.abort(); await loop; clearTimeout(timer); return fatal; } };
}
