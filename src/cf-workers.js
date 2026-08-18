import { cfTimeWindow, safeFetch, mapConcurrent } from "./utils.js";
import { WORKER_TO_APP } from "./config.js";

const CF_GQL = "https://api.cloudflare.com/client/v4/graphql";

/**
 * Fetch metrics for ALL workers in the account.
 * Returns: CloudflareWorkerMetric events (invocations, errors, CPU)
 */
export async function fetchWorkerMetrics(accountId, apiToken) {
  const { since, until } = cfTimeWindow(30);

  const query = `
    query WorkerAnalytics($accountId: String!, $since: String!, $until: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          workersInvocationsAdaptive(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 100
          ) {
            sum { requests errors subrequests }
            quantiles { cpuTimeP50 cpuTimeP99 }
            dimensions { scriptName status }
          }
        }
      }
    }
  `;

  const body = await safeFetch(CF_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ query, variables: { accountId, since, until } }),
  }, "cf-workers");

  if (!body || body.errors) {
    console.warn("[cf-workers] GraphQL errors:", JSON.stringify(body?.errors));
    return [];
  }

  const groups   = body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  const byScript = {};

  for (const g of groups) {
    const name = g.dimensions?.scriptName ?? "unknown";
    if (!byScript[name]) {
      byScript[name] = {
        workerName:  name,
        appName:     WORKER_TO_APP[name] ?? "unassigned",
        invocations: 0, errors: 0, subrequests: 0,
        cpuTimeP50:  0, cpuTimeP99: 0,
      };
    }
    byScript[name].invocations  += g.sum?.requests    ?? 0;
    byScript[name].errors       += g.sum?.errors      ?? 0;
    byScript[name].subrequests  += g.sum?.subrequests ?? 0;
    byScript[name].cpuTimeP50    = Math.max(byScript[name].cpuTimeP50, g.quantiles?.cpuTimeP50 ?? 0);
    byScript[name].cpuTimeP99    = Math.max(byScript[name].cpuTimeP99, g.quantiles?.cpuTimeP99 ?? 0);
  }

  return Object.values(byScript).map((w) => ({
    ...w,
    errorRate: w.invocations > 0
      ? parseFloat(((w.errors / w.invocations) * 100).toFixed(4))
      : 0,
  }));
}

/**
 * Fetch CF account-level usage (CPU ms, subrequests, requests).
 * Returns a single aggregated object — pushed as CloudflareAccountUsage event.
 *
 * cpuTime field = total CPU milliseconds (not wall-clock) across all workers.
 * This is what CF bills against the 30M CPU-ms/month included.
 */
export async function fetchAccountUsage(accountId, apiToken) {
  const { since, until } = cfTimeWindow(30);

  const query = `
    query AccountUsage($accountId: String!, $since: String!, $until: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          workersInvocationsAdaptive(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 1
          ) {
            sum { requests errors subrequests cpuTime }
          }
        }
      }
    }
  `;

  const body = await safeFetch(CF_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ query, variables: { accountId, since, until } }),
  }, "cf-account-usage");

  if (!body || body.errors) {
    console.warn("[cf-account-usage] errors:", JSON.stringify(body?.errors));
    return null;
  }

  const groups = body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return groups.reduce(
    (acc, g) => {
      acc.totalRequests    += g.sum?.requests    ?? 0;
      acc.totalErrors      += g.sum?.errors      ?? 0;
      acc.totalSubrequests += g.sum?.subrequests ?? 0;
      acc.totalCpuMs       += g.sum?.cpuTime     ?? 0;
      return acc;
    },
    { totalRequests: 0, totalErrors: 0, totalSubrequests: 0, totalCpuMs: 0 }
  );
}

/**
 * Fetch CF Pages build metrics per project.
 */
export async function fetchBuildMetrics(accountId, apiToken) {
  const { since, until } = cfTimeWindow(30);

  const query = `
    query PagesBuildMetrics($accountId: String!, $since: String!, $until: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          pagesBuildResultsAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 200
          ) {
            sum { durationMs }
            count
            dimensions { projectName status }
          }
        }
      }
    }
  `;

  const body = await safeFetch(CF_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ query, variables: { accountId, since, until } }),
  }, "cf-builds");

  if (!body) {
    console.warn("[cf-builds] no response");
    return [];
  }

  if (body.errors) {
    const isSchemaError = body.errors.some(
      (e) => e.message?.includes("pagesBuildResultsAdaptiveGroups") ||
             e.extensions?.code === "GRAPHQL_VALIDATION_FAILED"
    );
    if (isSchemaError) {
      console.warn("[cf-builds] pagesBuildResultsAdaptiveGroups not available on this account plan");
      return [];
    }
    console.warn("[cf-builds] errors:", JSON.stringify(body.errors));
    return [];
  }

  const groups    = body?.data?.viewer?.accounts?.[0]?.pagesBuildResultsAdaptiveGroups ?? [];
  const byProject = {};

  for (const g of groups) {
    const name   = g.dimensions?.projectName ?? "unknown";
    const status = (g.dimensions?.status ?? "unknown").toLowerCase();
    if (!byProject[name]) {
      byProject[name] = {
        pagesProject: name, totalBuilds: 0,
        successBuilds: 0, failedBuilds: 0, cancelledBuilds: 0,
        buildDurationMs: 0,
      };
    }
    byProject[name].totalBuilds     += g.count          ?? 0;
    byProject[name].buildDurationMs += g.sum?.durationMs ?? 0;
    if (status === "success" || status === "active")
      byProject[name].successBuilds   += g.count ?? 0;
    else if (status === "failure" || status === "failed")
      byProject[name].failedBuilds    += g.count ?? 0;
    else if (status === "cancelled" || status === "canceled")
      byProject[name].cancelledBuilds += g.count ?? 0;
  }

  return Object.values(byProject).map((p) => ({
    ...p,
    buildSuccessRate: p.totalBuilds > 0
      ? parseFloat(((p.successBuilds / p.totalBuilds) * 100).toFixed(2))
      : 100,
    buildDurationMs: Math.round(p.buildDurationMs),
    buildMinutes:    parseFloat((p.buildDurationMs / 60000).toFixed(2)),
  }));
}

/**
 * Fetch Worker logs via CF Workers Observability Logs REST API.
 *
 * FIX: was a sequential for-loop over all workers — caused CPU exceeded errors
 * when running every 3 min with 15+ workers.  Now uses mapConcurrent (4 in
 * flight at a time) and caps per-worker log lines to 50 to limit payload size.
 *
 * Also bumped since window to 30 min to match new cron schedule.
 */
export async function fetchWorkerLogs(accountId, apiToken, workerNames) {
  const validWorkers = workerNames.filter(Boolean);
  // 30-min window to match cron schedule
  const sinceTs      = Math.floor((Date.now() - 30 * 60 * 1000) / 1000);

  const perWorkerLogs = await mapConcurrent(validWorkers, async (workerName) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/logs?since=${sinceTs}&limit=50`;

    let result = null;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
      });

      if (res.status === 403) {
        console.warn(`[cf-logs:${workerName}] 403 — token needs "Workers Observability" permission`);
        return [];
      }
      if (res.status === 404) {
        console.warn(`[cf-logs:${workerName}] 404 — worker not found or not on Paid plan`);
        return [];
      }
      if (!res.ok) {
        console.warn(`[cf-logs:${workerName}] HTTP ${res.status}`);
        return [];
      }

      result = await res.json();
    } catch (err) {
      console.warn(`[cf-logs:${workerName}] fetch error: ${err.message}`);
      return [];
    }

    const entries = result?.result ?? [];
    const lines   = [];
    for (const entry of entries) {
      const logLines = Array.isArray(entry.logs) ? entry.logs : [entry];
      for (const line of logLines) {
        const msg = line.message ?? entry.message ?? "";
        const lvl = (line.level ?? entry.level ?? "log").toLowerCase();
        lines.push({
          workerName,
          appName: WORKER_TO_APP[workerName] ?? "unassigned",
          level:   lvl,
          message: String(msg).slice(0, 4096),
          logTs:   entry.timestamp ?? Date.now(),
          outcome: entry.outcome   ?? "ok",
          isError: lvl === "error" || entry.outcome === "exception",
        });
      }
    }
    return lines;
  }, 4); // max 4 concurrent log fetches

  const logs = perWorkerLogs.flat();
  console.log(`[cf-logs] collected ${logs.length} log lines from ${validWorkers.length} workers`);
  return logs;
}

/**
 * Fetch KV, D1, and Queues metrics via CF GraphQL Analytics API.
 *
 * KV:     kvOperationsAdaptiveGroups    — reads, writes, deletes, lists per namespace
 * D1:     d1AnalyticsAdaptiveGroups     — queries, rows read/written per database
 * Queues: queuesMessageOperationsAdaptiveGroups — messages published/consumed/retried
 *
 * All three fall back gracefully if the account doesn't use that product.
 */
export async function fetchKvD1QueuesMetrics(accountId, apiToken) {
  const { since, until } = cfTimeWindow(30);

  const query = `
    query KvD1Queues($accountId: String!, $since: String!, $until: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {

          kvOperationsAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 200
          ) {
            sum { requests writeRequests deleteRequests listRequests }
            dimensions { namespaceId }
          }

          d1AnalyticsAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 200
          ) {
            sum { queryCount rowsRead rowsWritten }
            dimensions { databaseId }
          }

          queuesMessageOperationsAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 200
          ) {
            sum { publishCount deliverySuccessCount deliveryFailureCount retryCount deadLetterCount }
            dimensions { queueId action }
          }

        }
      }
    }
  `;

  const body = await safeFetch(CF_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ query, variables: { accountId, since, until } }),
  }, "cf-kv-d1-queues");

  const result = { kv: [], d1: [], queues: [] };

  if (!body) {
    console.warn("[cf-kv-d1-queues] no response");
    return result;
  }

  // CF returns partial errors per field if a product isn't available — handle gracefully
  if (body.errors) {
    const msgs = body.errors.map((e) => e.message ?? "").join("; ");
    console.warn("[cf-kv-d1-queues] partial errors:", msgs.slice(0, 400));
    // Don't return early — partial data may still be in body.data
  }

  const acct = body?.data?.viewer?.accounts?.[0] ?? {};

  // ── KV ────────────────────────────────────────────────────────────────────────
  for (const g of acct.kvOperationsAdaptiveGroups ?? []) {
    result.kv.push({
      namespaceId:    g.dimensions?.namespaceId ?? "unknown",
      reads:          g.sum?.requests      ?? 0,
      writes:         g.sum?.writeRequests  ?? 0,
      deletes:        g.sum?.deleteRequests ?? 0,
      lists:          g.sum?.listRequests   ?? 0,
    });
  }

  // ── D1 ────────────────────────────────────────────────────────────────────────
  for (const g of acct.d1AnalyticsAdaptiveGroups ?? []) {
    result.d1.push({
      databaseId:  g.dimensions?.databaseId ?? "unknown",
      queryCount:  g.sum?.queryCount   ?? 0,
      rowsRead:    g.sum?.rowsRead     ?? 0,
      rowsWritten: g.sum?.rowsWritten  ?? 0,
    });
  }

  // ── Queues ────────────────────────────────────────────────────────────────────
  const byQueue = {};
  for (const g of acct.queuesMessageOperationsAdaptiveGroups ?? []) {
    const qid = g.dimensions?.queueId ?? "unknown";
    if (!byQueue[qid]) byQueue[qid] = {
      queueId: qid, published: 0, deliverySuccess: 0,
      deliveryFailure: 0, retries: 0, deadLetters: 0,
    };
    byQueue[qid].published       += g.sum?.publishCount          ?? 0;
    byQueue[qid].deliverySuccess += g.sum?.deliverySuccessCount  ?? 0;
    byQueue[qid].deliveryFailure += g.sum?.deliveryFailureCount  ?? 0;
    byQueue[qid].retries         += g.sum?.retryCount            ?? 0;
    byQueue[qid].deadLetters     += g.sum?.deadLetterCount       ?? 0;
  }
  result.queues = Object.values(byQueue).map((q) => ({
    ...q,
    deliverySuccessRate: q.published > 0
      ? parseFloat(((q.deliverySuccess / q.published) * 100).toFixed(2))
      : 100,
  }));

  console.log(`[cf-kv-d1-queues] kv:${result.kv.length} d1:${result.d1.length} queues:${result.queues.length}`);
  return result;
}
