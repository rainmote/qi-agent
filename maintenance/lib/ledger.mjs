// Request identities, not equal token counts, determine deduplication.
export function usageLedger(records) {
  const calls = new Map();
  for (const record of records) {
    if (!record.request_id || !['started', 'completed', 'failed'].includes(record.status)) throw new Error('Invalid request accounting event');
    const previous = calls.get(record.request_id);
    if (previous && previous.status !== 'started' && JSON.stringify(previous) !== JSON.stringify(record)) {
      throw new Error('Conflicting accounting for one request');
    }
    calls.set(record.request_id, record);
  }
  const values = [...calls.values()];
  const complete = values.length > 0 && values.every((call) => call.status !== 'started' &&
    Number.isFinite(call.cost_usd) && call.cost_usd >= 0 && call.accounting_complete === true);
  return { model_calls: values, accounting_complete: complete,
    total_cost_usd: complete ? values.reduce((sum, call) => sum + call.cost_usd, 0) : null,
    known_cost_usd: values.reduce((sum, call) => sum + (Number.isFinite(call.cost_usd) && call.cost_usd >= 0 ? call.cost_usd : 0), 0) };
}

export function mayAttempt({ policy, startedAt, now = Date.now(), attempts, previousFingerprint, fingerprint, usage, paid, unattended }) {
  if (attempts >= policy.max_attempts) return 'attempt-budget';
  if (now - startedAt >= (policy.wall_seconds - policy.verification_reserve_seconds) * 1000) return 'wall-budget';
  if (previousFingerprint && previousFingerprint === fingerprint) return 'no-progress';
  if (paid && (unattended || attempts > 0) && !usage.accounting_complete) return 'unknown-cost';
  if (policy.max_cost_usd !== null && (!usage.accounting_complete || usage.total_cost_usd >= policy.max_cost_usd)) return 'cost-budget';
  return null;
}

export function actionIntent(events, actionId, payload) {
  const previous = events.filter((event) => event.data?.action_id === actionId);
  if (previous.length) return { allowed: false, status: previous.at(-1).type === 'action/result' ? 'recorded' : 'uncertain', previous: previous.at(-1).data };
  return { allowed: true, status: 'intent', action_id: actionId, payload };
}
