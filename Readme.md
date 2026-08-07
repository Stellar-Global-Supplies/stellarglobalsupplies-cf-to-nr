# Stellar Global Supplies — Cloudflare → New Relic Monitor

Cron Worker (every 3 min) that pushes CF Pages + Workers metrics to New Relic.
Uses **CF Secrets Store** (wrangler v4+, compatibility_date 2025-04-01).

---

## How to get your Cloudflare credentials

### CF Account ID
1. Log into https://dash.cloudflare.com
2. Click any domain or go to **Workers & Pages**
3. Look at the URL — it contains your account ID:
   `https://dash.cloudflare.com/YOUR_ACCOUNT_ID/workers`
4. Or: right sidebar on any page shows **Account ID** under your name

### CF API Token
1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click **Create Token**
3. Use **"Create Custom Token"** (not a template)
4. Set these permissions:
   | Permission | Level | Access |
   |---|---|---|
   | Account Analytics | Account | Read |
   | Workers Scripts | Account | Read |
   | Cloudflare Pages | Account | Read |
5. Set **Account Resources** → Include → your account
6. Click **Continue to Summary** → **Create Token**
7. Copy the token — you only see it once

---

## Setup

### 1. Install wrangler v4+
```bash
npm install
# confirms wrangler ^4.x.x is installed
```

### 2. Add secrets to CF Secrets Store
Your store ID is already in wrangler.toml: `2556bcd9458349f6b4ff2a3fc93bdba1`.
Each secret is bound directly to `env.<NAME>` via `[[secrets_store_secrets]]` in wrangler.toml.

Add the missing secrets via CF Dashboard:
**CF Dashboard → Workers & Pages → Secrets Store → your store → Add secret**

| Secret name | Value |
|---|---|
| `NEW_RELIC_LICENSE_KEY` | ✅ already set by you |
| `CF_API_TOKEN` | token from step above |
| `CF_ACCOUNT_ID` | your CF numeric account ID |
| `NR_ACCOUNT_ID` | your New Relic account ID (numeric) |

Or via wrangler CLI (alternative):
```bash
# wrangler v4 secrets store CLI
npx wrangler secrets-store secret put CF_API_TOKEN \
  --store-id 2556bcd9458349f6b4ff2a3fc93bdba1

npx wrangler secrets-store secret put CF_ACCOUNT_ID \
  --store-id 2556bcd9458349f6b4ff2a3fc93bdba1

npx wrangler secrets-store secret put NR_ACCOUNT_ID \
  --store-id 2556bcd9458349f6b4ff2a3fc93bdba1
```

### 3. Deploy
```bash
npm run deploy
```

### 4. Verify
```bash
# Watch live logs of the cron worker
npm run tail
```
Or manually trigger: **CF Dashboard → Workers & Pages → stellar-nr-monitor → Triggers → Run**

---

## Import New Relic Dashboard
1. New Relic → **Dashboards** → **Import dashboard**
2. Paste contents of `dashboard.json`
3. Click **Import**

---

## CF Platform Usage in New Relic (observability events, build minutes, neurons)

CF exposes platform-level usage via its **GraphQL Analytics API** — the same API
this worker already uses. Here's what's available and how we can add it:

### What CF exposes
| Metric | CF GraphQL field | Notes |
|---|---|---|
| Worker invocations | `workersInvocationsAdaptive.sum.requests` | ✅ already collected |
| Worker CPU time | `workersInvocationsAdaptive.quantiles.cpuTimeP99` | ✅ already collected |
| Worker errors | `workersInvocationsAdaptive.sum.errors` | ✅ already collected |
| Pages build minutes | `pagesBuildMinutes` | Available at account level |
| Pages builds (success/fail) | `pagesBuildResults` | Per project, with status |
| Workers observability events | CF Logpush / Workers Logs API | Requires Logpush setup |
| AI Gateway neurons (tokens) | `aiGatewayRequests` | If using CF AI Gateway |
| D1 database reads/writes | `d1AnalyticsAdaptiveGroups` | If using CF D1 |
| R2 storage requests | `r2OperationsAdaptiveGroups` | If using CF R2 |
| Account bandwidth | `httpRequestsAdaptiveGroups` | Zone-level |

### To add Pages build minutes + build status
Add this query to `cf-pages.js` and a new event type `CloudflarePagesBuilds`:
```js
query PagesBuildMetrics($accountId: String!, $since: String!, $until: String!) {
  viewer {
    accounts(filter: { accountTag: $accountId }) {
      pagesBuildResultsAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: 100
      ) {
        sum { buildMinutes }
        count
        dimensions { projectName, status }
      }
    }
  }
}
```
Events would include: `projectName`, `buildStatus` (success/failure/cancelled),
`buildMinutes`, `buildCount` — visible in NR as a table per project.

### CF Neurons (AI Gateway)
Only available if you route LLM calls through CF AI Gateway.
If `stellar-ai-worker` uses CF AI Gateway, add:
```js
aiGatewayRequestsAdaptiveGroups(
  filter: { datetime_geq: $since, datetime_leq: $until }
  limit: 100
) {
  sum { tokensIn tokensOut requests }
  dimensions { gatewayId, model, provider }
}
```

### Workers observability events (logs)
CF Workers Logs (the events you see in the CF dashboard "Logs" tab) are available
via **CF Logpush** → push to an HTTP endpoint (another Worker) → forward to NR.
This is a separate pipeline — let me know if you want to add this.

---

## Adding a new app in future
Edit `src/config.js`, add to `APP_MAP`:
```js
{
  appName: "stellar-new-platform",
  pagesProject: "cf-pages-project-name",
  domain: "new.stellarglobalsupplies.com",
  workers: ["new-worker-name"],
},
```
Redeploy: `npm run deploy` — no other changes needed.

---

## File structure
```
src/
├── index.js       — cron handler, reads secrets from CF Secrets Store
├── config.js      — APP_MAP (add apps/workers here)
├── cf-pages.js    — CF Pages Analytics GraphQL queries
├── cf-workers.js  — CF Workers Metrics GraphQL queries
├── nr.js          — New Relic Event API pusher + event builders
└── utils.js       — helpers (retry, time window, chunking)

dashboard.json     — import into New Relic UI
wrangler.toml      — cron schedule, per-secret store bindings, compat date
package.json       — wrangler v4+
```