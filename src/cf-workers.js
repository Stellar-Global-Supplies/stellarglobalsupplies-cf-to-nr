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
 * Fetch CF account-level usage (CPU ms, subrequests, requests).
 * Returns a single aggregated object — pushed as CloudflareAccountUsage event.
 *
 * cpuTime field = total CPU milliseconds (not wall-clock) across all workers.
 * This is what CF bills against the 30M CPU-ms/month included.
 */
export async function fetchAccountUsage(accountId, apiToken) {
  const { since, until } = cfTimeWindow(5);

  // Use workersInvocationsAdaptive WITHOUT grouping by scriptName
  // to get true account-level totals in one call
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
 *
 * Uses pagesBuildResultsAdaptiveGroups — verified field in CF GraphQL schema.
 * Falls back gracefully to empty array if the account has no builds.
 * buildDurationMs = total build time in ms (NOT build minutes — CF doesn't
 * expose build minutes via GraphQL; we compute minutes = durationMs / 60000).
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

  // If the field doesn't exist in schema, CF returns an error — skip gracefully
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

  const groups = body?.data?.viewer?.accounts?.[0]?.pagesBuildResultsAdaptiveGroups ?? [];
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
    buildMinutes: parseFloat((p.buildDurationMs / 60000).toFixed(2)),
  }));
}

/**
 * Fetch Worker logs via CF Workers Observability Logs REST API.
 *
 * Endpoint: GET /accounts/:accountId/workers/scripts/:scriptName/logs
 * Requires: "Workers Observability" permission on API token (not just Tail).
 * Available on Workers Paid plan only.
 *
 * Falls back gracefully per worker if 403/404 (token missing permission
 * or worker not on paid plan).
 */
export async function fetchWorkerLogs(accountId, apiToken, workerNames) {
  const logs = [];
  // Fetch logs from last 5 minutes
  const sinceTs = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);

  for (const workerName of workerNames) {
    if (!workerName) continue;

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/logs?since=${sinceTs}&limit=100`;

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
        continue;
      }
      if (res.status === 404) {
        console.warn(`[cf-logs:${workerName}] 404 — worker not found or not on Paid plan`);
        continue;
      }
      if (!res.ok) {
        console.warn(`[cf-logs:${workerName}] HTTP ${res.status}`);
        continue;
      }

      result = await res.json();
    } catch (err) {
      console.warn(`[cf-logs:${workerName}] fetch error: ${err.message}`);
      continue;
    }

    const entries = result?.result ?? [];
    for (const entry of entries) {
      // Each entry may have multiple log lines in entry.logs[]
      const lines = Array.isArray(entry.logs) ? entry.logs : [entry];
      for (const line of lines) {
        const msg = line.message ?? entry.message ?? "";
        const lvl = (line.level ?? entry.level ?? "log").toLowerCase();
        logs.push({
          workerName,
          appName:  WORKER_TO_APP[workerName] ?? "unassigned",
          level:    lvl,
          message:  String(msg).slice(0, 4096),
          logTs:    (entry.timestamp ?? Date.now()),
          outcome:  entry.outcome ?? "ok",
          isError:  lvl === "error" || entry.outcome === "exception",
        });
      }
    }
  }

  console.log(`[cf-logs] collected ${logs.length} log lines from ${workerNames.length} workers`);
  return logs;
}