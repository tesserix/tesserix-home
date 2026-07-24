// E1 — Onboarding funnel data for the per-product onboarding page.
// Currently only mark8ly is implemented; other products would slot in
// here when their onboarding tables exist.

import { NextResponse, type NextRequest } from "next/server";
import {
  getOnboardingFunnelStats,
  listOnboardingSessions,
  type ListSessionsFilter,
} from "@/lib/db/mark8ly-onboarding";
import { logger } from "@/lib/logger";

const ALLOWED_STATUS: ReadonlyArray<NonNullable<ListSessionsFilter["status"]>> = [
  "in_flight",
  "completed",
  "abandoned",
  "all",
];

function parseStatus(raw: string | null): ListSessionsFilter["status"] {
  if (raw && (ALLOWED_STATUS as readonly string[]).includes(raw)) {
    return raw as ListSessionsFilter["status"];
  }
  return "in_flight";
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ product: string }> },
) {
  const { product } = await params;
  if (product !== "mark8ly") {
    return NextResponse.json({ error: "unsupported_product" }, { status: 404 });
  }
  const url = new URL(req.url);
  const status = parseStatus(url.searchParams.get("status"));
  try {
    const [stats, sessions] = await Promise.all([
      getOnboardingFunnelStats(),
      listOnboardingSessions({ status, limit: 200 }),
    ]);
    return NextResponse.json({
      stats,
      sessions,
      filter: { status },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("[onboarding GET] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
