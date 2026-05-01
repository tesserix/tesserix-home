// GET /api/admin/apps/:product/tenants/:id/billing
// Per-tenant subscription detail + plan history + recent invoices + lifetime
// revenue + margin (combines Phase 1 cost-proxy with Phase 2 revenue).

import { NextResponse, type NextRequest } from "next/server";

import {
  getLifetimeRevenueCents,
  getPlanChangeHistory,
  getRecentInvoiceEvents,
  getSubscription,
} from "@/lib/db/mark8ly-billing";
import { computeTenantMargin } from "@/lib/metrics/margin";
import { isValidWindow, type Window } from "@/lib/metrics/window";
import {
  daysIntoTrial,
  scoreTrialLikelihood,
  trialDaysRemaining,
} from "@/lib/metrics/trial-likelihood";
import { getProductConfig } from "@/lib/products/configs";
import { logger } from "@/lib/logger";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ product: string; id: string }> },
) {
  const { product, id } = await params;
  let config;
  try {
    config = getProductConfig(product);
  } catch {
    return NextResponse.json({ error: "unknown_product" }, { status: 404 });
  }
  if (!config.pricingByPlan || !config.pricingCurrency) {
    return NextResponse.json({ error: "billing_not_configured" }, { status: 404 });
  }

  const url = new URL(req.url);
  const rawWindow = url.searchParams.get("window") ?? "30d";
  const window: Window = isValidWindow(rawWindow) ? rawWindow : "30d";

  try {
    const [sub, planHistory, invoiceEvents, lifetimeCents, margin] = await Promise.allSettled([
      getSubscription(id),
      getPlanChangeHistory(id),
      getRecentInvoiceEvents(id),
      getLifetimeRevenueCents(id),
      computeTenantMargin(config, id, window),
    ]);

    const subscription = sub.status === "fulfilled" ? sub.value : null;
    const inTrial = subscription
      ? subscription.plan === "trial" || subscription.status === "trialing"
      : false;

    const trialBlock = inTrial && subscription
      ? {
          daysRemaining: trialDaysRemaining(subscription.current_period_end),
          conversionLikelihood: scoreTrialLikelihood({
            daysIntoTrial: daysIntoTrial(subscription.created_at),
            orderCount: 0,
            lastSeenAt: null,
          }),
        }
      : null;

    return NextResponse.json({
      subscription,
      trial: trialBlock,
      planHistory: planHistory.status === "fulfilled" ? planHistory.value : [],
      recentInvoices: invoiceEvents.status === "fulfilled" ? invoiceEvents.value : [],
      lifetimeRevenue:
        lifetimeCents.status === "fulfilled" && lifetimeCents.value > 0
          ? { amount: lifetimeCents.value / 100, currency: "USD" }
          : null,
      margin: margin.status === "fulfilled" ? margin.value : null,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error(`[tenant billing] failed for ${product}/${id}`, err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
