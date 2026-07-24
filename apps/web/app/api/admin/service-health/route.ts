// E3 — Service health snapshot: read-side endpoint.
// Aggregates per-workload pod readiness and restart counts via Prometheus.

import { NextResponse } from "next/server";
import { getServiceHealthOverview } from "@/lib/metrics/service-health";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const overview = await getServiceHealthOverview();
    return NextResponse.json(overview);
  } catch (err) {
    logger.error("[admin service-health GET] failed", err);
    return NextResponse.json({ error: "prometheus_unavailable" }, { status: 500 });
  }
}
