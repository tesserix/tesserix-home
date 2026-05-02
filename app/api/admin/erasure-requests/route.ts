// F3 — read-only listing of GDPR erasure requests across mark8ly tenants.
// Session-authed via the global middleware.

import { NextResponse, type NextRequest } from "next/server";
import {
  getErasureRequestsSummary,
  listErasureRequests,
  type ListFilter,
} from "@/lib/db/erasure-requests";
import { logger } from "@/lib/logger";

const ALLOWED_STATUS: ReadonlyArray<NonNullable<ListFilter["status"]>> = [
  "pending",
  "processing",
  "completed",
  "failed",
  "all",
];

function parseStatus(raw: string | null): ListFilter["status"] {
  if (raw && (ALLOWED_STATUS as readonly string[]).includes(raw)) {
    return raw as ListFilter["status"];
  }
  return "pending";
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const status = parseStatus(url.searchParams.get("status"));
  try {
    const [summary, rows] = await Promise.all([
      getErasureRequestsSummary(),
      listErasureRequests({ status, limit: 200 }),
    ]);
    return NextResponse.json({
      summary,
      rows,
      filter: { status },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("[erasure-requests GET] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
