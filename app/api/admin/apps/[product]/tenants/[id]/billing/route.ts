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
import { mark8lyQuery } from "@/lib/db/mark8ly";
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

    let subscription = sub.status === "fulfilled" ? sub.value : null;
    let synthesized = false;

    // Tenant exists but no store_subscriptions row → synthesize a trial
    // (mark8ly default — un-onboarded tenants are effectively trialing).
    // Wrapped so a synthesis failure can't take down the whole route — we
    // still want to return planHistory / invoices / margin if those succeeded.
    if (!subscription) {
      try {
        const tenantRes = await mark8lyQuery<{ created_at: string }>(
          "platform_api",
          `SELECT created_at::text FROM tenants WHERE id = $1::uuid`,
          [id],
        );
        const tenantCreated = tenantRes.rows[0]?.created_at;
        if (tenantCreated) {
          const trialDays = config.trialDays ?? 14;
          const trialEnd = new Date(new Date(tenantCreated).getTime() + trialDays * 24 * 60 * 60 * 1000);
          subscription = {
            id: "synthetic-" + id,
            tenant_id: id,
            store_id: "",
            stripe_customer_id: null,
            stripe_subscription_id: null,
            plan: "trial",
            status: "trialing",
            current_period_start: tenantCreated,
            current_period_end: trialEnd.toISOString(),
            cancel_at_period_end: false,
            created_at: tenantCreated,
            updated_at: tenantCreated,
          };
          synthesized = true;
        }
      } catch (synthErr) {
        logger.warn(`[tenant billing] synthesis failed for ${product}/${id}`, synthErr);
      }
    }

    const inTrial = subscription
      ? subscription.plan === "trial" || subscription.status === "trialing"
      : false;

    // If period end isn't stored, derive from created_at + product trial length.
    const effectivePeriodEnd =
      subscription?.current_period_end ??
      (inTrial && subscription
        ? new Date(
            new Date(subscription.created_at).getTime() +
              (config.trialDays ?? 14) * 24 * 60 * 60 * 1000,
          ).toISOString()
        : null);

    const trialBlock = inTrial && subscription
      ? {
          daysRemaining: trialDaysRemaining(effectivePeriodEnd),
          conversionLikelihood: scoreTrialLikelihood({
            daysIntoTrial: daysIntoTrial(subscription.created_at),
            orderCount: 0,
            lastSeenAt: null,
          }),
        }
      : null;

    return NextResponse.json({
      subscription: subscription
        ? { ...subscription, current_period_end: effectivePeriodEnd }
        : null,
      synthesized,
      currency: config.pricingCurrency,
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
