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

// Zone IDs are resolved at runtime from the CF_ZONE_MAIN secret (index.js →
// resolveSecret). The zoneId field in APP_MAP is metadata only — it is NOT used
// for API calls (those use the runtime secret). "process.env" does not exist in
// CF Workers; references to it have been removed.
const MAIN_ZONE_ID = "4dd8951370b6044dd5e8c7988fe86e48"; // stellarglobalsupplies.com

export const APP_MAP = [
  {
    appName:      "stellarglobalsupplies.com",
    pagesProject: "stellarglobalsupplies-website",
    domain:       "stellarglobalsupplies.com",
    zoneId:       MAIN_ZONE_ID,
    workers:      [],
  },
  {
    appName:      "stellar-ops-platform",
    pagesProject: "stellarglobalsupplies-ops-frontend",
    domain:       "ops.stellarglobalsupplies.com",
    zoneId:       MAIN_ZONE_ID,   // same zone — subdomains share the parent zone
    workers:      ["sgs-ops-worker"],
  },
  {
    appName:      "stellar-orders-platform",
    pagesProject: "vercel-orders-app",
    domain:       "orders.stellarglobalsupplies.com",
    zoneId:       MAIN_ZONE_ID,
    workers:      ["sgs-orders-worker"],
  },
  {
    appName:      "stellar-quote-platform",
    pagesProject: "vercel-quote-app",
    domain:       "quotes.stellarglobalsupplies.com",
    zoneId:       MAIN_ZONE_ID,
    workers:      ["sgs-quote-worker"],
  },
  {
    appName:      "stellar-ai-platform",
    pagesProject: "stellarglobalsupplies-stellarai",
    domain:       "ai.stellarglobalsupplies.com",
    zoneId:       MAIN_ZONE_ID,
    workers:      ["stellar-ai-worker"],
  },
  {
    appName:      "stellar-status-platform",
    pagesProject: "",
    domain:       "status.stellarglobalsupplies.com",
    zoneId:       MAIN_ZONE_ID,
    workers:      [],
  },
  {
    appName:      "stellar-apps-platform",
    pagesProject: "stellarglobalsupplies-landingzone",
    domain:       "apps.stellarglobalsupplies.com",
    zoneId:       MAIN_ZONE_ID,
    workers:      [],
  },
  {
    appName:      "stellar-tests-platform",
    pagesProject: "stellarglobalsupplies-testing-platform",
    domain:       "tests.stellarglobalsupplies.com",
    zoneId:       MAIN_ZONE_ID,
    workers:      ["stellarglobalsupplies-testing-platform"],
  },
  {
    appName:      "stellar-security-platform",
    pagesProject: "stellarglobalsupplies-prowler-security",
    domain:       "security.stellarglobalsupplies.com",
    zoneId:       MAIN_ZONE_ID,
    workers:      ["prowler-api"],
  },
  {
    appName:      "stellar-scan-platform",
    pagesProject: "stellarglobalsupplies-scan",
    domain:       "scan.stellarglobalsupplies.com",
    zoneId:       MAIN_ZONE_ID,
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
    zoneId:       MAIN_ZONE_ID,
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
