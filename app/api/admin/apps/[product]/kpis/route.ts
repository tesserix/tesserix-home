// Business KPI roll-ups for a product's admin overview (e.g. HomeChef:
// active chefs / orders today / GMV / pending approvals). Serves the
// `/api/admin/apps/<product>/kpis` URL. Resolves the product from the
// registry; products without a KPI implementation (mark8ly reads its KPIs
// from the shared dashboard) return an empty map. Degrades gracefully — a
// missing DB env or a query failure yields empty KPIs (tiles show "—")
// rather than a hard error.

import { NextResponse, type NextRequest } from "next/server";

import { getProductConfig } from "@/lib/products/configs";
import { homechefDbConfigured, homechefQuery } from "@/lib/db/homechef";
import { logger } from "@/lib/logger";

export interface KpiValue {
  value: string;
  hint?: string;
}

interface CountRow {
  n: string;
}

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

async function homechefKpis(): Promise<Record<string, KpiValue>> {
  if (!homechefDbConfigured()) return {};

  const [activeChefs, ordersToday, gmvToday, pendingApprovals] = await Promise.all([
    homechefQuery<CountRow>(
      `SELECT count(*)::bigint AS n FROM chef_profiles WHERE is_active = true AND is_verified = true`,
    ),
    homechefQuery<CountRow>(
      `SELECT count(*)::bigint AS n FROM orders WHERE created_at >= date_trunc('day', now())`,
    ),
    homechefQuery<CountRow>(
      `SELECT COALESCE(sum(total), 0)::numeric AS n FROM orders
         WHERE created_at >= date_trunc('day', now()) AND payment_status = 'completed'`,
    ),
    homechefQuery<CountRow>(
      `SELECT count(*)::bigint AS n FROM chef_profiles WHERE is_verified = false`,
    ),
  ]);

  return {
    active_chefs: { value: Number(activeChefs.rows[0]?.n ?? 0).toLocaleString("en-IN") },
    orders_today: { value: Number(ordersToday.rows[0]?.n ?? 0).toLocaleString("en-IN") },
    gmv_today: { value: inr.format(Number(gmvToday.rows[0]?.n ?? 0)), hint: "paid orders today" },
    pending_approvals: { value: Number(pendingApprovals.rows[0]?.n ?? 0).toLocaleString("en-IN") },
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ product: string }> },
) {
  const { product } = await params;

  try {
    getProductConfig(product);
  } catch {
    return NextResponse.json({ error: "unknown_product" }, { status: 404 });
  }

  let kpis: Record<string, KpiValue> = {};
  try {
    if (product === "homechef") {
      kpis = await homechefKpis();
    }
  } catch (err) {
    // Don't fail the overview — log and return empty so tiles render "—".
    logger.error(`[product-kpis] aggregation failed for ${product}`, err);
    kpis = {};
  }

  return NextResponse.json({ kpis });
}
