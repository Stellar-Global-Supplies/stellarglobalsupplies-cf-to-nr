import { cfTimeWindow, safeFetch } from "./utils.js";
import { CF_PAGES_APPS } from "./config.js";

const CF_GQL  = "https://api.cloudflare.com/client/v4/graphql";
const CF_REST = "https://api.cloudflare.com/client/v4";

/**
 * Fetch per-domain HTTP traffic from CF GraphQL.
 *
 * Uses viewer.accounts[].httpRequestsAdaptiveGroups filtered by clientRequestHTTPHost.
 * This is ACCOUNT-scoped — no zone ID needed — and works for CF Pages custom domains,
 * CF Workers routes, and any hostname where traffic passes through CF's edge.
 *
 * The zone-level httpRequestsAdaptiveGroups table uses different filter keys and
 * does NOT support the same field set (e.g. no encryptedRequests per-row breakdown).
 * Always use account-level for per-hostname breakdown.
 *
 * @param {string} accountId  - CF account ID
 * @param {string} apiToken   - CF API token with Analytics:Read
 */
export async function fetchPagesMetrics(accountId, apiToken) {
  const { since, until } = cfTimeWindow(30);
  const results = [];

  for (const app of CF_PAGES_APPS) {
    if (!app.domain) {
      results.push(buildEmptyMetric(app, "no_domain"));
      continue;
    }

    const data = await queryByHostname(accountId, apiToken, app.domain, since, until);

    if (!data) {
      console.warn(`[cf-pages] no data for: ${app.domain}`);
      results.push(buildEmptyMetric(app, "no_data"));
      continue;
    }

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
      dataSource:     "cf_http",
    });
  }

  return results;
}

/**
 * Fetch Core Web Vitals (RUM) per domain via CF GraphQL.
 *
 * Uses viewer.accounts[].rumPerformanceEventsAdaptiveGroups — ACCOUNT-scoped,
 * filtered by { siteTag: $hostname } (not requestHost, not hostname).
 *
 * CF Web Analytics must be collecting data for the domain. For CF-proxied (orange-cloud)
 * domains this is auto-enabled. For Vercel/R53 domains the JS beacon must be manually
 * installed.
 *
 * clsP75 is stored ×1000 (integer) for NR precision — buildWebVitalsEvents in nr.js
 * divides back by 1000 before applying Google CWV thresholds.
 *
 * @param {string} accountId  - CF account ID (NOT zone ID)
 * @param {string} apiToken   - CF API token with Analytics:Read
 */
export async function fetchWebVitals(accountId, apiToken) {
  const { since, until } = cfTimeWindow(30);
  const results = [];

  for (const app of CF_PAGES_APPS) {
    if (!app.domain) continue;

    const vitals = await queryWebVitals(accountId, apiToken, app.domain, since, until);

    if (!vitals) {
      // Push zero row so NR widgets show "no data" instead of blank gaps
      results.push({
        appName:     app.appName,
        domain:      app.domain,
        lcpP75:      0,
        fidP75:      0,
        clsP75:      0,
        inpP75:      0,
        ttfbP75:     0,
        fcpP75:      0,
        sampleCount: 0,
        dataSource:  "cf_rum_no_data",
      });
      continue;
    }

    results.push({
      appName:    app.appName,
      domain:     app.domain,
      ...vitals,
      dataSource: "cf_rum",
    });
  }

  return results;
}

/**
 * Fetch CF Pages build stats per project via REST API.
 * GraphQL pagesBuildResultsAdaptiveGroups is not available on most plans.
 * REST /pages/projects/:name/deployments is always available.
 */
export async function fetchBuildMetrics(accountId, apiToken) {
  const projects = CF_PAGES_APPS.filter((a) => a.pagesProject);
  const results  = [];

  for (const app of projects) {
    const url = `${CF_REST}/accounts/${accountId}/pages/projects/${app.pagesProject}/deployments?per_page=25`;
    const body = await safeFetch(url, {
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    }, `cf-builds:${app.pagesProject}`);

    if (!body?.success) {
      console.warn(`[cf-builds:${app.pagesProject}] REST failed or project not found`);
      continue;
    }

    const deployments = body.result ?? [];
    const cutoff      = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent      = deployments.filter((d) => new Date(d.created_on).getTime() > cutoff);

    const counts = { total: 0, success: 0, failed: 0, cancelled: 0, durationMs: 0 };
    for (const d of recent) {
      counts.total++;
      const stage  = d.latest_stage?.name?.toLowerCase() ?? "";
      const status = (d.latest_stage?.status ?? d.deployment_trigger?.type ?? "").toLowerCase();
      if (stage === "deploy" && status === "success")          counts.success++;
      else if (status === "failure" || status === "failed")    counts.failed++;
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
        ? parseFloat(((counts.success / counts.total) * 100).toFixed(2))
        : 100,
    });
  }

  console.log(`[cf-builds] fetched ${results.length} projects`);
  return results;
}

// ── Private helpers ──────────────────────────────────────────────────────────

async function queryByHostname(accountId, apiToken, hostname, since, until) {
  const query = `
    query SiteTraffic($accountId: String!, $hostname: String!, $since: String!, $until: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          httpRequestsAdaptiveGroups(
            filter: {
              AND: [
                { clientRequestHTTPHost: $hostname }
                { datetime_geq: $since }
                { datetime_leq: $until }
              ]
            }
            limit: 500
            orderBy: [datetime_ASC]
          ) {
            sum {
              requests
              pageViews
              cachedRequests
              bytes
            }
            uniq {
              uniques
            }
            dimensions {
              edgeResponseStatus
            }
          }
        }
      }
    }
  `;

  const body = await safeFetch(CF_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ query, variables: { accountId, hostname, since, until } }),
  }, `cf-pages:${hostname}`);

  if (!body) return null;

  if (body.errors) {
    console.warn(`[cf-pages:${hostname}] errors:`, JSON.stringify(body.errors).slice(0, 300));
    return null;
  }

  const groups = body?.data?.viewer?.accounts?.[0]?.httpRequestsAdaptiveGroups ?? [];
  if (!groups.length) {
    console.warn(`[cf-pages:${hostname}] zero rows — domain may not be CF-proxied`);
    return null;
  }

  return groups.reduce(
    (acc, g) => {
      const status = parseInt(g.dimensions?.edgeResponseStatus ?? "0", 10);
      const reqs   = g.sum?.requests ?? 0;
      acc.requests        += reqs;
      acc.pageViews       += g.sum?.pageViews      ?? 0;
      acc.cachedRequests  += g.sum?.cachedRequests  ?? 0;
      acc.bytes           += g.sum?.bytes           ?? 0;
      acc.uniqueVisitors   = Math.max(acc.uniqueVisitors, g.uniq?.uniques ?? 0);
      if (status >= 200 && status < 300)      acc.http2xx += reqs;
      else if (status >= 300 && status < 400) acc.http3xx += reqs;
      else if (status >= 400 && status < 500) acc.http4xx += reqs;
      else if (status >= 500)                 acc.http5xx += reqs;
      return acc;
    },
    { requests: 0, pageViews: 0, cachedRequests: 0, bytes: 0,
      uniqueVisitors: 0, http2xx: 0, http3xx: 0, http4xx: 0, http5xx: 0 }
  );
}

async function queryWebVitals(accountId, apiToken, hostname, since, until) {
  const query = `
    query WebVitals($accountId: String!, $hostname: String!, $since: String!, $until: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          rumPerformanceEventsAdaptiveGroups(
            filter: {
              AND: [
                { siteTag: $hostname }
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
        }
      }
    }
  `;

  const body = await safeFetch(CF_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ query, variables: { accountId, hostname, since, until } }),
  }, `cf-vitals:${hostname}`);

  if (!body) return null;

  if (body.errors) {
    const isSchemaErr = body.errors.some(
      (e) => e.message?.includes("rumPerformanceEventsAdaptiveGroups") ||
             e.message?.includes("siteTag") ||
             e.extensions?.code === "GRAPHQL_VALIDATION_FAILED"
    );
    if (isSchemaErr) {
      console.warn(`[cf-vitals:${hostname}] RUM API not available — enable CF Web Analytics on the zone`);
    } else {
      console.warn(`[cf-vitals:${hostname}] errors:`, JSON.stringify(body.errors).slice(0, 300));
    }
    return null;
  }

  const groups = body?.data?.viewer?.accounts?.[0]?.rumPerformanceEventsAdaptiveGroups ?? [];
  if (!groups.length || !groups[0]?.quantiles) {
    console.warn(`[cf-vitals:${hostname}] no RUM data — ensure CF Web Analytics beacon is active`);
    return null;
  }

  const q = groups[0].quantiles;
  return {
    lcpP75:      Math.round(q.largestContentfulPaintP75  ?? 0),
    fidP75:      Math.round(q.firstInputDelayP75          ?? 0),
    clsP75:      parseFloat(((q.cumulativeLayoutShiftP75 ?? 0) * 1000).toFixed(1)), // ×1000 for NR precision
    inpP75:      Math.round(q.interactionToNextPaintP75   ?? 0),
    ttfbP75:     Math.round(q.timeToFirstByteP75          ?? 0),
    fcpP75:      Math.round(q.firstContentfulPaintP75     ?? 0),
    sampleCount: groups[0].count ?? 0,
  };
}

function buildEmptyMetric(app, dataSource) {
  return {
    appName: app.appName, domain: app.domain ?? "", pagesProject: app.pagesProject ?? "",
    requests: 0, uniqueVisitors: 0, pageViews: 0, cachedRequests: 0, bytes: 0,
    http2xx: 0, http3xx: 0, http4xx: 0, http5xx: 0,
    cacheHitRate: 0, errorRate5xx: 0, dataSource,
  };
}
