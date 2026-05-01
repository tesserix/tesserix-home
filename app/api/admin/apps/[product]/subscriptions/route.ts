// GET /api/admin/apps/:product/subscriptions?filter=active|trial|past_due|cancelled
// Subscription list view + summary tiles. Auth via middleware.

import { NextResponse, type NextRequest } from "next/server";

import { mark8lyQuery } from "@/lib/db/mark8ly";
import {
  getSubscriptionsSummary,
  listSubscriptions,
  type SubscriptionListFilter,
  type SubscriptionRow,
} from "@/lib/db/mark8ly-billing";
import {
  daysIntoTrial,
  scoreTrialLikelihood,
  trialDaysRemaining,
  type TrialLikelihood,
} from "@/lib/metrics/trial-likelihood";
import { getProductConfig } from "@/lib/products/configs";
import { logger } from "@/lib/logger";

interface TenantNameRow {
  id: string;
  name: string;
}

interface SubscriptionListItem {
  tenantId: string;
  tenantName: string;
  plan: string;
  status: string;
  mrr: number;
  currency: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialDaysRemaining?: number | null;
  conversionLikelihood?: TrialLikelihood;
  dunningState?: "retrying" | "exhausted" | null;
}

function dunningStateFromStatus(status: string): "retrying" | "exhausted" | null {
  if (status === "past_due" || status === "incomplete") return "retrying";
  if (status === "unpaid") return "exhausted";
  return null;
}

function parseFilter(raw: string | null): SubscriptionListFilter {
  switch (raw) {
    case "active":
      return { status: "active" };
    case "trial":
      return { trialOnly: true };
    case "past_due":
      return { dunningOnly: true };
    case "cancelled":
      return { status: "canceled" };
    default:
      return {};
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

  const url = new URL(req.url);
  const filter = parseFilter(url.searchParams.get("filter"));

  try {
    const [summary, rows] = await Promise.all([
      getSubscriptionsSummary(),
      listSubscriptions(filter),
    ]);

    // Resolve tenant names in one cross-DB hop.
    const tenantIds = Array.from(new Set(rows.map((r) => r.tenant_id)));
    const namesById = new Map<string, string>();
    if (tenantIds.length > 0) {
      const namesRes = await mark8lyQuery<TenantNameRow>(
        "platform_api",
        `SELECT id::text, name FROM tenants WHERE id = ANY($1::uuid[])`,
        [tenantIds],
      );
      for (const r of namesRes.rows) namesById.set(r.id, r.name);
    }

    const items: SubscriptionListItem[] = rows.map((r: SubscriptionRow) => {
      const isTrial = r.plan === "trial" || r.status === "trialing";
      const item: SubscriptionListItem = {
        tenantId: r.tenant_id,
        tenantName: namesById.get(r.tenant_id) ?? r.tenant_id,
        plan: r.plan,
        status: r.status,
        mrr: r.status === "active" ? config.pricingByPlan![r.plan] ?? 0 : 0,
        currency: config.pricingCurrency!,
        currentPeriodEnd: r.current_period_end,
        cancelAtPeriodEnd: r.cancel_at_period_end,
        dunningState: dunningStateFromStatus(r.status),
      };
      if (isTrial) {
        item.trialDaysRemaining = trialDaysRemaining(r.current_period_end);
        item.conversionLikelihood = scoreTrialLikelihood({
          daysIntoTrial: daysIntoTrial(r.created_at),
          orderCount: 0, // TODO: plumb from orders table once Wave-5 lands
          lastSeenAt: null,
        });
      }
      return item;
    });

    return NextResponse.json({
      summary: {
        totalMrr: items.reduce((acc, i) => acc + i.mrr, 0),
        currency: config.pricingCurrency,
        activeCount: summary.totalActive,
        trialCount: summary.trialing,
        pastDueCount: summary.pastDue,
        cancelledThisMonth: summary.cancelledThisMonth,
      },
      rows: items,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error(`[subscriptions list] failed for ${product}`, err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
