/**
 * Stellar Global Supplies — App & Worker Mapping
 *
 * To add a new app:   push a new object to APP_MAP
 * To add a worker:    add its name to the workers[] array of the relevant app
 * Workers not listed in any app → auto-tagged as appName: "unassigned"
 */

export const APP_MAP = [
    {
      appName: "stellarglobalsupplies.com",
      pagesProject: "stellarglobalsupplies-website",
      domain: "stellarglobalsupplies.com",
      workers: [],
    },
    {
      appName: "stellar-ops-platform",
      pagesProject: "stellarglobalsupplies-ops-frontend",
      domain: "ops.stellarglobalsupplies.com",
      workers: ["sgs-ops-worker"],
    },
    {
      appName: "stellar-orders-platform",
      pagesProject: "vercel-orders-app",
      domain: "orders.stellarglobalsupplies.com",
      workers: ["sgs-orders-worker"],
    },
    {
      appName: "stellar-quote-platform",
      pagesProject: "vercel-quote-app",
      domain: "quotes.stellarglobalsupplies.com",
      workers: ["sgs-quote-worker"],
    },
    {
      appName: "stellar-ai-platform",
      pagesProject: "stellarglobalsupplies-stellarai",
      domain: "ai.stellarglobalsupplies.com",
      workers: ["stellar-ai-worker"],
    },
    {
      appName: "stellar-nr-pusher",
      pagesProject: "",
      domain: "",
      workers: ["stellar-nr-monitor"],
    },
    {
      appName: "stellar-scan-platform",
      pagesProject: "",
      domain: "",
      workers: ["stellar-nr-monitor"],
    },
    {
      appName: "stellar-workflow-platform",
      pagesProject: "stellarglobalsupplies-workflows",
      domain: "workflow.stellarglobalsupplies.com",
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
  
  /**
   * Build a reverse lookup: workerName → appName
   * Used to tag worker metrics with their parent app
   */
  export const WORKER_TO_APP = APP_MAP.reduce((map, app) => {
    (app.workers || []).forEach((w) => {
      map[w] = app.appName;
    });
    return map;
  }, {});
  
  /**
   * Only apps that are live on CF Pages
   */
  export const CF_PAGES_APPS = APP_MAP.filter((a) => !a.notMigrated);
