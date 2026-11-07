/** Google Calendar retry domain. */
export function isRetryableCalendarError(error) {
  const status = Number(error?.response?.status ?? error?.code ?? error?.status);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND']
    .includes(String(error?.code || ''));
}

export function createModule(dependencies, shared) {
  const { RETRY_BACKOFF_MS, RETRY_COUNT } = dependencies;

async function defaultRetry(fn, {
  retries = 3,
  baseMs = 200
} = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === retries || !isRetryableCalendarError(e)) break;
      await new Promise(r => setTimeout(r, Math.min(15000, baseMs * Math.pow(2, i))));
    }
  }
  throw lastErr;
}

async function retry(fn) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableCalendarError(err)) throw err;
      if (++attempt >= RETRY_COUNT) throw err;
      const wait = Math.min(15000, RETRY_BACKOFF_MS * 2 ** (attempt - 1));
      await new Promise(res => setTimeout(res, wait));
    }
  }
}

  return { defaultRetry, retry };
}
