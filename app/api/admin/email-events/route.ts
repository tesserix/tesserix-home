// Phase 1 Wave 1.5 — read endpoint for email_events.
// Powers the dashboards (Mark8ly Overview email volume, Tenant Detail
// engagement, future E2 notification log).

import { NextResponse, type NextRequest } from "next/server";
import {
  aggregateEmailMetrics,
  listRecentEmailEvents,
} from "@/lib/db/email-events";
import { logger } from "@/lib/logger";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const product = url.searchParams.get("product") ?? undefined;
  const tenantId = url.searchParams.get("tenant_id") ?? undefined;
  const days = url.searchParams.get("days")
    ? Number(url.searchParams.get("days"))
    : 30;
  const view = url.searchParams.get("view") ?? "metrics"; // 'metrics' | 'recent'
  const limit = url.searchParams.get("limit")
    ? Number(url.searchParams.get("limit"))
    : 100;

  try {
    if (view === "recent") {
      const events = await listRecentEmailEvents({ product, tenantId, limit });
      return NextResponse.json({ events });
    }
    const rows = await aggregateEmailMetrics({ product, tenantId, days });
    return NextResponse.json({ days, rows });
  } catch (err) {
    logger.error("[admin email-events GET] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
