export function isRetryable(error) {
  return Boolean(error);
}

export async function runWithRetry(operation, {
  maxAttempts = 3,
  baseDelayMs = 10,
  maxDelayMs = 1000,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      if (attempt === maxAttempts || !isRetryable(error)) throw error;
      await sleep(Math.min(maxDelayMs, baseDelayMs));
    }
  }
}
