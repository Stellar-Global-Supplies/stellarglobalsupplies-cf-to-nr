import { chunk, nowEpoch } from "./utils.js";

// EU New Relic endpoints
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
 */
export async function pushLogsToNewRelic(logEvents, licenseKey) {
  if (!logEvents.length) return { sent: 0, failed: 0 };

  const headers = {
    "Content-Type": "application/json",
    "X-License-Key": licenseKey,
  };

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

/**
 * Build CloudflareWebVitals events from RUM data.
 *
 * CWV thresholds (Google 2024):
 *   LCP  good < 2500ms,  needs improvement < 4000ms,  poor >= 4000ms
 *   INP  good < 200ms,   needs improvement < 500ms,   poor >= 500ms
 *   CLS  good < 0.1,     needs improvement < 0.25,    poor >= 0.25  (×1000 stored)
 *   FCP  good < 1800ms,  needs improvement < 3000ms,  poor >= 3000ms
 *   TTFB good < 800ms,   needs improvement < 1800ms,  poor >= 1800ms
 *
 * lcpStatus / inpStatus / clsStatus — "good" | "needs_improvement" | "poor"
 * so dashboard can alert on these directly.
 */
export function buildWebVitalsEvents(webVitals) {
  const ts = nowEpoch();
  return webVitals.map((v) => {
    const lcpMs  = v.lcpP75  ?? 0;
    const inpMs  = v.inpP75  ?? 0;
    const clsRaw = (v.clsP75 ?? 0) / 1000;   // stored ×1000, restore for threshold check
    const fcpMs  = v.fcpP75  ?? 0;
    const ttfbMs = v.ttfbP75 ?? 0;

    return {
      eventType:   "CloudflareWebVitals",
      timestamp:   ts,
      appName:     v.appName,
      domain:      v.domain,
      // Raw measurements (ms / unitless)
      lcpP75:      lcpMs,
      fidP75:      v.fidP75  ?? 0,
      clsP75:      clsRaw,
      inpP75:      inpMs,
      ttfbP75:     ttfbMs,
      fcpP75:      fcpMs,
      sampleCount: v.sampleCount ?? 0,
      dataSource:  v.dataSource,
      // CWV pass/fail status strings — useful for FACET in NR dashboards
      lcpStatus:  lcpMs  === 0 ? "no_data" : lcpMs  < 2500 ? "good" : lcpMs  < 4000 ? "needs_improvement" : "poor",
      inpStatus:  inpMs  === 0 ? "no_data" : inpMs  < 200  ? "good" : inpMs  < 500  ? "needs_improvement" : "poor",
      clsStatus:  clsRaw === 0 ? "no_data" : clsRaw < 0.1  ? "good" : clsRaw < 0.25 ? "needs_improvement" : "poor",
      fcpStatus:  fcpMs  === 0 ? "no_data" : fcpMs  < 1800 ? "good" : fcpMs  < 3000 ? "needs_improvement" : "poor",
      ttfbStatus: ttfbMs === 0 ? "no_data" : ttfbMs < 800  ? "good" : ttfbMs < 1800 ? "needs_improvement" : "poor",
    };
  });
}

export function buildPagesBuildsEvents(buildMetrics) {
  const ts = nowEpoch();
  return buildMetrics.map((b) => ({
    eventType:        "CloudflarePagesBuild",
    timestamp:        ts,
    pagesProject:     b.pagesProject,
    totalBuilds:      b.totalBuilds,
    successBuilds:    b.successBuilds,
    failedBuilds:     b.failedBuilds,
    cancelledBuilds:  b.cancelledBuilds,
    buildDurationMs:  b.buildDurationMs,
    buildMinutes:     b.buildMinutes,
    buildSuccessRate: b.buildSuccessRate,
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

/**
 * Build CloudflareCost event from computed cost object.
 * One event per cron run — all periods (daily/weekly/monthly/yearly) in one event.
 */
export function buildCostEvent(cost) {
  if (!cost) return [];
  return [{
    eventType: "CloudflareCost",
    timestamp: nowEpoch(),
    ...cost,
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

// ── KV / D1 / Queues event builders ───────────────────────────────────────────

export function buildKvEvents(kvMetrics) {
  const ts = nowEpoch();
  return kvMetrics.map((k) => ({
    eventType:   "CloudflareKVMetric",
    timestamp:   ts,
    namespaceId: k.namespaceId,
    reads:       k.reads,
    writes:      k.writes,
    deletes:     k.deletes,
    lists:       k.lists,
    totalOps:    k.reads + k.writes + k.deletes + k.lists,
    writeRatio:  (k.reads + k.writes) > 0
      ? parseFloat(((k.writes / (k.reads + k.writes)) * 100).toFixed(2)) : 0,
  }));
}

export function buildD1Events(d1Metrics) {
  const ts = nowEpoch();
  return d1Metrics.map((d) => ({
    eventType:   "CloudflareD1Metric",
    timestamp:   ts,
    databaseId:  d.databaseId,
    queryCount:  d.queryCount,
    rowsRead:    d.rowsRead,
    rowsWritten: d.rowsWritten,
    totalRows:   d.rowsRead + d.rowsWritten,
    writeRatio:  (d.rowsRead + d.rowsWritten) > 0
      ? parseFloat(((d.rowsWritten / (d.rowsRead + d.rowsWritten)) * 100).toFixed(2)) : 0,
  }));
}

export function buildQueuesEvents(queuesMetrics) {
  const ts = nowEpoch();
  return queuesMetrics.map((q) => ({
    eventType:           "CloudflareQueuesMetric",
    timestamp:           ts,
    queueName:           q.queueName,
    published:           q.published,
    deliverySuccess:     q.deliverySuccess,
    deliveryFailure:     q.deliveryFailure,
    retries:             q.retries,
    deadLetters:         q.deadLetters,
    deliverySuccessRate: q.deliverySuccessRate,
  }));
}