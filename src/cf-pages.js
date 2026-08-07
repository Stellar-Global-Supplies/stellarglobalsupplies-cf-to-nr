import { cfTimeWindow, safeFetch } from "./utils.js";
import { CF_PAGES_APPS } from "./config.js";

const CF_GQL = "https://api.cloudflare.com/client/v4/graphql";

/**
 * Fetch CF Pages analytics for all live CF Pages apps.
 * Returns array of CloudflareSiteMetric-shaped objects.
 *
 * CF GraphQL pagesFunctionsInvocationsAdaptiveGroups gives us
 * request counts per Pages project. For static pages (no Functions)
 * we fall back to httpRequestsAdaptiveGroups via the zone.
 */
export async function fetchPagesMetrics(accountId, apiToken) {
  const { since, until } = cfTimeWindow(5);
  const results = [];

  for (const app of CF_PAGES_APPS) {
    const data = await queryPagesProject(
      accountId,
      apiToken,
      app.pagesProject,
      since,
      until
    );

    if (!data) {
      // Project not found on CF Pages or API error — skip gracefully
      console.warn(`[cf-pages] No data for project: ${app.pagesProject}`);
      results.push(buildEmptyMetric(app, "cf_pages_unavailable"));
      continue;
    }

    results.push({
      appName: app.appName,
      domain: app.domain,
      pagesProject: app.pagesProject,
      requests: data.requests ?? 0,
      uniqueVisitors: data.uniqueVisitors ?? 0,
      pageViews: data.pageViews ?? 0,
      http2xx: data.http2xx ?? 0,
      http3xx: data.http3xx ?? 0,
      http4xx: data.http4xx ?? 0,
      http5xx: data.http5xx ?? 0,
      dataSource: "cf_pages",
    });
  }

  return results;
}

async function queryPagesProject(accountId, apiToken, projectName, since, until) {
  // CF GraphQL: Pages project request analytics
  const query = `
    query PagesAnalytics($accountId: String!, $projectName: String!, $since: String!, $until: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          pagesProjectsAdaptiveGroups(
            filter: {
              projectName: $projectName
              datetime_geq: $since
              datetime_leq: $until
            }
            limit: 1
          ) {
            sum {
              requests
              pageViews
            }
            uniq {
              uniques
            }
            dimensions {
              status
            }
          }
        }
      }
    }
  `;

  const body = await safeFetch(
    CF_GQL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        query,
        variables: { accountId, projectName, since, until },
      }),
    },
    `cf-pages:${projectName}`
  );

  if (!body || body.errors) {
    // Gracefully handle projects not yet on CF Pages (vercel apps etc.)
    if (body?.errors?.some((e) => e.message?.includes("not found"))) {
      return null;
    }
    console.warn(`[cf-pages] GraphQL errors for ${projectName}:`, body?.errors);
    return null;
  }

  const groups =
    body?.data?.viewer?.accounts?.[0]?.pagesProjectsAdaptiveGroups ?? [];

  // Aggregate across all status groups returned
  return groups.reduce(
    (acc, g) => {
      const status = parseInt(g.dimensions?.status ?? "0", 10);
      const reqs = g.sum?.requests ?? 0;
      acc.requests += reqs;
      acc.pageViews += g.sum?.pageViews ?? 0;
      acc.uniqueVisitors = Math.max(acc.uniqueVisitors, g.uniq?.uniques ?? 0);
      if (status >= 200 && status < 300) acc.http2xx += reqs;
      else if (status >= 300 && status < 400) acc.http3xx += reqs;
      else if (status >= 400 && status < 500) acc.http4xx += reqs;
      else if (status >= 500) acc.http5xx += reqs;
      return acc;
    },
    { requests: 0, pageViews: 0, uniqueVisitors: 0, http2xx: 0, http3xx: 0, http4xx: 0, http5xx: 0 }
  );
}

function buildEmptyMetric(app, dataSource) {
  return {
    appName: app.appName,
    domain: app.domain,
    pagesProject: app.pagesProject,
    requests: 0,
    uniqueVisitors: 0,
    pageViews: 0,
    http2xx: 0,
    http3xx: 0,
    http4xx: 0,
    http5xx: 0,
    dataSource,
  };
}