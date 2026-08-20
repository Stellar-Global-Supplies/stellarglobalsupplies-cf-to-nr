import { cfTimeWindow, safeFetch, mapConcurrent } from "./utils.js";
import { WORKER_TO_APP } from "./config.js";

const CF_GQL  = "https://api.cloudflare.com/client/v4/graphql";
const CF_REST = "https://api.cloudflare.com/client/v4";

/**
 * Fetch worker invocation metrics (account-scoped — works correctly).
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
    console.warn("[cf-workers] errors:", JSON.stringify(body?.errors).slice(0, 400));
    return [];
  }

  const groups   = body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  const byScript = {};

  for (const g of groups) {
    const name = g.dimensions?.scriptName ?? "unknown";
    if (!byScript[name]) {
      byScript[name] = {
        workerName: name, appName: WORKER_TO_APP[name] ?? "unassigned",
        invocations: 0, errors: 0, subrequests: 0, cpuTimeP50: 0, cpuTimeP99: 0,
      };
    }
    byScript[name].invocations += g.sum?.requests    ?? 0;
    byScript[name].errors      += g.sum?.errors      ?? 0;
    byScript[name].subrequests += g.sum?.subrequests ?? 0;
    byScript[name].cpuTimeP50   = Math.max(byScript[name].cpuTimeP50, g.quantiles?.cpuTimeP50 ?? 0);
    byScript[name].cpuTimeP99   = Math.max(byScript[name].cpuTimeP99, g.quantiles?.cpuTimeP99 ?? 0);
  }

  return Object.values(byScript).map((w) => ({
    ...w,
    errorRate: w.invocations > 0
      ? parseFloat(((w.errors / w.invocations) * 100).toFixed(4)) : 0,
  }));
}

/**
 * Account-level totals (for cost projection).
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

  if (!body || body.errors) return null;

  const groups = body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return groups.reduce(
    (acc, g) => ({
      totalRequests:    acc.totalRequests    + (g.sum?.requests    ?? 0),
      totalErrors:      acc.totalErrors      + (g.sum?.errors      ?? 0),
      totalSubrequests: acc.totalSubrequests + (g.sum?.subrequests ?? 0),
      totalCpuMs:       acc.totalCpuMs       + (g.sum?.cpuTime     ?? 0),
    }),
    { totalRequests: 0, totalErrors: 0, totalSubrequests: 0, totalCpuMs: 0 }
  );
}

/**
 * Worker logs via Observability REST API.
 * Concurrency-limited to avoid CPU exceeded errors.
 */
export async function fetchWorkerLogs(accountId, apiToken, workerNames) {
  const valid  = workerNames.filter(Boolean);
  const sinceTs = Math.floor((Date.now() - 30 * 60 * 1000) / 1000);

  const perWorkerLogs = await mapConcurrent(valid, async (workerName) => {
    const url = `${CF_REST}/accounts/${accountId}/workers/scripts/${workerName}/logs?since=${sinceTs}&limit=50`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      });
      if (res.status === 403) { console.warn(`[cf-logs:${workerName}] 403`); return []; }
      if (res.status === 404) { console.warn(`[cf-logs:${workerName}] 404`); return []; }
      if (!res.ok)            { console.warn(`[cf-logs:${workerName}] HTTP ${res.status}`); return []; }

      const result = await res.json();
      const entries = result?.result ?? [];
      const lines = [];
      for (const entry of entries) {
        const logLines = Array.isArray(entry.logs) ? entry.logs : [entry];
        for (const line of logLines) {
          const lvl = (line.level ?? entry.level ?? "log").toLowerCase();
          lines.push({
            workerName,
            appName: WORKER_TO_APP[workerName] ?? "unassigned",
            level:   lvl,
            message: String(line.message ?? entry.message ?? "").slice(0, 4096),
            logTs:   entry.timestamp ?? Date.now(),
            outcome: entry.outcome   ?? "ok",
            isError: lvl === "error" || entry.outcome === "exception",
          });
        }
      }
      return lines;
    } catch (err) {
      console.warn(`[cf-logs:${workerName}] ${err.message}`);
      return [];
    }
  }, 4);

  const logs = perWorkerLogs.flat();
  console.log(`[cf-logs] ${logs.length} lines from ${valid.length} workers`);
  return logs;
}

/**
 * KV, D1, and Queues metrics.
 *
 * CORRECTED field names (verified against CF GraphQL schema):
 *
 * KV:
 *   Table:      kvOperationsAdaptiveGroups
 *   Dimensions: namespaceId
 *   Sum fields: requests (reads), writeRequests, deleteRequests, listRequests
 *   NOTE: CF KV doesn't expose per-namespace breakdown in all plans.
 *         Falls back to account-level total if no dimensions returned.
 *
 * D1:
 *   Table:      d1AnalyticsAdaptiveGroups
 *   Dimensions: databaseId  (NOT databaseTag — that was wrong)
 *   Sum fields: queryCount, rowsRead, rowsWritten
 *
 * Queues:
 *   Table:      queuesAdaptiveGroups  (NOT queuesMessageOperationsAdaptiveGroups)
 *   Dimensions: queueName  (NOT queueId)
 *   Sum fields: messagePublishedCount, messageSuccessCount, messageRetryCount,
 *               messageFailureCount, messageDeadLetterCount
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
            sum {
              requests
              writeRequests
              deleteRequests
              listRequests
            }
            dimensions { namespaceId }
          }

          d1AnalyticsAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 200
          ) {
            sum {
              queryCount
              rowsRead
              rowsWritten
            }
            dimensions { databaseId }
          }

          queuesAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 200
          ) {
            sum {
              messagePublishedCount
              messageSuccessCount
              messageRetryCount
              messageFailureCount
              messageDeadLetterCount
            }
            dimensions { queueName }
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

  // CF returns partial errors per field if a product isn't used — handle each independently
  if (body.errors) {
    const msgs = body.errors.map((e) => `${e.path?.join(".")} — ${e.message}`).join("\n");
    console.warn("[cf-kv-d1-queues] partial errors (expected if product not used):\n", msgs.slice(0, 600));
  }

  const acct = body?.data?.viewer?.accounts?.[0] ?? {};

  // ── KV ────────────────────────────────────────────────────────────────────────
  for (const g of acct.kvOperationsAdaptiveGroups ?? []) {
    const reads   = g.sum?.requests       ?? 0;
    const writes  = g.sum?.writeRequests  ?? 0;
    const deletes = g.sum?.deleteRequests ?? 0;
    const lists   = g.sum?.listRequests   ?? 0;
    result.kv.push({
      namespaceId: g.dimensions?.namespaceId ?? "account_total",
      reads, writes, deletes, lists,
      totalOps:   reads + writes + deletes + lists,
      writeRatio: (reads + writes) > 0
        ? parseFloat((writes / (reads + writes) * 100).toFixed(2)) : 0,
    });
  }

  // ── D1 ────────────────────────────────────────────────────────────────────────
  for (const g of acct.d1AnalyticsAdaptiveGroups ?? []) {
    result.d1.push({
      databaseId:  g.dimensions?.databaseId ?? "unknown",
      queryCount:  g.sum?.queryCount  ?? 0,
      rowsRead:    g.sum?.rowsRead    ?? 0,
      rowsWritten: g.sum?.rowsWritten ?? 0,
      totalRows:   (g.sum?.rowsRead ?? 0) + (g.sum?.rowsWritten ?? 0),
      writeRatio:  ((g.sum?.rowsRead ?? 0) + (g.sum?.rowsWritten ?? 0)) > 0
        ? parseFloat(((g.sum?.rowsWritten ?? 0) / ((g.sum?.rowsRead ?? 0) + (g.sum?.rowsWritten ?? 0)) * 100).toFixed(2))
        : 0,
    });
  }

  // ── Queues ────────────────────────────────────────────────────────────────────
  for (const g of acct.queuesAdaptiveGroups ?? []) {
    const published = g.sum?.messagePublishedCount  ?? 0;
    const success   = g.sum?.messageSuccessCount    ?? 0;
    const retries   = g.sum?.messageRetryCount      ?? 0;
    const failures  = g.sum?.messageFailureCount    ?? 0;
    const deadLtrs  = g.sum?.messageDeadLetterCount ?? 0;
    result.queues.push({
      queueName:           g.dimensions?.queueName ?? "unknown",
      published,
      deliverySuccess:     success,
      deliveryFailure:     failures,
      retries,
      deadLetters:         deadLtrs,
      deliverySuccessRate: published > 0
        ? parseFloat((success / published * 100).toFixed(2)) : 100,
    });
  }

  console.log(`[cf-kv-d1-queues] kv:${result.kv.length} d1:${result.d1.length} queues:${result.queues.length}`);
  return result;
}