# Stellar Global Supplies — CF → New Relic Monitor

Cloudflare Worker that runs every 30 minutes, collects metrics from Cloudflare, and pushes them to New Relic as custom events.

---

## What it collects

| Data | NR Event Type | Source |
|---|---|---|
| DNS / site traffic per domain | `CloudflareSiteMetric` | CF GraphQL `zones.httpRequestsAdaptiveGroups` |
| Core Web Vitals (LCP/INP/CLS/FCP/TTFB) | `CloudflareWebVitals` | CF GraphQL `zones.rumPerformanceEventsAdaptiveGroups` |
| Worker invocations, errors, CPU | `CloudflareWorkerMetric` | CF GraphQL `accounts.workersInvocationsAdaptive` |
| Account-level CPU/request totals | `CloudflareAccountUsage` | CF GraphQL |
| Pages build results | `CloudflarePagesBuild` | CF REST `/pages/projects/:name/deployments` |
| KV storage operations | `CloudflareKVMetric` | CF GraphQL `accounts.kvOperationsAdaptiveGroups` |
| D1 database queries | `CloudflareD1Metric` | CF GraphQL `accounts.d1AnalyticsAdaptiveGroups` |
| Queues message delivery | `CloudflareQueuesMetric` | CF GraphQL `accounts.queuesAdaptiveGroups` |
| Worker logs | NR Log API | CF REST Workers Observability |
| Estimated cost (USD + INR) | `CloudflareCost` | computed |
| Cron run health | `CloudflareCronSummary` | computed |

---

## Required Secrets (CF Secrets Store)

All secrets go in your CF Secrets Store (ID: `2556bcd9458349f6b4ff2a3fc93bdba1`).

| Secret | Description |
|---|---|
| `CF_API_TOKEN` | CF API token with: Zone Analytics Read, Workers Analytics Read, Pages Read, KV Read, D1 Read, Queues Read |
| `CF_ACCOUNT_ID` | Your CF account ID (CF Dashboard → right sidebar) |
| `CF_ZONE_MAIN` | **Zone ID for `stellarglobalsupplies.com`** — see below |
| `NR_ACCOUNT_ID` | Your New Relic account ID |
| `NEW_RELIC_LICENSE_KEY` | NR ingest license key |

### ⚠️ CF_ZONE_MAIN is required for DNS traffic + Web Vitals

CF's GraphQL API serves traffic and RUM data under `zones{}` not `accounts{}`.
You must provide the zone ID for `stellarglobalsupplies.com`.
All subdomains (ops., orders., ai., workflow.) share the same zone.

**Find your zone ID:**
```
CF Dashboard → select stellarglobalsupplies.com → Overview → right sidebar → Zone ID
```
Or via API:
```bash
curl -s "https://api.cloudflare.com/client/v4/zones?name=stellarglobalsupplies.com" \
  -H "Authorization: Bearer <CF_API_TOKEN>" | jq '.result[0].id'
```

Add it to Secrets Store, then bind it — `wrangler.toml` already has the binding.

---

## CF API Token Permissions

Create a token at CF Dashboard → My Profile → API Tokens → Create Token:

- **Zone → Analytics → Read** (for traffic + web vitals)
- **Zone → Zone → Read** (to look up zone info)
- **Account → Workers Scripts → Read**
- **Account → Workers Analytics → Read**
- **Account → Pages → Read**
- **Account → Workers KV Storage → Read**
- **Account → D1 → Read**
- **Account → Queues → Read**

---

## Deploy

```bash
# Install deps
npm install

# Add secrets to CF Secrets Store (CF Dashboard → Workers & Pages → Secrets Store)
# Then deploy:
npm run deploy
# or: npx wrangler deploy

# Verify health
curl https://stellar-nr-monitor.<your-subdomain>.workers.dev/health
```

---

## Dashboards (import into New Relic)

NR Dashboard → Import dashboard → paste JSON

| File | Contents |
|---|---|
| `dashboard-1-dns-traffic.json` | DNS/proxy traffic + Core Web Vitals |
| `dashboard-2-pages.json` | Pages traffic + build pipeline + CWV |
| `dashboard-3-workers.json` | Workers health + logs + cost |
| `dashboard-4-kv-d1-queues.json` | KV storage + D1 databases + Queues |
| `dashboard.json` | Combined 10-page original |

---

## Troubleshooting: no data for specific products

| Symptom | Fix |
|---|---|
| DNS / site traffic empty | `CF_ZONE_MAIN` not set, or domain not orange-cloud proxied |
| Web Vitals empty | `CF_ZONE_MAIN` not set, or CF Web Analytics not enabled on zone |
| KV empty | Account has no KV namespaces, or token lacks KV Read permission |
| D1 empty | Account has no D1 databases, or token lacks D1 Read permission |
| Queues empty | Account has no Queues, or token lacks Queues Read permission |
| Pages builds empty | `pagesProject` name in `config.js` doesn't match actual CF Pages project name |
| Worker logs empty | Token needs `Workers Observability` permission; Paid plan required |

Check `/health` endpoint — it shows which secrets are configured.