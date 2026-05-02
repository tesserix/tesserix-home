// M1 — internal probe trigger. Called by the in-cluster cron every
// 5 minutes. Bearer-authed via INTERNAL_API_TOKEN, same as other
// /api/internal/* routes.

import { NextResponse, type NextRequest } from "next/server";
import { runProbeSweep } from "@/lib/uptime/runner";
import { logger } from "@/lib/logger";

function authorize(req: NextRequest): boolean {
  const expected = (process.env.INTERNAL_API_TOKEN ?? "").trim();
  if (!expected) return false;
  const supplied = (req.headers.get("x-internal-token") ?? "").trim();
  return supplied !== "" && supplied === expected;
}

export async function POST(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const summary = await runProbeSweep();
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    logger.error("[uptime probe] sweep failed", err);
    return NextResponse.json(
      { error: "sweep_failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 500 },
    );
  }
}
