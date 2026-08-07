import { chunk, nowEpoch } from "./utils.js";

const NR_EVENT_API = "https://insights-collector.eu01.nr-data.net/v1/accounts";

/**
 * Push an array of events to New Relic Insights Event API.
 * Batches into chunks of 1000 (NR hard limit per POST).
 *
 * @param {object[]} events   - array of event objects (must include eventType)
 * @param {string}   accountId - NR account ID
 * @param {string}   licenseKey - NR ingest license key
 * @returns {{ sent: number, failed: number }}
 */
export async function pushToNewRelic(events, accountId, licenseKey) {
  if (!events.length) return { sent: 0, failed: 0 };

  const url = `${NR_EVENT_API}/${accountId}/events`;
  const headers = {
    "Content-Type": "application/json",
    "X-Insert-Key": licenseKey,
  };

  const batches = chunk(events, 1000);
  let sent = 0;
  let failed = 0;

  for (const batch of batches) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
      });

      if (res.ok) {
        sent += batch.length;
      } else {
        const text = await res.text();
        console.error(`[nr] POST failed HTTP ${res.status}: ${text}`);
        failed += batch.length;
      }
    } catch (err) {
      console.error(`[nr] POST exception: ${err.message}`);
      failed += batch.length;
    }
  }

  console.log(`[nr] pushed ${sent} events, ${failed} failed`);
  return { sent, failed };
}

// ─── Event builders ────────────────────────────────────────────────────────────

/**
 * One event per CF Worker
 */
export function buildWorkerEvents(workerMetrics) {
  const ts = nowEpoch();
  return workerMetrics.map((w) => ({
    eventType: "CloudflareWorkerMetric",
    timestamp: ts,
    workerName: w.workerName,
    appName: w.appName,
    invocations: w.invocations,
    errors: w.errors,
    errorRate: w.errorRate,
    subrequests: w.subrequests,
    cpuTimeP50Ms: w.cpuTimeP50,
    cpuTimeP99Ms: w.cpuTimeP99,
  }));
}

/**
 * One event per CF Pages app
 */
export function buildSiteEvents(siteMetrics) {
  const ts = nowEpoch();
  return siteMetrics.map((s) => ({
    eventType: "CloudflareSiteMetric",
    timestamp: ts,
    appName: s.appName,
    domain: s.domain,
    pagesProject: s.pagesProject,
    requests: s.requests,
    uniqueVisitors: s.uniqueVisitors,
    pageViews: s.pageViews,
    http2xx: s.http2xx,
    http3xx: s.http3xx,
    http4xx: s.http4xx,
    http5xx: s.http5xx,
    errorRate4xx:
      s.requests > 0
        ? parseFloat(((s.http4xx / s.requests) * 100).toFixed(4))
        : 0,
    errorRate5xx:
      s.requests > 0
        ? parseFloat(((s.http5xx / s.requests) * 100).toFixed(4))
        : 0,
    dataSource: s.dataSource,
  }));
}

/**
 * Single summary event per cron run — powers "totals" big-number widgets
 */
export function buildSummaryEvent({
  totalApps,
  totalWorkers,
  totalInvocations,
  totalErrors,
  totalRequests,
  totalVisitors,
  totalLogsPushed,
  runStatus,
  runDurationMs,
}) {
  return {
    eventType: "CloudflareCronSummary",
    timestamp: nowEpoch(),
    totalApps,
    totalWorkers,
    totalInvocations,
    totalErrors,
    totalRequests,
    totalVisitors,
    totalLogsPushed,
    runStatus,         // "success" | "partial" | "error"
    runDurationMs,
    globalErrorRate:
      totalInvocations > 0
        ? parseFloat(((totalErrors / totalInvocations) * 100).toFixed(4))
        : 0,
  };
}