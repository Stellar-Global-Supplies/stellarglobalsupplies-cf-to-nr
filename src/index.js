import { fetchPagesMetrics } from "./cf-pages.js";
import { fetchWorkerMetrics, fetchAccountUsage, fetchBuildMetrics, fetchWorkerLogs } from "./cf-workers.js";
import {
  pushToNewRelic,
  pushLogsToNewRelic,
  buildWorkerEvents,
  buildSiteEvents,
  buildSummaryEvent,
  buildPagesBuildsEvents,
  buildAccountUsageEvent,
} from "./nr.js";
import { APP_MAP } from "./config.js";

/**
 * Cloudflare Worker — Cron Trigger (every 3 min)
 *
 * Secrets from CF Secrets Store (store ID: 2556bcd9458349f6b4ff2a3fc93bdba1):
 *   NEW_RELIC_LICENSE_KEY  ✅ already set
 *   CF_API_TOKEN           — needs: Analytics:Read, Workers Scripts:Read, Workers Tail (for logs)
 *   CF_ACCOUNT_ID          — your CF account ID
 *   NR_ACCOUNT_ID          — your NR account ID
 *   BETTER_STACK_HEARTBEAT_URL — optional
 */

async function resolveSecret(val) {
  if (!val) return undefined;
  if (typeof val === "object" && typeof val.get === "function") return await val.get();
  if (typeof val === "string") return val;
  return String(val);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const secretsOk =
        !!(await resolveSecret(env.CF_API_TOKEN)) &&
        !!(await resolveSecret(env.CF_ACCOUNT_ID)) &&
        !!(await resolveSecret(env.NEW_RELIC_LICENSE_KEY)) &&
        !!(await resolveSecret(env.NR_ACCOUNT_ID));

      return new Response(
        JSON.stringify({
          service: "stellar-nr-monitor",
          status: secretsOk ? "ok" : "degraded",
          checks: { secrets: secretsOk ? "ok" : "missing_secrets" },
        }),
        { status: secretsOk ? 200 : 503, headers: { "Content-Type": "application/json" } }
      );
    }

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

  const CF_API_TOKEN   = await resolveSecret(env.CF_API_TOKEN);
  const CF_ACCOUNT_ID  = await resolveSecret(env.CF_ACCOUNT_ID);
  const NR_LICENSE_KEY = await resolveSecret(env.NEW_RELIC_LICENSE_KEY);
  const NR_ACCOUNT_ID  = await resolveSecret(env.NR_ACCOUNT_ID);

  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !NR_LICENSE_KEY || !NR_ACCOUNT_ID) {
    console.error("[monitor] secrets missing — aborting");
    return;
  }

  // All worker names across all apps (for log fetching)
  const allWorkerNames = APP_MAP.flatMap((a) => a.workers ?? []);

  // ── Collect everything in parallel ─────────────────────────────────────────
  const [siteMetrics, workerMetrics, buildMetrics, accountUsage, workerLogs] =
    await Promise.allSettled([
      fetchPagesMetrics(CF_ACCOUNT_ID, CF_API_TOKEN),
      fetchWorkerMetrics(CF_ACCOUNT_ID, CF_API_TOKEN),
      fetchBuildMetrics(CF_ACCOUNT_ID, CF_API_TOKEN),
      fetchAccountUsage(CF_ACCOUNT_ID, CF_API_TOKEN),
      fetchWorkerLogs(CF_ACCOUNT_ID, CF_API_TOKEN, allWorkerNames),
    ]).then((results) =>
      results.map((r, i) => {
        if (r.status === "rejected") {
          console.error(`[monitor] collector[${i}] failed:`, r.reason?.message);
          return i === 3 ? null : [];
        }
        return r.value;
      })
    );

  console.log(
    `[monitor] collected — sites:${siteMetrics.length} workers:${workerMetrics.length} ` +
    `builds:${buildMetrics.length} logs:${workerLogs.length}`
  );

  // ── Build events ────────────────────────────────────────────────────────────
  const workerEvents  = buildWorkerEvents(workerMetrics);
  const siteEvents    = buildSiteEvents(siteMetrics);
  const buildsEvents  = buildPagesBuildsEvents(buildMetrics);
  const usageEvents   = buildAccountUsageEvent(accountUsage);

  const totalInvocations = workerMetrics.reduce((s, w) => s + w.invocations, 0);
  const totalErrors      = workerMetrics.reduce((s, w) => s + w.errors, 0);
  const totalRequests    = siteMetrics.reduce((s, m) => s + m.requests, 0);
  const totalVisitors    = siteMetrics.reduce((s, m) => s + m.uniqueVisitors, 0);
  const totalLogsPushed  = workerEvents.length + siteEvents.length +
                           buildsEvents.length + usageEvents.length + 1;

  const summaryEvent = buildSummaryEvent({
    totalApps: APP_MAP.length,
    totalWorkers: workerMetrics.length,
    totalInvocations,
    totalErrors,
    totalRequests,
    totalVisitors,
    totalLogsPushed,
    totalWorkerLogs: workerLogs.length,
    runStatus: "success",
    runDurationMs: Date.now() - start,
  });

  // ── Push events + logs in parallel ──────────────────────────────────────────
  const allEvents = [...workerEvents, ...siteEvents, ...buildsEvents, ...usageEvents, summaryEvent];

  const [eventsResult, logsResult] = await Promise.allSettled([
    pushToNewRelic(allEvents, NR_ACCOUNT_ID, NR_LICENSE_KEY),
    pushLogsToNewRelic(workerLogs, NR_LICENSE_KEY),
  ]);

  const { sent, failed } = eventsResult.value ?? { sent: 0, failed: allEvents.length };
  const { sent: logsSent } = logsResult.value ?? { sent: 0 };

  console.log(
    `[monitor] done in ${Date.now() - start}ms — events:${sent} failed:${failed} logs:${logsSent}`
  );

  // ── Ping Better Stack heartbeat ─────────────────────────────────────────────
  const heartbeatUrl = await resolveSecret(env.BETTER_STACK_HEARTBEAT_URL);
  if (heartbeatUrl && failed === 0) {
    try {
      await fetch(heartbeatUrl);
      console.log("[monitor] Better Stack heartbeat pinged ✅");
    } catch (err) {
      console.warn("[monitor] heartbeat failed:", err.message);
    }
  }
}