// M2 — Trigger DNS re-verify on a custom domain.
//
// Proxies to mark8ly marketplace-api-admin's /internal/domains/:id/verify.
// In-cluster traffic; gated by istio AuthorizationPolicy
// (cluster.local/ns/tesserix/sa/company is allow-listed in the
// allow-marketplace-api-admin-callers policy).

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
      `${MARKETPLACE_API_URL}/internal/domains/${encodeURIComponent(id)}/verify`,
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
    logger.error("[admin custom-domains verify] proxy failed", err);
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
