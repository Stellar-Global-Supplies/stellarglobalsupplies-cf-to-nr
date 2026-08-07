import { fetchPagesMetrics } from "./cf-pages.js";
import { fetchWorkerMetrics } from "./cf-workers.js";
import {
  pushToNewRelic,
  buildWorkerEvents,
  buildSiteEvents,
  buildSummaryEvent,
} from "./nr.js";
import { APP_MAP } from "./config.js";

/**
 * Cloudflare Worker — Cron Trigger
 * Runs every 3 minutes, collects CF metrics, pushes to New Relic.
 *
 * All secrets are bound directly to env.<NAME> from the CF Secrets Store
 * (per-secret bindings in wrangler.toml).
 * Store ID: 2556bcd9458349f6b4ff2a3fc93bdba1
 *
 * Required secrets in the store:
 *   NEW_RELIC_LICENSE_KEY  — NR Ingest License Key (already set ✅)
 *   CF_API_TOKEN           — CF API token (Analytics:Read + Workers Scripts:Read)
 *   CF_ACCOUNT_ID          — Cloudflare Account ID (numeric)
 *   NR_ACCOUNT_ID          — New Relic Account ID (numeric)
 */

// Helper to resolve Cloudflare secrets (handles both string and secret objects)
async function resolveSecret(val) {
  if (!val) return undefined;
  if (typeof val === "object" && typeof val.get === "function") return await val.get();
  if (typeof val === "string") return val;
  return String(val);
}

export default {
  // Simple health check so you can curl the worker URL to verify it's live
  async fetch(request, env) {
    return new Response(
      JSON.stringify({
        service: "stellar-nr-monitor",
        status: "alive",
        schedule: "every 3 minutes",
        apps: APP_MAP.map((a) => a.appName),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};

async function run(env) {
  const start = Date.now();
  console.log("[monitor] cron run starting");

  // ── Read secrets from CF Secrets Store (per-secret bindings) ───────────────
  // Each secret is bound directly to env.<NAME> in wrangler.toml
  const CF_API_TOKEN    = await resolveSecret(env.CF_API_TOKEN);
  const CF_ACCOUNT_ID   = await resolveSecret(env.CF_ACCOUNT_ID);
  const NR_LICENSE_KEY  = await resolveSecret(env.NEW_RELIC_LICENSE_KEY);
  const NR_ACCOUNT_ID   = await resolveSecret(env.NR_ACCOUNT_ID);

  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !NR_LICENSE_KEY || !NR_ACCOUNT_ID) {
    console.error("[monitor] one or more secrets missing from Secrets Store — aborting");
    return;
  }

  // ── 1. Collect CF Pages metrics ────────────────────────────────────────────
  let siteMetrics = [];
  try {
    siteMetrics = await fetchPagesMetrics(CF_ACCOUNT_ID, CF_API_TOKEN);
    console.log(`[monitor] fetched ${siteMetrics.length} site metrics`);
  } catch (err) {
    console.error("[monitor] fetchPagesMetrics failed:", err.message);
  }

  // ── 2. Collect CF Worker metrics ───────────────────────────────────────────
  let workerMetrics = [];
  try {
    workerMetrics = await fetchWorkerMetrics(CF_ACCOUNT_ID, CF_API_TOKEN);
    console.log(`[monitor] fetched ${workerMetrics.length} worker metrics`);
  } catch (err) {
    console.error("[monitor] fetchWorkerMetrics failed:", err.message);
  }

  // ── 3. Build NR events ──────────────────────────────────────────────────────
  const workerEvents = buildWorkerEvents(workerMetrics);
  const siteEvents   = buildSiteEvents(siteMetrics);

  const totalInvocations = workerMetrics.reduce((s, w) => s + w.invocations, 0);
  const totalErrors      = workerMetrics.reduce((s, w) => s + w.errors, 0);
  const totalRequests    = siteMetrics.reduce((s, m) => s + m.requests, 0);
  const totalVisitors    = siteMetrics.reduce((s, m) => s + m.uniqueVisitors, 0);
  const totalLogsPushed  = workerEvents.length + siteEvents.length + 1;

  const summaryEvent = buildSummaryEvent({
    totalApps: APP_MAP.length,
    totalWorkers: workerMetrics.length,
    totalInvocations,
    totalErrors,
    totalRequests,
    totalVisitors,
    totalLogsPushed,
    runStatus: "success",
    runDurationMs: Date.now() - start,
  });

  // ── 4. Push all events to New Relic ────────────────────────────────────────
  const allEvents = [...workerEvents, ...siteEvents, summaryEvent];
  const { sent, failed } = await pushToNewRelic(allEvents, NR_ACCOUNT_ID, NR_LICENSE_KEY);

  console.log(`[monitor] done in ${Date.now() - start}ms — sent: ${sent}, failed: ${failed}`);
  if (failed > 0) console.warn(`[monitor] ${failed} events failed to push`);
}