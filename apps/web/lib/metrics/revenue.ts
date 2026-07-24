// Revenue aggregator. MRR is computed in tesserix-home from each tenant's
// plan × ProductConfig.pricingByPlan. mark8ly's DB has no pricing table —
// pricing lives in this repo, sourced from Stripe. Update the config map
// whenever Stripe prices change.
//
// We count only `status='active'` toward MRR. Trialing subs aren't
// generating revenue yet; past_due subs are at risk and excluded
// conservatively. This is documented in CONTEXT.md and surfaced inline
// via the cost-honesty pattern.

import {
  countCancelledSince,
  countNewTrialsSince,
  listSubscriptions,
  type SubscriptionRow,
} from "@/lib/db/mark8ly-billing";
import type { ProductConfig } from "@/lib/products/types";

export interface RevenueMetrics {
  readonly currency: string;
  readonly mrr: number;
  readonly arr: number;
  readonly activeCount: number;
  readonly newTrials30d: number;
  readonly cancelled30d: number;
  readonly churnRate: number; // ratio: cancelled / activeAtStart
}

export function computeMrr(config: ProductConfig, subs: ReadonlyArray<SubscriptionRow>): number {
  const prices = config.pricingByPlan;
  if (!prices) return 0;
  let mrr = 0;
  for (const sub of subs) {
    if (sub.status !== "active") continue;
    const price = prices[sub.plan];
    if (typeof price === "number") mrr += price;
  }
  return mrr;
}

export async function getRevenueMetrics(config: ProductConfig, days = 30): Promise<RevenueMetrics | null> {
  if (!config.pricingByPlan || !config.pricingCurrency) return null;

  const [activeSubs, newTrials, cancelled] = await Promise.all([
    listSubscriptions({ status: "active", limit: 1000 }),
    countNewTrialsSince(days),
    countCancelledSince(days),
  ]);

  const mrr = computeMrr(config, activeSubs);
  const arr = mrr * 12;
  const baselineForChurn = activeSubs.length + cancelled;
  const churnRate = baselineForChurn > 0 ? cancelled / baselineForChurn : 0;

  return {
    currency: config.pricingCurrency,
    mrr,
    arr,
    activeCount: activeSubs.length,
    newTrials30d: newTrials,
    cancelled30d: cancelled,
    churnRate,
  };
}
