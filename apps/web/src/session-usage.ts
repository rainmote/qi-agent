import type { DurableEvent } from "./types";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const pending = (data: Record<string, unknown>) => data.status === "started" || data.status === "running";

/** Session-local logical requests only: neither aggregate run usage nor child indexes are added twice. */
export function sessionUsage(events: readonly DurableEvent[]) {
  const requests = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.type !== "usage/request" || typeof event.data.request_id !== "string"
      || (event.data.scope !== undefined && event.data.scope !== "logical_request")) continue;
    const key = `${event.data.session_id || ""}:${event.data.request_id}`;
    const previous = requests.get(key);
    if (!previous || pending(previous) || !pending(event.data)) requests.set(key, event.data);
  }
  let input = 0, output = 0, cached = 0, unknown = 0, durationMs = 0, cacheComplete = true;
  for (const data of requests.values()) {
    const usage = record(data.usage);
    const i = count(usage.input_tokens ?? usage.prompt_tokens);
    const o = count(usage.output_tokens ?? usage.completion_tokens);
    const c = count(record(usage.input_tokens_details ?? usage.prompt_tokens_details).cached_tokens);
    if (pending(data) || i === null || o === null) unknown++;
    input += i ?? 0; output += o ?? 0;
    if (i === null || c === null || c > i) cacheComplete = false;
    else cached += c;
    durationMs += count(data.duration_ms) ?? 0;
  }
  return { requests: requests.size, input, output, total: input + output, unknown, durationMs,
    cached: cacheComplete && requests.size > 0 ? cached : null,
    cachePercent: cacheComplete && unknown === 0 && input > 0 ? Math.round(cached / input * 100) : null };
}
