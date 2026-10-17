export function isRetryable(error) {
  if (error === null || typeof error !== 'object') return false;
  if (error.name === 'AbortError' || error.retryable === false) return false;
  if (error.retryable === true) return true;
  return (Number.isInteger(error.status) &&
    (error.status === 429 || (error.status >= 500 && error.status <= 599))) ||
    error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET';
}

export async function runWithRetry(operation, {
  maxAttempts = 3,
  baseDelayMs = 10,
  maxDelayMs = 1000,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  if (typeof operation !== 'function' || typeof sleep !== 'function' ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 ||
      typeof baseDelayMs !== 'number' || !Number.isFinite(baseDelayMs) || baseDelayMs < 0 ||
      typeof maxDelayMs !== 'number' || !Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new TypeError('invalid retry configuration');
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      if (attempt === maxAttempts || !isRetryable(error)) throw error;
      const delay = baseDelayMs === 0 ? 0 : Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
}
