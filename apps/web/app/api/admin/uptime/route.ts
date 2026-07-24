// M1 — read-side endpoint for the uptime page. Returns one row per
// (product, tenant, hostname) with rolling uptime + latency for the
// requested window.

import { NextResponse, type NextRequest } from "next/server";
import { getTenantUptimeSummary } from "@/lib/db/uptime-probes";
import { logger } from "@/lib/logger";

const ALLOWED_WINDOWS = [1, 6, 24, 24 * 7];

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const raw = Number(url.searchParams.get("hours") ?? "24");
  const hours = ALLOWED_WINDOWS.includes(raw) ? raw : 24;
  try {
    const rows = await getTenantUptimeSummary({ hours });
    return NextResponse.json({
      hours,
      rows,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("[admin uptime GET] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
