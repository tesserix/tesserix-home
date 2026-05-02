// M2 — Refresh cert status for a custom domain.
//
// Proxies to mark8ly marketplace-api-admin's
// /internal/domains/:id/refresh-status. Same auth posture as the
// verify proxy — istio AuthorizationPolicy gates access.

import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/logger";

const MARKETPLACE_API_URL =
  process.env.MARK8LY_MARKETPLACE_API_URL ??
  "http://mark8ly-marketplace-api-admin.mark8ly.svc.cluster.local:8080";
const TIMEOUT_MS = 15_000;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${MARKETPLACE_API_URL}/internal/domains/${encodeURIComponent(id)}/refresh-status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        cache: "no-store",
      },
    );
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch (err) {
    logger.error("[admin custom-domains refresh-status] proxy failed", err);
    return NextResponse.json(
      {
        error: "upstream_unavailable",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(t);
  }
}
