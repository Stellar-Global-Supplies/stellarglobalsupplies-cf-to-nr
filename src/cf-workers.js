import { cfTimeWindow, safeFetch } from "./utils.js";
import { WORKER_TO_APP } from "./config.js";

const CF_GQL = "https://api.cloudflare.com/client/v4/graphql";

/**
 * Fetch metrics for ALL workers in the account.
 * Returns: CloudflareWorkerMetric events (invocations, errors, CPU)
 */
export async function fetchWorkerMetrics(accountId, apiToken) {
  const { since, until } = cfTimeWindow(5);

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

  const groups = body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  const byScript = {};

  for (const g of groups) {
    const name = g.dimensions?.scriptName ?? "unknown";
    if (!byScript[name]) {
      byScript[name] = {
        workerName: name,
        appName: WORKER_TO_APP[name] ?? "unassigned",
        invocations: 0, errors: 0, subrequests: 0,
        cpuTimeP50: 0, cpuTimeP99: 0,
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
 * Fetch CF account-level platform usage:
 * - Total CPU ms across all workers
 * - Total subrequests
 * - Workers observability (Analytics Engine) dataset event count
 *   NOTE: neurons/AI tokens are only available if using CF AI Gateway.
 *   We use workersInvocationsAdaptive.sum.cpuTime for CPU budget tracking.
 */
export async function fetchAccountUsage(accountId, apiToken) {
  const { since, until } = cfTimeWindow(5);

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
 * Returns CloudflarePagesBuild events.
 */
export async function fetchBuildMetrics(accountId, apiToken) {
  const { since, until } = cfTimeWindow(5);

  const query = `
    query PagesBuildMetrics($accountId: String!, $since: String!, $until: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          pagesBuildResultsAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 200
          ) {
            sum { buildDurationMs }
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

  if (!body || body.errors) {
    console.warn("[cf-builds] errors:", JSON.stringify(body?.errors));
    return [];
  }

  const groups = body?.data?.viewer?.accounts?.[0]?.pagesBuildResultsAdaptiveGroups ?? [];
  const byProject = {};

  for (const g of groups) {
    const name   = g.dimensions?.projectName ?? "unknown";
    const status = g.dimensions?.status      ?? "unknown";
    if (!byProject[name]) {
      byProject[name] = {
        pagesProject: name, totalBuilds: 0,
        successBuilds: 0, failedBuilds: 0, cancelledBuilds: 0,
        buildDurationMs: 0,
      };
    }
    byProject[name].totalBuilds     += g.count             ?? 0;
    byProject[name].buildDurationMs += g.sum?.buildDurationMs ?? 0;
    if (status === "success")   byProject[name].successBuilds   += g.count ?? 0;
    if (status === "failure")   byProject[name].failedBuilds    += g.count ?? 0;
    if (status === "cancelled") byProject[name].cancelledBuilds += g.count ?? 0;
  }

  return Object.values(byProject).map((p) => ({
    ...p,
    buildSuccessRate: p.totalBuilds > 0
      ? parseFloat(((p.successBuilds / p.totalBuilds) * 100).toFixed(2))
      : 100,
    buildDurationMs: Math.round(p.buildDurationMs),
  }));
}

/**
 * Fetch CF Worker tail logs (last 5 min) and return as structured log events.
 * Uses CF Workers Tail API (REST, not GraphQL).
 * Returns CloudflareWorkerLog events — one per log line.
 *
 * NOTE: Tail logs require "Workers Tail" permission on the API token.
 * This fetches logs for every worker in the account.
 */
export async function fetchWorkerLogs(accountId, apiToken, workerNames) {
  const logs = [];
  const since = Date.now() - 5 * 60 * 1000; // 5 min ago ms

  // CF Tail API: list logs per script
  // We batch-fetch for all known worker names
  for (const workerName of workerNames) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/tails`;

    // Check if a tail already exists; if not, create one
    const tailsRes = await safeFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiToken}` },
    }, `cf-tail:${workerName}`);

    // Tail API is WebSocket-based for real-time; for polling we use
    // Workers Logs REST endpoint instead (available on Workers Paid plan)
    const logsUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/logs`;

    const logsRes = await safeFetch(logsUrl + `?since=${Math.floor(since / 1000)}&limit=100`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiToken}` },
    }, `cf-logs:${workerName}`);

    if (!logsRes?.result) continue;

    for (const entry of (logsRes.result ?? [])) {
      logs.push({
        workerName,
        appName:   WORKER_TO_APP[workerName] ?? "unassigned",
        level:     entry.level   ?? "log",
        message:   (entry.message ?? "").slice(0, 4096), // NR attr limit
        logTs:     entry.timestamp ?? Date.now(),
        outcome:   entry.outcome  ?? "unknown",
        isError:   (entry.level === "error" || entry.outcome === "exception"),
      });
    }
  }

  return logs;
}