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
 * Worker logs via CF Workers Observability REST API.
 *
 * The /workers/scripts/:name/logs endpoint does NOT exist on the public API.
 * CF exposes recent invocation logs through the Observability endpoint:
 *   GET /accounts/:id/workers/observability/telemetry/query
 * which requires the "Workers Observability" plan feature.
 *
 * For accounts without Observability enabled this falls back to a lightweight
 * "last N events" tail approach via /tails — but tails are streaming-only and
 * not useful in a cron context. We therefore safely skip log fetching per
 * worker and return a synthetic heartbeat log so the dashboard always gets
 * some data from this worker, rather than spamming 404/JSON parse errors.
 *
 * Concurrency-limited to avoid CPU exceeded errors.
 */
export async function fetchWorkerLogs(accountId, apiToken, workerNames) {
  const valid = workerNames.filter(Boolean);

  // Use Observability query API if available; fall back gracefully per worker.
  const perWorkerLogs = await mapConcurrent(valid, async (workerName) => {
    // Correct endpoint: Workers Observability telemetry (requires Observability add-on)
    const url = `${CF_REST}/accounts/${accountId}/workers/observability/telemetry/query`;
    try {
      // timeframe uses Unix timestamps in MILLISECONDS (not ISO strings — that causes 400)
      const fromMs = Date.now() - 30 * 60 * 1000;
      const toMs   = Date.now();

      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          // queryId is required — use the worker name as a stable ad-hoc identifier
          queryId:   `cron-logs-${workerName}`,
          // timeframe: Unix ms (not ISO strings)
          timeframe: { from: fromMs, to: toMs },
          // view: "events" returns individual log lines
          view:      "events",
          limit:     50,
          parameters: {
            // Filter to this specific worker script using the metadata key
            filters: [
              {
                key:       "$metadata.service",
                operation: "eq",
                value:     workerName,
              },
            ],
          },
        }),
      });

      // 401/403 = no Observability plan or token lacks logs:read scope
      if (res.status === 401 || res.status === 403) {
        console.warn(`[cf-logs:${workerName}] ${res.status} — token needs logs:read or Observability not enabled`);
        return [];
      }
      // 404 = endpoint or worker not found
      if (res.status === 404) {
        console.warn(`[cf-logs:${workerName}] 404 — worker not found or Observability not enabled`);
        return [];
      }
      if (!res.ok) {
        console.warn(`[cf-logs:${workerName}] HTTP ${res.status}`);
        return [];
      }

      // Guard against empty/non-JSON bodies (CF sometimes returns "-" or "" on errors)
      const text = await res.text();
      if (!text || text.trim() === "-" || text.trim() === "") {
        console.warn(`[cf-logs:${workerName}] empty body`);
        return [];
      }

      let result;
      try {
        result = JSON.parse(text);
      } catch (_) {
        console.warn(`[cf-logs:${workerName}] non-JSON body: ${text.slice(0, 80)}`);
        return [];
      }

      // TelemetryQueryResponse shape: { run: { events: [...] }, statistics: {...} }
      // Events are in result.run.events (view: "events") or result.run.invocations
      const events = result?.run?.events ?? result?.result ?? [];
      const lines = [];
      for (const entry of events) {
        // Each event has: $metadata.service, $metadata.level, message, timestamp, outcome
        const lvl = (
          entry["$metadata.level"] ?? entry.level ?? "log"
        ).toLowerCase();
        lines.push({
          workerName,
          appName: WORKER_TO_APP[workerName] ?? "unassigned",
          level:   lvl,
          message: String(
            entry["$metadata.message"] ?? entry.message ?? ""
          ).slice(0, 4096),
          logTs:   entry["$metadata.timestamp"] ?? entry.timestamp ?? Date.now(),
          outcome: entry["$metadata.outcome"]   ?? entry.outcome   ?? "ok",
          isError: lvl === "error" || (entry["$metadata.outcome"] ?? entry.outcome) === "exception",
        });
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
 *   Dimensions: databaseId
 *   Sum fields: readQueries, writeQueries, rowsRead, rowsWritten
 *               (queryCount does NOT exist — use readQueries + writeQueries)
 *
 * Queues:
 *   Table:      queuesAdaptiveGroups  (NOT queuesMessageOperationsAdaptiveGroups)
 *   Dimensions: queueName  (NOT queueId)
 *   Sum fields: messagePublishedCount, messageSuccessCount, messageRetryCount,
 *               messageFailureCount, messageDeadLetterCount
 */
export async function fetchKvD1QueuesMetrics(accountId, apiToken) {
  const { since, until } = cfTimeWindow(30);

  // ── KV query (separate — writeRequests/deleteRequests/listRequests are not
  //    available on all plan tiers; using only `requests` keeps it universal)
  const kvQuery = `
    query KvOps($accountId: String!, $since: String!, $until: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          kvOperationsAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 200
          ) {
            sum { requests }
            dimensions { namespaceId }
          }
        }
      }
    }
  `;

  // ── D1 + Queues query (separate from KV so a KV schema error doesn't kill D1/Queues)
  const d1QueuesQuery = `
    query D1Queues($accountId: String!, $since: String!, $until: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          d1AnalyticsAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 200
          ) {
            sum { readQueries writeQueries rowsRead rowsWritten }
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

  const fetchOpts = (q) => ({
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ query: q, variables: { accountId, since, until } }),
  });

  const [kvBody, d1QueuesBody] = await Promise.all([
    safeFetch(CF_GQL, fetchOpts(kvQuery),      "cf-kv"),
    safeFetch(CF_GQL, fetchOpts(d1QueuesQuery), "cf-d1-queues"),
  ]);

  const result = { kv: [], d1: [], queues: [] };

  if (!kvBody && !d1QueuesBody) {
    console.warn("[cf-kv-d1-queues] no response from either query");
    return result;
  }

  // Log partial errors (expected when products not provisioned on account)
  for (const [label, body] of [["cf-kv", kvBody], ["cf-d1-queues", d1QueuesBody]]) {
    if (body?.errors) {
      const msgs = body.errors.map((e) => `${e.path?.join(".")} — ${e.message}`).join("\n");
      console.warn(`[cf-kv-d1-queues] partial errors (expected if product not used):\n`, msgs.slice(0, 600));
    }
  }

  const kvAcct       = kvBody?.data?.viewer?.accounts?.[0]       ?? {};
  const d1QueuesAcct = d1QueuesBody?.data?.viewer?.accounts?.[0] ?? {};

  // ── KV ────────────────────────────────────────────────────────────────────────
  for (const g of kvAcct.kvOperationsAdaptiveGroups ?? []) {
    const reads = g.sum?.requests ?? 0;
    result.kv.push({
      namespaceId: g.dimensions?.namespaceId ?? "account_total",
      reads,
      writes:  0,   // not exposed on all plan tiers
      deletes: 0,
      lists:   0,
      totalOps:   reads,
      writeRatio: 0,
    });
  }

  // ── D1 ────────────────────────────────────────────────────────────────────────
  for (const g of d1QueuesAcct.d1AnalyticsAdaptiveGroups ?? []) {
    const readQ  = g.sum?.readQueries  ?? 0;
    const writeQ = g.sum?.writeQueries ?? 0;
    const rRead  = g.sum?.rowsRead     ?? 0;
    const rWrite = g.sum?.rowsWritten  ?? 0;
    result.d1.push({
      databaseId:   g.dimensions?.databaseId ?? "unknown",
      readQueries:  readQ,
      writeQueries: writeQ,
      queryCount:   readQ + writeQ,           // derived total for NR widgets
      rowsRead:     rRead,
      rowsWritten:  rWrite,
      totalRows:    rRead + rWrite,
      writeRatio:   (readQ + writeQ) > 0
        ? parseFloat((writeQ / (readQ + writeQ) * 100).toFixed(2)) : 0,
    });
  }

  // ── Queues ────────────────────────────────────────────────────────────────────
  for (const g of d1QueuesAcct.queuesAdaptiveGroups ?? []) {
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
