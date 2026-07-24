// E5 — Outbox events monitor: read-side endpoint.
// Returns per-database summaries + a combined list of stuck/dead rows
// across both mark8ly outbox tables.

import { NextResponse } from "next/server";
import { getOutboxOverview } from "@/lib/db/outbox-events";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const overview = await getOutboxOverview();
    return NextResponse.json(overview);
  } catch (err) {
    logger.error("[admin outbox GET] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
