// Per-tenant margin = subscription revenue − infra cost proxy.
// Both inputs are honest approximations:
//   revenue: plan price from ProductConfig (Stripe is source of truth)
//   infraCost: Phase 1 cost-proxy (weighted blend of activity signals)
// UI explicitly labels the result "Estimated" with an info tooltip.

import { computeTenantCostShare } from "./cost-proxy";
import { getSubscription } from "@/lib/db/mark8ly-billing";
import type { Window } from "./window";
import type { ProductConfig } from "@/lib/products/types";

export interface TenantMargin {
  readonly currency: string;
  readonly revenue: number;
  readonly infraCost: number;
  readonly margin: number;
  readonly inTrial: boolean;
  readonly hasSubscription: boolean;
}

const WINDOW_TO_MONTH_RATIO: Readonly<Record<Window, number>> = {
  "1h": 1 / 720,
  "24h": 1 / 30,
  "7d": 7 / 30,
  "30d": 1,
};

export async function computeTenantMargin(
  config: ProductConfig,
  tenantId: string,
  window: Window,
): Promise<TenantMargin | null> {
  if (!config.pricingByPlan || !config.pricingCurrency) return null;

  const sub = await getSubscription(tenantId);
  if (!sub) {
    // No subscription row — show empty margin (revenue 0, cost still real).
    const cost = await computeTenantCostShare(config, tenantId, window);
    return {
      currency: config.pricingCurrency,
      revenue: 0,
      infraCost: cost.estimatedCost,
      margin: -cost.estimatedCost,
      inTrial: false,
      hasSubscription: false,
    };
  }

  const planPrice = config.pricingByPlan[sub.plan] ?? 0;
  const ratio = WINDOW_TO_MONTH_RATIO[window];
  const revenue = sub.status === "active" ? planPrice * ratio : 0;
  const inTrial = sub.plan === "trial" || sub.status === "trialing";

  const cost = await computeTenantCostShare(config, tenantId, window);

  return {
    currency: config.pricingCurrency,
    revenue,
    infraCost: cost.estimatedCost,
    margin: revenue - cost.estimatedCost,
    inTrial,
    hasSubscription: true,
  };
}
