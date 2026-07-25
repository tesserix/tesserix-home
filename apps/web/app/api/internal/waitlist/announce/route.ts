// POST /api/internal/waitlist/announce — runs the automatic launch
// announcement: any product now live but never announced gets emailed to its
// waitlist.
//
// Meant to be called by a scheduler (and/or a post-deploy hook). The work is
// idempotent — the announcement claim and the per-recipient notified_at mean
// calling this every five minutes forever sends each person exactly one email.
//
// Auth: the same shared X-Internal-Token as the other internal routes.
//
// ?dry_run=1 reports who WOULD be emailed and changes nothing — use it to
// sanity-check a launch before flipping the product's status.

import { NextResponse, type NextRequest } from "next/server";

import { announcePendingLaunches } from "@/lib/waitlist/announce";
import { logger } from "@/lib/logger";

function authorize(req: NextRequest): boolean {
  // X-Internal-Token (not Authorization Bearer) — mirrors the platform-tickets
  // and platform-announcements internal routes.
  const expected = (process.env.INTERNAL_API_TOKEN ?? "").trim();
  if (!expected) return false;
  const supplied = (req.headers.get("x-internal-token") ?? "").trim();
  return supplied !== "" && supplied === expected;
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";

  try {
    const result = await announcePendingLaunches({ dryRun });
    return NextResponse.json(result);
  } catch (error) {
    logger.error("[internal waitlist announce] failed", { error });
    return NextResponse.json({ error: "announce_failed" }, { status: 500 });
  }
}
