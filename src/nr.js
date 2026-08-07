import { chunk, nowEpoch } from "./utils.js";

// EU endpoint (matching your existing repo)
const NR_EVENT_API = "https://insights-collector.eu01.nr-data.net/v1/accounts";
const NR_LOG_API   = "https://log-api.eu01.nr-data.net/log/v1";

/**
 * Push custom events to New Relic Insights Event API.
 * Batches into chunks of 1000 (NR hard limit per POST).
 */
export async function pushToNewRelic(events, accountId, licenseKey) {
  if (!events.length) return { sent: 0, failed: 0 };

  const url     = `${NR_EVENT_API}/${accountId}/events`;
  const headers = { "Content-Type": "application/json", "X-Insert-Key": licenseKey };
  const batches = chunk(events, 1000);
  let sent = 0, failed = 0;

  for (const batch of batches) {
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(batch) });
      if (res.ok) {
        sent += batch.length;
      } else {
        console.error(`[nr] events POST ${res.status}: ${await res.text()}`);
        failed += batch.length;
      }
    } catch (err) {
      console.error(`[nr] events exception: ${err.message}`);
      failed += batch.length;
    }
  }

  console.log(`[nr] events pushed ${sent}, failed ${failed}`);
  return { sent, failed };
}

/**
 * Push worker logs to New Relic Log API.
 * Batches into chunks of 1000.
 */
export async function pushLogsToNewRelic(logEvents, licenseKey) {
  if (!logEvents.length) return { sent: 0, failed: 0 };

  const headers = {
    "Content-Type": "application/json",
    "X-License-Key": licenseKey,
  };

  // NR Log API format: array of { timestamp, message, attributes }
  const nrLogs = logEvents.map((l) => ({
    timestamp: l.logTs,
    message:   l.message,
    attributes: {
      workerName: l.workerName,
      appName:    l.appName,
      level:      l.level,
      outcome:    l.outcome,
      isError:    l.isError,
      logSource:  "cloudflare-worker",
    },
  }));

  const batches = chunk(nrLogs, 1000);
  let sent = 0, failed = 0;

  for (const batch of batches) {
    try {
      const res = await fetch(NR_LOG_API, {
        method: "POST",
        headers,
        body: JSON.stringify([{ logs: batch }]),
      });
      if (res.ok) {
        sent += batch.length;
      } else {
        console.error(`[nr] logs POST ${res.status}: ${await res.text()}`);
        failed += batch.length;
      }
    } catch (err) {
      console.error(`[nr] logs exception: ${err.message}`);
      failed += batch.length;
    }
  }

  console.log(`[nr] logs pushed ${sent}, failed ${failed}`);
  return { sent, failed };
}

// ── Event builders ─────────────────────────────────────────────────────────────

export function buildWorkerEvents(workerMetrics) {
  const ts = nowEpoch();
  return workerMetrics.map((w) => ({
    eventType:    "CloudflareWorkerMetric",
    timestamp:    ts,
    workerName:   w.workerName,
    appName:      w.appName,
    invocations:  w.invocations,
    errors:       w.errors,
    errorRate:    w.errorRate,
    subrequests:  w.subrequests,
    cpuTimeP50Ms: w.cpuTimeP50,
    cpuTimeP99Ms: w.cpuTimeP99,
  }));
}

export function buildSiteEvents(siteMetrics) {
  const ts = nowEpoch();
  return siteMetrics.map((s) => ({
    eventType:      "CloudflareSiteMetric",
    timestamp:      ts,
    appName:        s.appName,
    domain:         s.domain,
    pagesProject:   s.pagesProject,
    requests:       s.requests,
    uniqueVisitors: s.uniqueVisitors,
    pageViews:      s.pageViews,
    cachedRequests: s.cachedRequests ?? 0,
    bytes:          s.bytes          ?? 0,
    http2xx:        s.http2xx,
    http3xx:        s.http3xx,
    http4xx:        s.http4xx,
    http5xx:        s.http5xx,
    errorRate4xx:   s.requests > 0 ? parseFloat(((s.http4xx / s.requests) * 100).toFixed(4)) : 0,
    errorRate5xx:   s.requests > 0 ? parseFloat(((s.http5xx / s.requests) * 100).toFixed(4)) : 0,
    cacheHitRate:   s.requests > 0 ? parseFloat((((s.cachedRequests ?? 0) / s.requests) * 100).toFixed(2)) : 0,
    dataSource:     s.dataSource,
  }));
}

export function buildPagesBuildsEvents(buildMetrics) {
  const ts = nowEpoch();
  return buildMetrics.map((b) => ({
    eventType:       "CloudflarePagesBuild",
    timestamp:       ts,
    pagesProject:    b.pagesProject,
    totalBuilds:     b.totalBuilds,
    successBuilds:   b.successBuilds,
    failedBuilds:    b.failedBuilds,
    cancelledBuilds: b.cancelledBuilds,
    buildDurationMs: b.buildDurationMs,
    buildSuccessRate:b.buildSuccessRate,
  }));
}

export function buildAccountUsageEvent(usage) {
  if (!usage) return [];
  return [{
    eventType:           "CloudflareAccountUsage",
    timestamp:           nowEpoch(),
    totalWorkerRequests: usage.totalRequests,
    totalWorkerErrors:   usage.totalErrors,
    totalSubrequests:    usage.totalSubrequests,
    totalCpuMs:          usage.totalCpuMs,
  }];
}

export function buildSummaryEvent({
  totalApps, totalWorkers, totalInvocations, totalErrors,
  totalRequests, totalVisitors, totalLogsPushed, totalWorkerLogs,
  runStatus, runDurationMs,
}) {
  return {
    eventType:        "CloudflareCronSummary",
    timestamp:        nowEpoch(),
    totalApps,
    totalWorkers,
    totalInvocations,
    totalErrors,
    totalRequests,
    totalVisitors,
    totalLogsPushed,
    totalWorkerLogs:  totalWorkerLogs ?? 0,
    runStatus,
    runDurationMs,
    globalErrorRate:  totalInvocations > 0
      ? parseFloat(((totalErrors / totalInvocations) * 100).toFixed(4))
      : 0,
  };
}