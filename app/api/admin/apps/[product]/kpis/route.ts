// GET /api/admin/apps/:product/kpis
// Product-scoped business KPIs for the overview's KPI tiles, returned as a
// { [tileKey]: number } map. For homechef these now come from the Go /admin/stats
// API (signed gateway) instead of a direct homechef_db read — single source of
// truth, side-effects preserved. Unknown products return {} so the overview
// falls back to the platform dashboard (mark8ly path unaffected).
//
// Auth: gated by middleware.ts (default-deny /api/* without an admin session).
import { NextResponse } from "next/server";

import { HomechefAdminError, homechefAdmin } from "@/lib/api/homechef-admin";
import { logger } from "@/lib/logger";
import type { AdminStats } from "@/lib/products/homechef/contracts";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ product: string }> },
) {
  const { product } = await params;
  if (product !== "homechef") {
    return NextResponse.json({});
  }
  try {
    const { data } = await homechefAdmin<AdminStats>("GET", "/stats");
    return NextResponse.json({
      chefs_active: data.totalChefs ?? 0,
      orders_today: data.ordersToday ?? 0,
      gmv_today: data.revenueToday ?? 0,
      approvals_pending: data.pendingVerifications ?? 0,
    });
  } catch (err) {
    // Degrade gracefully — the overview falls back to "—" tiles rather than
    // erroring the whole page if the API is unreachable / not configured.
    if (err instanceof HomechefAdminError) {
      logger.warn(`[homechef-kpis] ${err.code} (${err.status})`);
    } else {
      logger.error("[homechef-kpis] failed", err);
    }
    return NextResponse.json({});
  }
}
