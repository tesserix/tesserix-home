// GET /api/admin/apps/:product/subscriptions?filter=active|trial|past_due|cancelled
// Subscription list view. The page shows ALL tenants for the product —
// tenants without a store_subscriptions row are treated as trial (mark8ly's
// default for un-onboarded merchants per migration 41 + 42). Auth via middleware.

import { NextResponse, type NextRequest } from "next/server";

import {
  getSubscriptionsSummary,
  listAllTenants,
  listSubscriptions,
  type SubscriptionRow,
  type TenantBasicRow,
} from "@/lib/db/mark8ly-billing";
import {
  daysIntoTrial,
  scoreTrialLikelihood,
  trialDaysRemaining,
  type TrialLikelihood,
} from "@/lib/metrics/trial-likelihood";
import { getProductConfig } from "@/lib/products/configs";
import { logger } from "@/lib/logger";

interface SubscriptionListItem {
  tenantId: string;
  tenantName: string;
  plan: string;
  status: string;
  mrr: number;
  currency: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasSubscription: boolean;
  trialDaysRemaining?: number | null;
  conversionLikelihood?: TrialLikelihood;
  dunningState?: "retrying" | "exhausted" | null;
}

type Filter = "all" | "active" | "trial" | "past_due" | "cancelled";

function parseFilter(raw: string | null): Filter {
  if (raw === "active" || raw === "trial" || raw === "past_due" || raw === "cancelled") {
    return raw;
  }
  return "all";
}

function dunningStateFromStatus(status: string): "retrying" | "exhausted" | null {
  if (status === "past_due" || status === "incomplete") return "retrying";
  if (status === "unpaid") return "exhausted";
  return null;
}

const TYPICAL_TRIAL_DAYS = 14;

// Build a synthetic trial subscription view for tenants without a real
// store_subscriptions row. They're effectively trialing from creation +14d.
function synthesizeTrialItem(tenant: TenantBasicRow, currency: string): SubscriptionListItem {
  const created = new Date(tenant.created_at);
  const trialEnd = new Date(created.getTime() + TYPICAL_TRIAL_DAYS * 24 * 60 * 60 * 1000);
  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    plan: "trial",
    status: "trialing",
    mrr: 0,
    currency,
    currentPeriodEnd: trialEnd.toISOString(),
    cancelAtPeriodEnd: false,
    hasSubscription: false,
    trialDaysRemaining: trialDaysRemaining(trialEnd.toISOString()),
    conversionLikelihood: scoreTrialLikelihood({
      daysIntoTrial: daysIntoTrial(tenant.created_at),
      orderCount: 0,
      lastSeenAt: null,
    }),
    dunningState: null,
  };
}

function realItemFromSub(
  sub: SubscriptionRow,
  tenant: TenantBasicRow | undefined,
  pricingByPlan: Readonly<Record<string, number>>,
  currency: string,
): SubscriptionListItem {
  const isTrial = sub.plan === "trial" || sub.status === "trialing";
  const item: SubscriptionListItem = {
    tenantId: sub.tenant_id,
    tenantName: tenant?.name ?? sub.tenant_id,
    plan: sub.plan,
    status: sub.status,
    mrr: sub.status === "active" ? pricingByPlan[sub.plan] ?? 0 : 0,
    currency,
    currentPeriodEnd: sub.current_period_end,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    hasSubscription: true,
    dunningState: dunningStateFromStatus(sub.status),
  };
  if (isTrial) {
    item.trialDaysRemaining = trialDaysRemaining(sub.current_period_end);
    item.conversionLikelihood = scoreTrialLikelihood({
      daysIntoTrial: daysIntoTrial(sub.created_at),
      orderCount: 0,
      lastSeenAt: null,
    });
  }
  return item;
}

function applyFilter(items: ReadonlyArray<SubscriptionListItem>, filter: Filter): SubscriptionListItem[] {
  switch (filter) {
    case "active":
      return items.filter((i) => i.status === "active");
    case "trial":
      return items.filter((i) => i.plan === "trial" || i.status === "trialing");
    case "past_due":
      return items.filter((i) => i.dunningState != null);
    case "cancelled":
      return items.filter((i) => i.status === "canceled");
    case "all":
    default:
      return [...items];
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ product: string }> },
) {
  const { product } = await params;
  let config;
  try {
    config = getProductConfig(product);
  } catch {
    return NextResponse.json({ error: "unknown_product" }, { status: 404 });
  }
  if (!config.pricingByPlan || !config.pricingCurrency) {
    return NextResponse.json({ error: "billing_not_configured" }, { status: 404 });
  }
  const pricingByPlan = config.pricingByPlan;
  const currency = config.pricingCurrency;

  const url = new URL(req.url);
  const filter = parseFilter(url.searchParams.get("filter"));

  try {
    const [summary, subs, tenants] = await Promise.all([
      getSubscriptionsSummary(),
      listSubscriptions({ limit: 1000 }),
      listAllTenants(),
    ]);

    const subsByTenantId = new Map<string, SubscriptionRow>();
    for (const s of subs) subsByTenantId.set(s.tenant_id, s);
    const tenantsById = new Map<string, TenantBasicRow>();
    for (const t of tenants) tenantsById.set(t.id, t);

    // Merge: every tenant gets a row. Real subscription if present, else
    // synthetic trial.
    const allItems: SubscriptionListItem[] = tenants.map((t) => {
      const sub = subsByTenantId.get(t.id);
      return sub
        ? realItemFromSub(sub, t, pricingByPlan, currency)
        : synthesizeTrialItem(t, currency);
    });

    // Subscriptions whose tenant got hard-deleted from platform DB but
    // billing_archive still references them; surface them so they're not
    // invisible.
    for (const s of subs) {
      if (!tenantsById.has(s.tenant_id)) {
        allItems.push(realItemFromSub(s, undefined, pricingByPlan, currency));
      }
    }

    const filtered = applyFilter(allItems, filter);

    // Recompute trial count to include synthesized rows.
    const trialCount = allItems.filter(
      (i) => i.plan === "trial" || i.status === "trialing",
    ).length;

    return NextResponse.json({
      summary: {
        totalMrr: allItems.reduce((acc, i) => acc + i.mrr, 0),
        currency,
        activeCount: summary.totalActive,
        trialCount,
        pastDueCount: summary.pastDue,
        cancelledThisMonth: summary.cancelledThisMonth,
      },
      rows: filtered,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error(`[subscriptions list] failed for ${product}`, err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
