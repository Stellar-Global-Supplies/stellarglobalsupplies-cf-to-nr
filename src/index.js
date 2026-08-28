import { fetchPagesMetrics, fetchWebVitals, fetchBuildMetrics } from "./cf-pages.js";
import {
  fetchWorkerMetrics, fetchAccountUsage,
  fetchWorkerLogs, fetchKvD1QueuesMetrics,
} from "./cf-workers.js";
import { fetchINRRate, computeCost } from "./cf-cost.js";
import {
  pushToNewRelic, pushLogsToNewRelic,
  buildWorkerEvents, buildSiteEvents, buildWebVitalsEvents,
  buildSummaryEvent, buildPagesBuildsEvents, buildAccountUsageEvent,
  buildCostEvent, buildKvEvents, buildD1Events, buildQueuesEvents,
} from "./nr.js";
import { APP_MAP } from "./config.js";

const CRON_WINDOW_MINUTES = 30;

async function resolveSecret(val) {
  if (!val) return undefined;
  if (typeof val === "object" && typeof val.get === "function") return await val.get();
  return String(val);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const secrets = await Promise.all([
        resolveSecret(env.CF_API_TOKEN),
        resolveSecret(env.CF_ACCOUNT_ID),
        resolveSecret(env.NEW_RELIC_LICENSE_KEY),
        resolveSecret(env.NR_ACCOUNT_ID),
        resolveSecret(env.CF_ZONE_MAIN),
      ]);
      const [cfToken, cfAccount, nrKey, nrAccount, cfZone] = secrets;
      return new Response(JSON.stringify({
        service: "stellar-nr-monitor",
        status:  (cfToken && cfAccount && nrKey && nrAccount) ? "ok" : "degraded",
        secrets: {
          CF_API_TOKEN:          !!cfToken,
          CF_ACCOUNT_ID:         !!cfAccount,
          NEW_RELIC_LICENSE_KEY: !!nrKey,
          NR_ACCOUNT_ID:         !!nrAccount,
          CF_ZONE_MAIN:          !!cfZone,  // required for DNS + Web Vitals
        },
      }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      service: "stellar-nr-monitor", schedule: `every ${CRON_WINDOW_MINUTES} minutes`,
    }), { headers: { "Content-Type": "application/json" } });
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
  // CF_ZONE_MAIN is the zone ID for stellarglobalsupplies.com
  // All subdomains (ops., orders., ai., workflow.) share the same zone.
  const CF_ZONE_MAIN   = await resolveSecret(env.CF_ZONE_MAIN);

  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !NR_LICENSE_KEY || !NR_ACCOUNT_ID) {
    console.error("[monitor] required secrets missing — aborting");
    return;
  }

  if (!CF_ZONE_MAIN) {
    console.warn("[monitor] CF_ZONE_MAIN not set — DNS traffic and Web Vitals will be empty");
  }

  const allWorkerNames = APP_MAP.flatMap((a) => a.workers ?? []).filter(Boolean);

  // ── Collect all data in parallel ─────────────────────────────────────────────
  const [
    siteMetrics, webVitals, workerMetrics, buildMetrics,
    accountUsage, workerLogs, kvD1Queues, inrRate,
  ] = await Promise.allSettled([
    fetchPagesMetrics(CF_ACCOUNT_ID, CF_API_TOKEN),
    fetchWebVitals(CF_ACCOUNT_ID, CF_API_TOKEN),
    fetchWorkerMetrics(CF_ACCOUNT_ID, CF_API_TOKEN),
    fetchBuildMetrics(CF_ACCOUNT_ID, CF_API_TOKEN),
    fetchAccountUsage(CF_ACCOUNT_ID, CF_API_TOKEN),
    fetchWorkerLogs(CF_ACCOUNT_ID, CF_API_TOKEN, allWorkerNames),
    fetchKvD1QueuesMetrics(CF_ACCOUNT_ID, CF_API_TOKEN),
    fetchINRRate(),
  ]).then((results) =>
    results.map((r, i) => {
      if (r.status === "rejected") {
        console.error(`[monitor] collector[${i}] failed:`, r.reason?.message);
        if (i === 4) return null;
        if (i === 6) return { kv: [], d1: [], queues: [] };
        if (i === 7) return 95.0;
        return [];
      }
      return r.value;
    })
  );

  console.log(
    `[monitor] sites:${siteMetrics.length} vitals:${webVitals.length} ` +
    `workers:${workerMetrics.length} builds:${buildMetrics.length} ` +
    `logs:${workerLogs.length} kv:${kvD1Queues.kv.length} ` +
    `d1:${kvD1Queues.d1.length} queues:${kvD1Queues.queues.length}`
  );

  // ── Cost ─────────────────────────────────────────────────────────────────────
  const cost = computeCost({
    windowRequests: workerMetrics.reduce((s, w) => s + w.invocations, 0),
    windowCpuMs:    accountUsage?.totalCpuMs ?? 0,
    monthlyBuilds:  buildMetrics.reduce((s, b) => s + b.totalBuilds, 0),
    inrRate,
    windowMinutes:  CRON_WINDOW_MINUTES,
  });

  // ── Build events ─────────────────────────────────────────────────────────────
  // NOTE: buildSummaryEvent is appended AFTER allEvents is built so that
  // allEvents.length is available (avoids "Cannot access before initialization").
  const allEvents = [
    ...buildWorkerEvents(workerMetrics),
    ...buildSiteEvents(siteMetrics),
    ...buildWebVitalsEvents(webVitals),
    ...buildPagesBuildsEvents(buildMetrics),
    ...buildAccountUsageEvent(accountUsage),
    ...buildCostEvent(cost),
    ...buildKvEvents(kvD1Queues.kv),
    ...buildD1Events(kvD1Queues.d1),
    ...buildQueuesEvents(kvD1Queues.queues),
  ];

  // Summary event added last so totalLogsPushed includes all other events
  allEvents.push(buildSummaryEvent({
    totalApps:        APP_MAP.length,
    totalWorkers:     workerMetrics.length,
    totalInvocations: workerMetrics.reduce((s, w) => s + w.invocations, 0),
    totalErrors:      workerMetrics.reduce((s, w) => s + w.errors, 0),
    totalRequests:    siteMetrics.reduce((s, m) => s + m.requests, 0),
    totalVisitors:    siteMetrics.reduce((s, m) => s + m.uniqueVisitors, 0),
    totalLogsPushed:  allEvents.length + 1,   // +1 for this summary event itself
    totalWorkerLogs:  workerLogs.length,
    runStatus:        "success",
    runDurationMs:    Date.now() - start,
    zoneConfigured:   !!CF_ZONE_MAIN,
  }));

  // ── Push ─────────────────────────────────────────────────────────────────────
  const [eventsResult, logsResult] = await Promise.allSettled([
    pushToNewRelic(allEvents, NR_ACCOUNT_ID, NR_LICENSE_KEY),
    pushLogsToNewRelic(workerLogs, NR_LICENSE_KEY),
  ]);

  const { sent, failed } = eventsResult.value ?? { sent: 0, failed: allEvents.length };
  const { sent: logsSent } = logsResult.value ?? { sent: 0 };
  console.log(`[monitor] done in ${Date.now() - start}ms — events:${sent} failed:${failed} logs:${logsSent}`);

  const heartbeatUrl = await resolveSecret(env.BETTER_STACK_HEARTBEAT_URL);
  if (heartbeatUrl && failed === 0) {
    try { await fetch(heartbeatUrl); } catch (_) {}
  }
}
