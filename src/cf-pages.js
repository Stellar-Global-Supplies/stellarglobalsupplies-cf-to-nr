import { cfTimeWindow, safeFetch } from "./utils.js";
import { CF_PAGES_APPS } from "./config.js";

const CF_GQL  = "https://api.cloudflare.com/client/v4/graphql";
const CF_REST = "https://api.cloudflare.com/client/v4";

/**
 * Fetch per-domain HTTP traffic from CF GraphQL.
 *
 * ROOT FIX: httpRequestsAdaptiveGroups only exists under viewer.zones{}, NOT under
 * viewer.accounts{}. You must pass the zone ID for the domain. All subdomains
 * (ops., orders., etc.) share the same zone ID as the root domain.
 *
 * Domains that have no zoneId set in config.js are skipped and return zero metric.
 */
export async function fetchPagesMetrics(zoneId, apiToken) {
  if (!zoneId) {
    console.warn("[cf-pages] no CF_ZONE_MAIN set — skipping traffic fetch. Add zone ID to secrets.");
    return [];
  }

  const { since, until } = cfTimeWindow(30);

  // Single query returns all subdomains — we split by clientRequestHTTPHost dimension
  const query = `
    query ZoneTraffic($zoneId: String!, $since: String!, $until: String!) {
      viewer {
        zones(filter: { zoneTag: $zoneId }) {
          httpRequestsAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 5000
            orderBy: [datetime_ASC]
          ) {
            sum {
              requests
              pageViews
              cachedRequests
              bytes
              encryptedRequests
            }
            uniq { uniques }
            dimensions {
              clientRequestHTTPHost
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
    body: JSON.stringify({ query, variables: { zoneId, since, until } }),
  }, "cf-pages-traffic");

  if (!body) { console.warn("[cf-pages] no response"); return []; }
  if (body.errors) {
    console.warn("[cf-pages] errors:", JSON.stringify(body.errors).slice(0, 500));
    return [];
  }

  const groups = body?.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];
  if (!groups.length) {
    console.warn("[cf-pages] zero rows — check zoneId and that domain is CF-proxied (orange cloud)");
    return [];
  }

  // Roll up by hostname
  const byHost = {};
  for (const g of groups) {
    const host   = g.dimensions?.clientRequestHTTPHost ?? "unknown";
    const status = parseInt(g.dimensions?.edgeResponseStatus ?? "0", 10);
    const reqs   = g.sum?.requests ?? 0;

    if (!byHost[host]) {
      byHost[host] = {
        domain: host, requests: 0, pageViews: 0, cachedRequests: 0, bytes: 0,
        uniqueVisitors: 0, http2xx: 0, http3xx: 0, http4xx: 0, http5xx: 0,
        encryptedRequests: 0,
      };
    }
    byHost[host].requests          += reqs;
    byHost[host].pageViews         += g.sum?.pageViews         ?? 0;
    byHost[host].cachedRequests    += g.sum?.cachedRequests     ?? 0;
    byHost[host].bytes             += g.sum?.bytes              ?? 0;
    byHost[host].encryptedRequests += g.sum?.encryptedRequests  ?? 0;
    byHost[host].uniqueVisitors     = Math.max(byHost[host].uniqueVisitors, g.uniq?.uniques ?? 0);
    if (status >= 200 && status < 300)       byHost[host].http2xx += reqs;
    else if (status >= 300 && status < 400)  byHost[host].http3xx += reqs;
    else if (status >= 400 && status < 500)  byHost[host].http4xx += reqs;
    else if (status >= 500)                  byHost[host].http5xx += reqs;
  }

  // Join with APP_MAP to attach appName + pagesProject
  return Object.values(byHost).map((h) => {
    const app = CF_PAGES_APPS.find((a) => a.domain === h.domain || h.domain.endsWith(`.${a.domain}`));
    return {
      ...h,
      appName:      app?.appName      ?? "unknown",
      pagesProject: app?.pagesProject ?? "",
      cacheHitRate: h.requests > 0 ? parseFloat(((h.cachedRequests / h.requests) * 100).toFixed(2)) : 0,
      errorRate5xx: h.requests > 0 ? parseFloat(((h.http5xx / h.requests) * 100).toFixed(4)) : 0,
      httpsRate:    h.requests > 0 ? parseFloat(((h.encryptedRequests / h.requests) * 100).toFixed(2)) : 0,
    };
  });
}

/**
 * Fetch Core Web Vitals (RUM) per domain via CF GraphQL.
 *
 * ROOT FIX: rumPerformanceEventsAdaptiveGroups is ZONE-scoped, not account-scoped.
 * Filter field is `requestHost` (not `siteTag`, not `hostname`).
 * CF Web Analytics must be enabled on the zone (auto-enabled for orange-cloud proxied domains).
 */
export async function fetchWebVitals(zoneId, apiToken) {
  if (!zoneId) {
    console.warn("[cf-vitals] no CF_ZONE_MAIN — skipping web vitals");
    return [];
  }

  const { since, until } = cfTimeWindow(30);

  const query = `
    query WebVitals($zoneId: String!, $since: String!, $until: String!) {
      viewer {
        zones(filter: { zoneTag: $zoneId }) {
          rumPerformanceEventsAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 100
          ) {
            count
            dimensions { requestHost }
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
    body: JSON.stringify({ query, variables: { zoneId, since, until } }),
  }, "cf-vitals");

  if (!body) { console.warn("[cf-vitals] no response"); return []; }

  if (body.errors) {
    const msgs = body.errors.map((e) => e.message ?? "").join("; ");
    // If RUM not available on this plan/zone, don't spam logs
    if (msgs.includes("rumPerformance") || msgs.includes("GRAPHQL_VALIDATION")) {
      console.warn("[cf-vitals] RUM not available — ensure CF Web Analytics is enabled on the zone");
    } else {
      console.warn("[cf-vitals] errors:", msgs.slice(0, 400));
    }
    return [];
  }

  const groups = body?.data?.viewer?.zones?.[0]?.rumPerformanceEventsAdaptiveGroups ?? [];
  if (!groups.length) {
    console.warn("[cf-vitals] no RUM data — CF Web Analytics may not be collecting yet");
    return [];
  }

  return groups.map((g) => {
    const host   = g.dimensions?.requestHost ?? "unknown";
    const q      = g.quantiles ?? {};
    const lcpMs  = Math.round(q.largestContentfulPaintP75  ?? 0);
    const inpMs  = Math.round(q.interactionToNextPaintP75   ?? 0);
    const clsRaw = parseFloat((q.cumulativeLayoutShiftP75   ?? 0).toFixed(4));
    const fcpMs  = Math.round(q.firstContentfulPaintP75     ?? 0);
    const ttfbMs = Math.round(q.timeToFirstByteP75          ?? 0);
    const fidMs  = Math.round(q.firstInputDelayP75          ?? 0);

    const app = CF_PAGES_APPS.find((a) => a.domain === host || host.endsWith(`.${a.domain}`));

    return {
      domain:      host,
      appName:     app?.appName ?? "unknown",
      lcpP75:      lcpMs,
      inpP75:      inpMs,
      clsP75:      clsRaw,
      fcpP75:      fcpMs,
      ttfbP75:     ttfbMs,
      fidP75:      fidMs,
      sampleCount: g.count ?? 0,
      // CWV pass/fail — Google 2024 thresholds
      lcpStatus:   lcpMs  === 0 ? "no_data" : lcpMs  < 2500 ? "good" : lcpMs  < 4000 ? "needs_improvement" : "poor",
      inpStatus:   inpMs  === 0 ? "no_data" : inpMs  < 200  ? "good" : inpMs  < 500  ? "needs_improvement" : "poor",
      clsStatus:   clsRaw === 0 ? "no_data" : clsRaw < 0.1  ? "good" : clsRaw < 0.25 ? "needs_improvement" : "poor",
      fcpStatus:   fcpMs  === 0 ? "no_data" : fcpMs  < 1800 ? "good" : fcpMs  < 3000 ? "needs_improvement" : "poor",
      ttfbStatus:  ttfbMs === 0 ? "no_data" : ttfbMs < 800  ? "good" : ttfbMs < 1800 ? "needs_improvement" : "poor",
    };
  });
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
    // Only count deployments from the last 30 days
    const cutoff  = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent  = deployments.filter((d) => new Date(d.created_on).getTime() > cutoff);

    const counts = { total: 0, success: 0, failed: 0, cancelled: 0, durationMs: 0 };
    for (const d of recent) {
      counts.total++;
      const stage = d.latest_stage?.name?.toLowerCase() ?? "";
      const status = (d.latest_stage?.status ?? d.deployment_trigger?.type ?? "").toLowerCase();
      if (stage === "deploy" && status === "success")   counts.success++;
      else if (status === "failure" || status === "failed") counts.failed++;
      else if (status === "canceled" || status === "cancelled") counts.cancelled++;

      // build duration from stages
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