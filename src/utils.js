/**
 * Retry a fetch-based async fn up to `retries` times with exponential backoff
 */
export async function withRetry(fn, retries = 3, delayMs = 500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(delayMs * attempt);
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Unix timestamp (seconds) — New Relic expects epoch seconds
 */
export const nowEpoch = () => Math.floor(Date.now() / 1000);

/**
 * ISO string for CF GraphQL — last N minutes window
 * Default is 30 min to match cron schedule.
 */
export function cfTimeWindow(minutesAgo = 30) {
  const now  = new Date();
  const from = new Date(now.getTime() - minutesAgo * 60 * 1000);
  return {
    since: from.toISOString().replace(/\.\d+Z$/, "Z"),
    until: now.toISOString().replace(/\.\d+Z$/, "Z"),
  };
}

/**
 * Safe JSON fetch — returns null on non-2xx or network error
 */
export async function safeFetch(url, options, label = "") {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      console.warn(`[${label}] HTTP ${res.status}: ${await res.text()}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[${label}] fetch error: ${err.message}`);
    return null;
  }
}

/**
 * Chunk an array into batches of size n
 * New Relic Event API max payload: 1000 events per POST
 */
export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Concurrency-limited map — runs fn over items with max `concurrency` in-flight.
 * Replaces sequential for-loops that cause CPU timeout on large worker lists.
 */
export async function mapConcurrent(items, fn, concurrency = 4) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i    = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
