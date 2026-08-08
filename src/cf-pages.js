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
  const { since, until } = cfTimeWindow(5);
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
    // Log but don't crash — some hostnames may not be in CF yet
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