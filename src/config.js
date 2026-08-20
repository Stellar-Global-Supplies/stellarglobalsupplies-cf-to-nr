/**
 * Stellar Global Supplies — App & Worker Mapping
 *
 * IMPORTANT — Zone IDs are required for:
 *   - DNS/traffic queries (httpRequestsAdaptiveGroups lives under zones{}, not accounts{})
 *   - Web Vitals / RUM (rumPerformanceEventsAdaptiveGroups also zone-scoped)
 *
 * How to find your Zone ID:
 *   CF Dashboard → select domain → Overview → right sidebar → Zone ID
 *   OR: curl -s "https://api.cloudflare.com/client/v4/zones?name=yourdomain.com" \
 *         -H "Authorization: Bearer <CF_API_TOKEN>" | jq '.result[0].id'
 *
 * CF_PAGES_APPS entries with no zoneId will skip traffic + web vitals queries
 * but will still get build metrics via REST API.
 */

export const APP_MAP = [
  {
    appName:      "stellarglobalsupplies.com",
    pagesProject: "stellarglobalsupplies-website",
    domain:       "stellarglobalsupplies.com",
    zoneId:       process.env?.CF_ZONE_MAIN ?? "4dd8951370b6044dd5e8c7988fe86e48",   // ← fill in your zone ID
    workers:      [],
  },
  {
    appName:      "stellar-ops-platform",
    pagesProject: "stellarglobalsupplies-ops-frontend",
    domain:       "ops.stellarglobalsupplies.com",
    zoneId:       process.env?.CF_ZONE_MAIN ?? "4dd8951370b6044dd5e8c7988fe86e48",   // same zone as main domain (subdomain)
    workers:      ["sgs-ops-worker"],
  },
  {
    appName:      "stellar-orders-platform",
    pagesProject: "vercel-orders-app",
    domain:       "orders.stellarglobalsupplies.com",
    zoneId:       process.env?.CF_ZONE_MAIN ?? "4dd8951370b6044dd5e8c7988fe86e48",
    workers:      ["sgs-orders-worker"],
  },
  {
    appName:      "stellar-quote-platform",
    pagesProject: "vercel-quote-app",
    domain:       "quotes.stellarglobalsupplies.com",
    zoneId:       process.env?.CF_ZONE_MAIN ?? "4dd8951370b6044dd5e8c7988fe86e48",
    workers:      ["sgs-quote-worker"],
  },
  {
    appName:      "stellar-ai-platform",
    pagesProject: "stellarglobalsupplies-stellarai",
    domain:       "ai.stellarglobalsupplies.com",
    zoneId:       process.env?.CF_ZONE_MAIN ?? "4dd8951370b6044dd5e8c7988fe86e48",
    workers:      ["stellar-ai-worker"],
  },
  {
    appName:      "stellar-status-platform",
    pagesProject: "",
    domain:       "status.stellarglobalsupplies.com",
    zoneId:       process.env?.CF_ZONE_MAIN ?? "4dd8951370b6044dd5e8c7988fe86e48",
    workers:      [""],
  },
  {
    appName:      "stellar-apps-platform",
    pagesProject: "stellarglobalsupplies-landingzone",
    domain:       "apps.stellarglobalsupplies.com",
    zoneId:       process.env?.CF_ZONE_MAIN ?? "4dd8951370b6044dd5e8c7988fe86e48",
    workers:      [""],
  },
  {
    appName:      "stellar-tests-platform",
    pagesProject: "stellarglobalsupplies-testing-platform",
    domain:       "tests.stellarglobalsupplies.com",
    zoneId:       process.env?.CF_ZONE_MAIN ?? "4dd8951370b6044dd5e8c7988fe86e48",
    workers:      ["stellarglobalsupplies-testing-platform"],
  },
  {
    appName:      "stellar-security-platform",
    pagesProject: "stellarglobalsupplies-prowler-security",
    domain:       "security.stellarglobalsupplies.com",
    zoneId:       process.env?.CF_ZONE_MAIN ?? "4dd8951370b6044dd5e8c7988fe86e48",
    workers:      ["prowler-api"],
  },
  {
    appName:      "stellar-scan-platform",
    pagesProject: "stellarglobalsupplies-scan",
    domain:       "scan.stellarglobalsupplies.com",
    zoneId:       process.env?.CF_ZONE_MAIN ?? "4dd8951370b6044dd5e8c7988fe86e48",
    workers:      ["scan-worker"],
  },
  {
    appName:      "stellar-nr-pusher",
    pagesProject: "",
    domain:       "",
    zoneId:       "",
    workers:      ["stellar-nr-monitor"],
  },
  {
    appName:      "stellar-workflow-platform",
    pagesProject: "stellarglobalsupplies-workflows",
    domain:       "workflow.stellarglobalsupplies.com",
    zoneId:       process.env?.CF_ZONE_MAIN ?? "4dd8951370b6044dd5e8c7988fe86e48",
    workers: [
      "stellarglobalsupplies-workflows",
      "stellar-job-runner",
      "brevo-campaign",
      "brevo-sync",
      "s3-cleanup",
      "ai-sync",
      "cur-forwarder",
      "postgres-forwarder",
      "stellar-workflow-runner",
      "stellar-schedule-runner",
    ],
  },
];

/** workerName → appName reverse lookup */
export const WORKER_TO_APP = APP_MAP.reduce((map, app) => {
  (app.workers ?? []).forEach((w) => { map[w] = app.appName; });
  return map;
}, {});

/** All apps that have a CF Pages project */
export const CF_PAGES_APPS = APP_MAP.filter((a) => a.pagesProject);

/** Unique zone IDs (subdomains share the parent zone) */
export const UNIQUE_ZONES = [
  ...new Map(
    APP_MAP.filter((a) => a.zoneId).map((a) => [a.zoneId, { zoneId: a.zoneId, domain: a.domain }])
  ).values(),
];