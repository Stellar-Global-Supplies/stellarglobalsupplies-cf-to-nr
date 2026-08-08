import { fetchPagesMetrics } from "./cf-pages.js";
import { fetchWorkerMetrics, fetchAccountUsage, fetchBuildMetrics, fetchWorkerLogs } from "./cf-workers.js";
import { fetchINRRate, computeCost } from "./cf-cost.js";
import {
  pushToNewRelic,
  pushLogsToNewRelic,
  buildWorkerEvents,
  buildSiteEvents,
  buildSummaryEvent,
  buildPagesBuildsEvents,
  buildAccountUsageEvent,
  buildCostEvent,
} from "./nr.js";
import { APP_MAP } from "./config.js";

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
      const ok =
        !!(await resolveSecret(env.CF_API_TOKEN)) &&
        !!(await resolveSecret(env.CF_ACCOUNT_ID)) &&
        !!(await resolveSecret(env.NEW_RELIC_LICENSE_KEY)) &&
        !!(await resolveSecret(env.NR_ACCOUNT_ID));
      return new Response(
        JSON.stringify({ service: "stellar-nr-monitor", status: ok ? "ok" : "degraded" }),
        { status: ok ? 200 : 503, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({ service: "stellar-nr-monitor", status: "alive", schedule: "every 3 minutes", apps: APP_MAP.map((a) => a.appName) }),
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

  const allWorkerNames = APP_MAP.flatMap((a) => a.workers ?? []).filter(Boolean);

  // ── Collect everything in parallel ─────────────────────────────────────────
  const [siteMetrics, workerMetrics, buildMetrics, accountUsage, workerLogs, inrRate] =
    await Promise.allSettled([
      fetchPagesMetrics(CF_ACCOUNT_ID, CF_API_TOKEN),
      fetchWorkerMetrics(CF_ACCOUNT_ID, CF_API_TOKEN),
      fetchBuildMetrics(CF_ACCOUNT_ID, CF_API_TOKEN),
      fetchAccountUsage(CF_ACCOUNT_ID, CF_API_TOKEN),
      fetchWorkerLogs(CF_ACCOUNT_ID, CF_API_TOKEN, allWorkerNames),
      fetchINRRate(),
    ]).then((results) =>
      results.map((r, i) => {
        if (r.status === "rejected") {
          console.error(`[monitor] collector[${i}] failed:`, r.reason?.message);
          // index 3 = accountUsage (object), 5 = inrRate (number), rest are arrays
          if (i === 3) return null;
          if (i === 5) return 95.0; // INR fallback
          return [];
        }
        return r.value;
      })
    );

  console.log(
    `[monitor] sites:${siteMetrics.length} workers:${workerMetrics.length} ` +
    `builds:${buildMetrics.length} logs:${workerLogs.length} INR:${inrRate}`
  );

  // ── Compute cost ────────────────────────────────────────────────────────────
  const totalMonthlyBuilds = buildMetrics.reduce((s, b) => s + b.totalBuilds, 0);
  const cost = computeCost({
    windowRequests: workerMetrics.reduce((s, w) => s + w.invocations, 0),
    windowCpuMs:    accountUsage?.totalCpuMs ?? 0,
    monthlyBuilds:  totalMonthlyBuilds,
    inrRate,
  });

  // ── Build all NR events ──────────────────────────────────────────────────────
  const workerEvents = buildWorkerEvents(workerMetrics);
  const siteEvents   = buildSiteEvents(siteMetrics);
  const buildsEvents = buildPagesBuildsEvents(buildMetrics);
  const usageEvents  = buildAccountUsageEvent(accountUsage);
  const costEvents   = buildCostEvent(cost);

  const totalInvocations = workerMetrics.reduce((s, w) => s + w.invocations, 0);
  const totalErrors      = workerMetrics.reduce((s, w) => s + w.errors, 0);
  const totalRequests    = siteMetrics.reduce((s, m) => s + m.requests, 0);
  const totalVisitors    = siteMetrics.reduce((s, m) => s + m.uniqueVisitors, 0);
  const totalLogsPushed  =
    workerEvents.length + siteEvents.length + buildsEvents.length +
    usageEvents.length + costEvents.length + 1;

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

  // ── Push to New Relic ───────────────────────────────────────────────────────
  const allEvents = [
    ...workerEvents, ...siteEvents, ...buildsEvents,
    ...usageEvents, ...costEvents, summaryEvent,
  ];

  const [eventsResult, logsResult] = await Promise.allSettled([
    pushToNewRelic(allEvents, NR_ACCOUNT_ID, NR_LICENSE_KEY),
    pushLogsToNewRelic(workerLogs, NR_LICENSE_KEY),
  ]);

  const { sent, failed } = eventsResult.value ?? { sent: 0, failed: allEvents.length };
  const { sent: logsSent } = logsResult.value ?? { sent: 0 };

  console.log(
    `[monitor] done in ${Date.now() - start}ms — events:${sent} failed:${failed} logs:${logsSent}`
  );

  // ── Heartbeat ───────────────────────────────────────────────────────────────
  const heartbeatUrl = await resolveSecret(env.BETTER_STACK_HEARTBEAT_URL);
  if (heartbeatUrl && failed === 0) {
    try { await fetch(heartbeatUrl); } catch (_) {}
  }
}