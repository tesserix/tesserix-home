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
import { chQuery, clickhouseConfigured } from "@/lib/db/clickhouse";
import { tesserixQuery } from "@/lib/db/tesserix";
import { logger } from "@/lib/logger";
import type { AdminStats } from "@/lib/products/homechef/contracts";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ product: string }> },
) {
  const { product } = await params;

  // DevAI has no tenant/store model — its overview KPIs are its own OTel
  // telemetry (ClickHouse: root-span traces / errors / p95 over the last 24h)
  // plus open platform incidents. Each lookup degrades to 0 independently so a
  // ClickHouse or DB blip doesn't blank the whole tile set.
  if (product === "devai") {
    const out: Record<string, number> = {
      requests_24h: 0,
      errors_24h: 0,
      p95_ms: 0,
      incidents_open: 0,
    };
    if (clickhouseConfigured()) {
      try {
        const base =
          "FROM otel.otel_traces WHERE ParentSpanId = '' " +
          "AND Timestamp >= now() - INTERVAL 24 HOUR AND ServiceName LIKE 'devai%'";
        const rows = await chQuery<{ requests: number; errors: number; p95Ms: number }>(
          `SELECT count() AS requests, countIf(StatusCode = 'Error') AS errors,
                  round(quantile(0.95)(Duration)/1e6, 0) AS p95Ms ${base}`,
        );
        const a = rows[0];
        if (a) {
          out.requests_24h = Number(a.requests) || 0;
          out.errors_24h = Number(a.errors) || 0;
          out.p95_ms = Number(a.p95Ms) || 0;
        }
      } catch (err) {
        logger.warn(`[devai-kpis] clickhouse: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    try {
      const r = await tesserixQuery<{ n: number }>(
        "SELECT count(*)::int AS n FROM platform_tickets WHERE product_id = $1 AND status IN ('open','in_progress')",
        ["devai"],
      );
      out.incidents_open = Number(r.rows[0]?.n) || 0;
    } catch (err) {
      logger.warn(`[devai-kpis] incidents: ${err instanceof Error ? err.message : "failed"}`);
    }
    return NextResponse.json(out);
  }

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
