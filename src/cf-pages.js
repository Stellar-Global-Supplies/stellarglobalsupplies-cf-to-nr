import { cfTimeWindow, safeFetch } from "./utils.js";
import { CF_PAGES_APPS } from "./config.js";

const CF_GQL = "https://api.cloudflare.com/client/v4/graphql";

/**
 * Fetch CF Pages / site traffic per app.
 *
 * Strategy:
 *  1. Query httpRequestsAdaptiveGroups at ACCOUNT level filtered by clientRequestHTTPHost.
 *     This works for CF Pages custom domains and CF Workers routes.
 *     Does NOT require a zone ID — works across all zones in the account.
 *  2. For apps with no domain set, skip and return zero metric.
 *
 * Why this works even with R53 DNS:
 *   R53 CNAMEs → CF Pages URL → traffic hits CF edge → CF records it.
 *   CF GraphQL sees it under the account even without an explicit zone.
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
      dataSource:     "cf_http",
    });
  }

  return results;
}

/**
 * Fetch Web Vitals (RUM) for all apps that have a domain.
 *
 * Uses CF's rumPerformanceEventsAdaptiveGroups — this is the same data you see
 * in CF Dashboard → Web Analytics → Core Web Vitals.
 *
 * IMPORTANT: This only works for domains where CF Web Analytics JS snippet
 * is installed (either via CF auto-inject for proxied domains, or manually added).
 * For CF Pages with "orange cloud" proxy enabled, CF auto-injects the beacon.
 *
 * Metrics returned:
 *   lcpP75   — Largest Contentful Paint (ms) at p75
 *   fidP75   — First Input Delay (ms) at p75
 *   clsP75   — Cumulative Layout Shift score at p75 (unitless × 1000 for storage)
 *   inpP75   — Interaction to Next Paint (ms) at p75  [replaces FID in CWV 2024]
 *   ttfbP75  — Time to First Byte (ms) at p75
 *   fcpP75   — First Contentful Paint (ms) at p75
 *   sampleCount — number of real-user measurements in the window
 */
export async function fetchWebVitals(accountId, apiToken) {
  const { since, until } = cfTimeWindow(30);
  const results = [];

  for (const app of CF_PAGES_APPS) {
    if (!app.domain) continue;

    const vitals = await queryWebVitals(accountId, apiToken, app.domain, since, until);
    if (!vitals) {
      console.warn(`[cf-vitals] no RUM data for ${app.domain} — ensure CF Web Analytics is enabled`);
      // Still push a zero-row so NR doesn't show gaps
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
      appName:     app.appName,
      domain:      app.domain,
      ...vitals,
      dataSource:  "cf_rum",
    });
  }

  return results;
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
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${apiToken}`,
    },
    body: JSON.stringify({ query, variables: { accountId, hostname, since, until } }),
  }, `cf-vitals:${hostname}`);

  if (!body) return null;

  if (body.errors) {
    // rumPerformanceEventsAdaptiveGroups may not be available on all plans
    const isSchemaErr = body.errors.some(
      (e) => e.message?.includes("rumPerformanceEventsAdaptiveGroups") ||
             e.message?.includes("siteTag") ||
             e.extensions?.code === "GRAPHQL_VALIDATION_FAILED"
    );
    if (isSchemaErr) {
      console.warn(`[cf-vitals:${hostname}] RUM API not available — enable CF Web Analytics on this zone`);
    } else {
      console.warn(`[cf-vitals:${hostname}] errors:`, JSON.stringify(body.errors).slice(0, 300));
    }
    return null;
  }

  const groups = body?.data?.viewer?.accounts?.[0]?.rumPerformanceEventsAdaptiveGroups ?? [];
  if (!groups.length || !groups[0]?.quantiles) return null;

  const q = groups[0].quantiles;
  return {
    lcpP75:      Math.round(q.largestContentfulPaintP75  ?? 0),
    fidP75:      Math.round(q.firstInputDelayP75          ?? 0),
    clsP75:      parseFloat(((q.cumulativeLayoutShiftP75 ?? 0) * 1000).toFixed(1)),  // stored ×1000
    inpP75:      Math.round(q.interactionToNextPaintP75   ?? 0),
    ttfbP75:     Math.round(q.timeToFirstByteP75          ?? 0),
    fcpP75:      Math.round(q.firstContentfulPaintP75     ?? 0),
    sampleCount: groups[0].count ?? 0,
  };
}

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
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({ query, variables: { accountId, hostname, since, until } }),
  }, `cf-pages:${hostname}`);

  if (!body) return null;

  if (body.errors) {
    console.warn(`[cf-pages:${hostname}] errors:`, JSON.stringify(body.errors).slice(0, 300));
    return null;
  }

  const groups = body?.data?.viewer?.accounts?.[0]?.httpRequestsAdaptiveGroups ?? [];
  if (!groups.length) {
    console.warn(`[cf-pages:${hostname}] zero rows — domain may not be CF-proxied yet`);
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

function buildEmptyMetric(app, dataSource) {
  return {
    appName: app.appName, domain: app.domain ?? "", pagesProject: app.pagesProject ?? "",
    requests: 0, uniqueVisitors: 0, pageViews: 0, cachedRequests: 0, bytes: 0,
    http2xx: 0, http3xx: 0, http4xx: 0, http5xx: 0, dataSource,
  };
}
