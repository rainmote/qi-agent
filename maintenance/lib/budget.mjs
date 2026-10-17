import { readJournal, digest, encode, putArtifact } from './store.mjs';
import { providerConfig, knownServiceTier } from './provider.mjs';

const positive = (v) => Number.isFinite(v) && v > 0;
export function validateBudget(config) {
  providerConfig(config);
  if (config?.schema_version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.model ?? '') ||
      !/^[a-z][a-z_-]*$/.test(config.effort ?? '') ||
      !positive(config.task_usd) || !positive(config.daily_usd) || config.task_usd > config.daily_usd ||
      !positive(config.input_usd_per_million) || !positive(config.output_usd_per_million) ||
      !Number.isSafeInteger(config.context_window_tokens) || config.context_window_tokens < 1024 || config.context_window_tokens > 10_000_000 ||
      !Number.isSafeInteger(config.max_output_tokens) || config.max_output_tokens < 16 || config.max_output_tokens >= config.context_window_tokens ||
      !Number.isSafeInteger(config.max_requests) || config.max_requests < 1 || config.max_requests > 256 ||
      !Number.isFinite(Date.parse(config.price_valid_until)) || Date.parse(config.price_valid_until) <= Date.now() ||
      typeof config.price_source !== 'string' || !config.price_source.startsWith('https://')) {
    throw new Error('Explicit model, effort, positive budgets, request limits and a current reviewed price ceiling are required');
  }
  // Integer microdollars, rounded up. Prices must cover every input tier/cache
  // charge for this exact model. This is a configured ceiling, not an invoice.
  for (const v of [config.task_usd * 1e6, config.daily_usd * 1e6,
    config.context_window_tokens * config.input_usd_per_million + config.max_output_tokens * config.output_usd_per_million]) {
    if (!Number.isSafeInteger(Math.ceil(v))) throw new Error('Budget exceeds safe integer precision');
  }
  return config;
}

export function budgetSnapshot(events, taskId, now = Date.now()) {
  const reservations = new Map();
  for (const event of events) {
    const data = event.data;
    if (event.type === 'budget/reserved') {
      if (reservations.has(data.request_id)) throw new Error('Duplicate budget reservation');
      reservations.set(data.request_id, { ...data, at: Date.parse(event.at), pending: true });
    } else if (event.type === 'budget/settled') {
      const request = reservations.get(data.request_id);
      if (!request || !request.pending || !Number.isSafeInteger(data.charged_microusd) || data.charged_microusd < 0) throw new Error('Invalid budget settlement');
      Object.assign(request, data, { pending: false });
    } else if (event.type === 'budget/reconciled') {
      const request = reservations.get(data.request_id);
      if (!request || (!request.pending && !request.uncertain) || !Number.isSafeInteger(data.charged_microusd) || data.charged_microusd < 0) throw new Error('Invalid budget reconciliation');
      Object.assign(request, data, { pending: false, uncertain: false });
    }
  }
  const calls = [...reservations.values()];
  const charge = (r) => r.pending ? r.reserved_microusd : r.charged_microusd;
  const task = calls.filter((r) => r.task_id === taskId);
  return { task_microusd: task.reduce((s, r) => s + charge(r), 0),
    daily_microusd: calls.filter((r) => r.at > now - 86400_000 || r.pending).reduce((s, r) => s + charge(r), 0),
    requests: task.length, uncertain: calls.filter((r) => r.pending || r.uncertain).map((r) => r.request_id),
    scope: 'configured-price-ceiling', invoice_cost_usd: null };
}

export async function reserveRequest(options) {
  return options.lock.exclusive(() => reserve(options));
}

async function reserve({ root, lock, config, taskId, runId, requestId, deadline, accounting = {} }) {
  validateBudget(config);
  if (Date.now() >= deadline) throw new Error('wall-budget');
  const events = await readJournal(root);
  if (events.some((e) => e.type === 'budget/reserved' && e.data.request_id === requestId)) throw new Error('duplicate-request');
  const usage = budgetSnapshot(events, taskId);
  if (usage.uncertain.length) throw new Error('unknown-cost');
  if (usage.requests >= config.max_requests) throw new Error('request-budget');
  // Reserve the model's entire input window, not a character/token estimate.
  // Stateless text/function requests and capped output are enforced by broker.
  const reserved = Math.ceil(config.context_window_tokens * config.input_usd_per_million +
    config.max_output_tokens * config.output_usd_per_million);
  if (usage.task_microusd + reserved > Math.floor(config.task_usd * 1e6) ||
      usage.daily_microusd + reserved > Math.floor(config.daily_usd * 1e6)) throw new Error('cost-budget');
  const data = { task_id: taskId, run_id: runId, request_id: requestId, reserved_microusd: reserved,
    config_hash: digest(encode(config)), provider: providerConfig(config).id, model: config.model, scope: usage.scope,
    logical_request_id: accounting.logical_request_id ?? null, native_run_id: accounting.native_run_id ?? null,
    purpose: accounting.purpose ?? null };
  await lock.append('budget/reserved', data); // fsync before any provider call
  return data;
}

export async function reconcileBudget({ root, lock, receipt }) {
  if (receipt?.role !== 'human' || !receipt.reviewer?.trim() || !receipt.summary?.trim() ||
      !receipt.provider_receipt?.trim() || !Number.isSafeInteger(receipt.charged_microusd) || receipt.charged_microusd < 0) throw new Error('A human-reviewed provider receipt and exact charge are required');
  return lock.exclusive(async () => {
    const events = await readJournal(root);
    const usage = budgetSnapshot(events, '');
    if (!usage.uncertain.includes(receipt.request_id)) throw new Error('No uncertain request with this identity');
    const reservation = events.find((e) => e.type === 'budget/reserved' && e.data.request_id === receipt.request_id).data;
    const evidence = await putArtifact(root, encode(receipt));
    await lock.append('budget/reconciled', { ...reservation, charged_microusd: receipt.charged_microusd, evidence });
    return { request_id: receipt.request_id, status: 'reconciled', charged_microusd: receipt.charged_microusd };
  });
}

export async function settleRequest({ lock, reservation, config, response }) {
  const usage = response?.usage;
  const known = ['completed', 'incomplete', 'failed', 'cancelled'].includes(response?.status) &&
    response.model === config.model && knownServiceTier(config, response) &&
    Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0 && usage.input_tokens <= config.context_window_tokens &&
    Number.isSafeInteger(usage?.output_tokens) && usage.output_tokens >= 0 && usage.output_tokens <= config.max_output_tokens;
  const charged = known ? Math.ceil(usage.input_tokens * config.input_usd_per_million + usage.output_tokens * config.output_usd_per_million) : reservation.reserved_microusd;
  await lock.append('budget/settled', { ...reservation, response_id: response?.id ?? null,
    charged_microusd: charged, uncertain: !known, usage: known ? usage : null, invoice_cost_usd: null });
  return { known, charged_microusd: charged };
}
