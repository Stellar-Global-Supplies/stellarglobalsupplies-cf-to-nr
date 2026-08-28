import { cfTimeWindow, safeFetch } from "./utils.js";
import { CF_PAGES_APPS } from "./config.js";

const CF_GQL  = "https://api.cloudflare.com/client/v4/graphql";
const CF_REST = "https://api.cloudflare.com/client/v4";

// ─────────────────────────────────────────────────────────────────────────────
// SUBREQUEST BUDGET
//
// CF Workers limit: 50 subrequests per invocation.
// We batch ALL per-hostname traffic and vitals queries into ONE GraphQL call
// each, using a multi-alias query (alias per hostname).  This saves ~22 calls
// vs the previous per-hostname loop approach.
//
//   Before:  12 traffic + 12 vitals + 10 builds + ... = 60  (over limit)
//   After:    1 traffic +  1 vitals + 10 builds + ... = 32  (well within)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all-domains HTTP traffic in ONE batched GraphQL call.
 * Uses multi-alias: one alias per hostname inside a single accounts[] query.
 */
export async function fetchPagesMetrics(accountId, apiToken) {
  const { since, until } = cfTimeWindow(30);
  const apps = CF_PAGES_APPS.filter((a) => a.domain);

  if (!apps.length) return [];

  // Build one alias per hostname: alias must be valid GraphQL identifier
  const aliases = apps.map((a, i) => ({
    app:   a,
    alias: `h${i}_${a.domain.replace(/[^a-zA-Z0-9]/g, "_")}`,
  }));

  const fragments = aliases.map(({ alias }) => `
    ${alias}: httpRequestsAdaptiveGroups(
      filter: {
        AND: [
          { clientRequestHTTPHost: "${alias.split("_").slice(1).join(".").replace(/_/g, ".")}" }
          { datetime_geq: $since }
          { datetime_leq: $until }
        ]
      }
      limit: 500
      orderBy: [datetime_ASC]
    ) {
      sum { requests pageViews cachedRequests bytes }
      uniq { uniques }
      dimensions { edgeResponseStatus }
    }
  `).join("\n");

  // The alias encodes the hostname — rebuild it properly for the filter
  // Instead, pass hostnames as literal strings directly (safe — no user input)
  const fragmentsClean = aliases.map(({ alias, app }) => `
    ${alias}: httpRequestsAdaptiveGroups(
      filter: {
        AND: [
          { clientRequestHTTPHost: "${app.domain}" }
          { datetime_geq: $since }
          { datetime_leq: $until }
        ]
      }
      limit: 500
      orderBy: [datetime_ASC]
    ) {
      sum { requests pageViews cachedRequests bytes }
      uniq { uniques }
      dimensions { edgeResponseStatus }
    }
  `).join("\n");

  const query = `
    query AllTraffic($accountId: String!, $since: String!, $until: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          ${fragmentsClean}
        }
      }
    }
  `;

  const body = await safeFetch(CF_GQL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
    body:    JSON.stringify({ query, variables: { accountId, since, until } }),
  }, "cf-pages-traffic");

  if (!body) {
    console.warn("[cf-pages] no response — returning empty metrics");
    return CF_PAGES_APPS.map((a) => buildEmptyMetric(a, "no_response"));
  }
  if (body.errors) {
    console.warn("[cf-pages] GraphQL errors:", JSON.stringify(body.errors).slice(0, 500));
  }

  const acct = body?.data?.viewer?.accounts?.[0] ?? {};
  const results = [];

  for (const { alias, app } of aliases) {
    const groups = acct[alias] ?? [];
    if (!groups.length) {
      console.warn(`[cf-pages:${app.domain}] zero rows — domain may not be CF-proxied`);
      results.push(buildEmptyMetric(app, "zero_rows"));
      continue;
    }

    const data = groups.reduce(
      (acc, g) => {
        const status = parseInt(g.dimensions?.edgeResponseStatus ?? "0", 10);
        const reqs   = g.sum?.requests ?? 0;
        acc.requests       += reqs;
        acc.pageViews      += g.sum?.pageViews     ?? 0;
        acc.cachedRequests += g.sum?.cachedRequests ?? 0;
        acc.bytes          += g.sum?.bytes          ?? 0;
        acc.uniqueVisitors  = Math.max(acc.uniqueVisitors, g.uniq?.uniques ?? 0);
        if (status >= 200 && status < 300)      acc.http2xx += reqs;
        else if (status >= 300 && status < 400) acc.http3xx += reqs;
        else if (status >= 400 && status < 500) acc.http4xx += reqs;
        else if (status >= 500)                 acc.http5xx += reqs;
        return acc;
      },
      { requests: 0, pageViews: 0, cachedRequests: 0, bytes: 0,
        uniqueVisitors: 0, http2xx: 0, http3xx: 0, http4xx: 0, http5xx: 0 }
    );

    results.push({
      appName:        app.appName,
      domain:         app.domain,
      pagesProject:   app.pagesProject,
      requests:       data.requests,
      uniqueVisitors: data.uniqueVisitors,
      pageViews:      data.pageViews,
      http2xx:        data.http2xx,
      http3xx:        data.http3xx,
      http4xx:        data.http4xx,
      http5xx:        data.http5xx,
      cachedRequests: data.cachedRequests,
      bytes:          data.bytes,
      cacheHitRate:   data.requests > 0
        ? parseFloat(((data.cachedRequests / data.requests) * 100).toFixed(2)) : 0,
      errorRate5xx:   data.requests > 0
        ? parseFloat(((data.http5xx / data.requests) * 100).toFixed(4)) : 0,
      dataSource: "cf_http",
    });
  }

  // Add apps with no domain as zero-rows
  for (const app of CF_PAGES_APPS.filter((a) => !a.domain)) {
    results.push(buildEmptyMetric(app, "no_domain"));
  }

  return results;
}

/**
 * Fetch Core Web Vitals for all domains in ONE batched GraphQL call.
 * Uses multi-alias exactly like fetchPagesMetrics above.
 *
 * Filter key: siteTag (not requestHost — confirmed from CF GraphQL schema).
 * clsP75 stored ×1000 for NR integer precision; nr.js divides back on read.
 */
export async function fetchWebVitals(accountId, apiToken) {
  const { since, until } = cfTimeWindow(30);
  const apps = CF_PAGES_APPS.filter((a) => a.domain);

  if (!apps.length) return [];

  const aliases = apps.map((a, i) => ({
    app:   a,
    alias: `v${i}_${a.domain.replace(/[^a-zA-Z0-9]/g, "_")}`,
  }));

  const fragmentsClean = aliases.map(({ alias, app }) => `
    ${alias}: rumPerformanceEventsAdaptiveGroups(
      filter: {
        AND: [
          { siteTag: "${app.domain}" }
          { datetime_geq: $since }
          { datetime_leq: $until }
        ]
      }
      limit: 1
    ) {
      count
      quantiles {
        largestContentfulPaintP75
        firstInputDelayP75
        cumulativeLayoutShiftP75
        interactionToNextPaintP75
        timeToFirstByteP75
        firstContentfulPaintP75
      }
    }
  `).join("\n");

  const query = `
    query AllVitals($accountId: String!, $since: String!, $until: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          ${fragmentsClean}
        }
      }
    }
  `;

  const body = await safeFetch(CF_GQL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
    body:    JSON.stringify({ query, variables: { accountId, since, until } }),
  }, "cf-vitals");

  if (!body) {
    console.warn("[cf-vitals] no response");
    return apps.map((app) => buildEmptyVitals(app, "no_response"));
  }

  if (body.errors) {
    const msgs = body.errors.map((e) => e.message ?? "").join("; ");
    if (msgs.includes("rumPerformanceEventsAdaptiveGroups") || msgs.includes("siteTag")) {
      console.warn("[cf-vitals] RUM API not available — enable CF Web Analytics on the zone");
    } else {
      console.warn("[cf-vitals] errors:", msgs.slice(0, 400));
    }
  }

  const acct    = body?.data?.viewer?.accounts?.[0] ?? {};
  const results = [];

  for (const { alias, app } of aliases) {
    const groups = acct[alias] ?? [];
    if (!groups.length || !groups[0]?.quantiles) {
      results.push(buildEmptyVitals(app, "no_rum_data"));
      continue;
    }
    const q = groups[0].quantiles;
    results.push({
      appName:     app.appName,
      domain:      app.domain,
      lcpP75:      Math.round(q.largestContentfulPaintP75  ?? 0),
      fidP75:      Math.round(q.firstInputDelayP75          ?? 0),
      clsP75:      parseFloat(((q.cumulativeLayoutShiftP75 ?? 0) * 1000).toFixed(1)),
      inpP75:      Math.round(q.interactionToNextPaintP75   ?? 0),
      ttfbP75:     Math.round(q.timeToFirstByteP75          ?? 0),
      fcpP75:      Math.round(q.firstContentfulPaintP75     ?? 0),
      sampleCount: groups[0].count ?? 0,
      dataSource:  "cf_rum",
    });
  }

  return results;
}

/**
 * Fetch CF Pages build stats per project via REST API.
 * Runs sequentially (not parallel) to avoid subrequest spikes.
 * Only fetches for projects that actually exist (skips on 404).
 */
export async function fetchBuildMetrics(accountId, apiToken) {
  const projects = CF_PAGES_APPS.filter((a) => a.pagesProject);
  const results  = [];

  for (const app of projects) {
    const url  = `${CF_REST}/accounts/${accountId}/pages/projects/${app.pagesProject}/deployments?per_page=25`;
    const body = await safeFetch(url, {
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    }, `cf-builds:${app.pagesProject}`);

    if (!body?.success) {
      console.warn(`[cf-builds:${app.pagesProject}] not found or failed`);
      continue;
    }

    const deployments = body.result ?? [];
    const cutoff      = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent      = deployments.filter((d) => new Date(d.created_on).getTime() > cutoff);

    const counts = { total: 0, success: 0, failed: 0, cancelled: 0, durationMs: 0 };
    for (const d of recent) {
      counts.total++;
      const stage  = d.latest_stage?.name?.toLowerCase() ?? "";
      const status = (d.latest_stage?.status ?? "").toLowerCase();
      if (stage === "deploy" && status === "success")           counts.success++;
      else if (status === "failure" || status === "failed")     counts.failed++;
      else if (status === "canceled" || status === "cancelled") counts.cancelled++;
      const buildStage = (d.stages ?? []).find((s) => s.name === "build");
      if (buildStage?.started_on && buildStage?.ended_on) {
        counts.durationMs += new Date(buildStage.ended_on) - new Date(buildStage.started_on);
      }
    }

    results.push({
      pagesProject:     app.pagesProject,
      appName:          app.appName,
      totalBuilds:      counts.total,
      successBuilds:    counts.success,
      failedBuilds:     counts.failed,
      cancelledBuilds:  counts.cancelled,
      buildDurationMs:  Math.round(counts.durationMs),
      buildMinutes:     parseFloat((counts.durationMs / 60000).toFixed(2)),
      buildSuccessRate: counts.total > 0
        ? parseFloat(((counts.success / counts.total) * 100).toFixed(2)) : 100,
    });
  }

  console.log(`[cf-builds] fetched ${results.length} projects`);
  return results;
}

// ── Private helpers ──────────────────────────────────────────────────────────

function buildEmptyMetric(app, dataSource) {
  return {
    appName: app.appName, domain: app.domain ?? "", pagesProject: app.pagesProject ?? "",
    requests: 0, uniqueVisitors: 0, pageViews: 0, cachedRequests: 0, bytes: 0,
    http2xx: 0, http3xx: 0, http4xx: 0, http5xx: 0,
    cacheHitRate: 0, errorRate5xx: 0, dataSource,
  };
}

function buildEmptyVitals(app, dataSource) {
  return {
    appName: app.appName, domain: app.domain ?? "",
    lcpP75: 0, fidP75: 0, clsP75: 0, inpP75: 0, ttfbP75: 0, fcpP75: 0,
    sampleCount: 0, dataSource,
  };
}
