/**
 * CF Paid Plan Cost Calculator
 *
 * Official CF Workers Paid pricing (2026):
 *   Base plan:        $5.00 / month (includes 10M requests + 30M CPU-ms)
 *   Extra requests:   $0.30 / million  (after 10M/month included)
 *   Extra CPU time:   $0.02 / million ms (after 30M CPU-ms/month included)
 *   Pages builds:     500/month included in paid plan; $1.00 per 500 after
 *   Bandwidth:        FREE (CF Pages + Workers — no egress fees)
 *   Subrequests:      FREE (not billed separately)
 *
 * We push one CloudflareCost event per cron run with:
 *   - rolling 24hr estimated cost
 *   - rolling 7day estimated cost
 *   - rolling 30day estimated cost
 *   - projected yearly cost
 *   - all amounts in USD and INR
 *   - free tier % consumed (monthly basis)
 *
 * Proration logic:
 *   CF bills monthly. We extrapolate from the 5-minute window collected
 *   each cron run to estimate daily/weekly/monthly/yearly totals.
 *   The $5 base is included in the monthly figure only.
 *
 * INR rate:
 *   Fetched live from exchangerate-api (free tier, no key needed for base URL).
 *   Falls back to 95.0 if the request fails.
 */

const CF_PAID_BASE_USD       = 5.00;          // monthly base fee
const CF_INCLUDED_REQUESTS   = 10_000_000;    // per month
const CF_INCLUDED_CPU_MS     = 30_000_000;    // per month
const CF_INCLUDED_BUILDS     = 500;           // per month
const CF_RATE_REQUEST_USD    = 0.30 / 1_000_000;   // per request overage
const CF_RATE_CPU_MS_USD     = 0.02 / 1_000_000;   // per CPU-ms overage
const CF_RATE_BUILD_USD      = 1.00 / 500;          // per build overage

const MINUTES_PER_MONTH      = 60 * 24 * 30;

// Fallback INR rate if live fetch fails
const INR_FALLBACK            = 95.0;

/**
 * Fetch live USD→INR rate from open exchange endpoint
 */
export async function fetchINRRate() {
  try {
    const res = await fetch(
      "https://open.er-api.com/v6/latest/USD",
      { headers: { "Accept": "application/json" } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.INR;
    if (!rate || typeof rate !== "number") throw new Error("no INR rate in response");
    console.log(`[cf-cost] live INR rate: ${rate}`);
    return parseFloat(rate.toFixed(4));
  } catch (err) {
    console.warn(`[cf-cost] INR rate fetch failed (${err.message}), using fallback ${INR_FALLBACK}`);
    return INR_FALLBACK;
  }
}

/**
 * Compute cost estimates from a 5-minute metrics window.
 *
 * @param {object} params
 * @param {number} params.windowRequests   - worker invocations in last 5 min
 * @param {number} params.windowCpuMs      - total CPU ms in last 5 min
 * @param {number} params.monthlyBuilds    - total builds this month (from build metrics)
 * @param {number} params.inrRate          - live USD→INR rate
 * @returns {object} CloudflareCost event payload
 */
export function computeCost({ windowRequests, windowCpuMs, monthlyBuilds, inrRate, windowMinutes = 30 }) {
  // ── Extrapolate from cron window to monthly ─────────────────────────────────
  const scaleFactor = MINUTES_PER_MONTH / windowMinutes;

  const monthlyRequests = Math.round(windowRequests * scaleFactor);
  const monthlyCpuMs    = Math.round(windowCpuMs    * scaleFactor);

  // ── Monthly overage calculations ────────────────────────────────────────────
  const overageRequests = Math.max(0, monthlyRequests - CF_INCLUDED_REQUESTS);
  const overageCpuMs    = Math.max(0, monthlyCpuMs    - CF_INCLUDED_CPU_MS);
  const overageBuilds   = Math.max(0, (monthlyBuilds  ?? 0) - CF_INCLUDED_BUILDS);

  const monthlyCostRequests = overageRequests * CF_RATE_REQUEST_USD;
  const monthlyCostCpuMs    = overageCpuMs    * CF_RATE_CPU_MS_USD;
  const monthlyCostBuilds   = overageBuilds   * CF_RATE_BUILD_USD;
  const monthlyUsageCost    = monthlyCostRequests + monthlyCostCpuMs + monthlyCostBuilds;
  const monthlyCostUSD      = CF_PAID_BASE_USD + monthlyUsageCost;

  // ── Scale to other periods ───────────────────────────────────────────────────
  // Daily = monthly usage cost / 30  (base fee not counted daily, billed monthly)
  const dailyCostUSD    = monthlyUsageCost / 30;
  const weeklyCostUSD   = monthlyUsageCost / 30 * 7;
  const yearlyCostUSD   = monthlyCostUSD * 12;

  // ── Free tier consumption % ──────────────────────────────────────────────────
  const freeTierRequestsPct = Math.min(100, parseFloat(((monthlyRequests / CF_INCLUDED_REQUESTS) * 100).toFixed(1)));
  const freeTierCpuMsPct    = Math.min(100, parseFloat(((monthlyCpuMs    / CF_INCLUDED_CPU_MS)    * 100).toFixed(1)));
  const freeTierBuildsPct   = Math.min(100, parseFloat((((monthlyBuilds ?? 0) / CF_INCLUDED_BUILDS) * 100).toFixed(1)));

  // ── INR conversions ──────────────────────────────────────────────────────────
  const r = inrRate;
  const round2 = (n) => parseFloat(n.toFixed(2));

  return {
    // USD
    dailyCostUSD:         round2(dailyCostUSD),
    weeklyCostUSD:        round2(weeklyCostUSD),
    monthlyCostUSD:       round2(monthlyCostUSD),
    yearlyCostUSD:        round2(yearlyCostUSD),
    // INR
    dailyCostINR:         round2(dailyCostUSD  * r),
    weeklyCostINR:        round2(weeklyCostUSD * r),
    monthlyCostINR:       round2(monthlyCostUSD * r),
    yearlyCostINR:        round2(yearlyCostUSD  * r),
    // Breakdown (monthly USD)
    basePlanUSD:          round2(CF_PAID_BASE_USD),
    requestsCostUSD:      round2(monthlyCostRequests),
    cpuCostUSD:           round2(monthlyCostCpuMs),
    buildsCostUSD:        round2(monthlyCostBuilds),
    // Projected monthly usage (extrapolated)
    projectedMonthlyRequests: monthlyRequests,
    projectedMonthlyCpuMs:    monthlyCpuMs,
    // Free tier %
    freeTierRequestsPct,
    freeTierCpuMsPct,
    freeTierBuildsPct,
    // Meta
    usdToInrRate:         r,
    windowRequests,
    windowCpuMs,
    monthlyBuilds:        monthlyBuilds ?? 0,
    // Included thresholds (for dashboard reference lines)
    includedRequestsPerMonth: CF_INCLUDED_REQUESTS,
    includedCpuMsPerMonth:    CF_INCLUDED_CPU_MS,
    includedBuildsPerMonth:   CF_INCLUDED_BUILDS,
  };
}
