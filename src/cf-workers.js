import { cfTimeWindow, safeFetch } from "./utils.js";
import { WORKER_TO_APP } from "./config.js";

const CF_GQL = "https://api.cloudflare.com/client/v4/graphql";

/**
 * Fetch metrics for ALL workers in the account.
 * Tags each worker with its parent appName via WORKER_TO_APP lookup.
 * Workers not in any APP_MAP entry are tagged as "unassigned".
 *
 * Returns array of CloudflareWorkerMetric-shaped objects.
 */
export async function fetchWorkerMetrics(accountId, apiToken) {
  const { since, until } = cfTimeWindow(5);

  const query = `
    query WorkerAnalytics($accountId: String!, $since: String!, $until: String!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          workersInvocationsAdaptive(
            filter: {
              datetime_geq: $since
              datetime_leq: $until
            }
            limit: 100
          ) {
            sum {
              requests
              errors
              subrequests
            }
            quantiles {
              cpuTimeP50
              cpuTimeP99
            }
            dimensions {
              scriptName
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
        variables: { accountId, since, until },
      }),
    },
    "cf-workers"
  );

  if (!body || body.errors) {
    console.warn("[cf-workers] GraphQL errors:", body?.errors);
    return [];
  }

  const groups =
    body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

  // Group rows by scriptName (each worker may have multiple status rows)
  const byScript = {};
  for (const g of groups) {
    const name = g.dimensions?.scriptName ?? "unknown";
    if (!byScript[name]) {
      byScript[name] = {
        workerName: name,
        appName: WORKER_TO_APP[name] ?? "unassigned",
        invocations: 0,
        errors: 0,
        subrequests: 0,
        cpuTimeP50: 0,
        cpuTimeP99: 0,
      };
    }
    byScript[name].invocations += g.sum?.requests ?? 0;
    byScript[name].errors += g.sum?.errors ?? 0;
    byScript[name].subrequests += g.sum?.subrequests ?? 0;
    // Take the max quantile across status rows (conservative estimate)
    byScript[name].cpuTimeP50 = Math.max(
      byScript[name].cpuTimeP50,
      g.quantiles?.cpuTimeP50 ?? 0
    );
    byScript[name].cpuTimeP99 = Math.max(
      byScript[name].cpuTimeP99,
      g.quantiles?.cpuTimeP99 ?? 0
    );
  }

  return Object.values(byScript).map((w) => ({
    ...w,
    errorRate:
      w.invocations > 0
        ? parseFloat(((w.errors / w.invocations) * 100).toFixed(4))
        : 0,
  }));
}