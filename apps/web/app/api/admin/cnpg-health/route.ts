// E4 — CNPG cluster health: read endpoint.
//
// Backed by lib/metrics/cnpg-health which queries Prometheus directly
// (60s in-memory cache via the prometheus client). No DB hit.

import { NextResponse } from "next/server";
import { getCNPGClusterHealth } from "@/lib/metrics/cnpg-health";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const overview = await getCNPGClusterHealth();
    return NextResponse.json(overview);
  } catch (err) {
    logger.error("[admin cnpg-health GET] failed", err);
    return NextResponse.json({ error: "metrics_unavailable" }, { status: 500 });
  }
}
