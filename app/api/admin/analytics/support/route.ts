// Server-side proxy for the platform-wide Otto support analytics.
//
// Admin-only: requires a valid tesserix-home admin session, then calls
// otto's CROSS-TENANT platform-stats endpoint with the internal shared
// secret. otto's PlatformAuth denies on an empty secret, so this surface
// (data across every tenant) never falls open. Mirrors the otto proxy's
// auth wiring but targets /api/v1/platform/otto/stats instead of the
// store-scoped storefront/admin surfaces.
import { NextResponse } from "next/server";

import { getCurrentSession } from "@/lib/auth/session-jwt";

const OTTO_URL = (process.env.OTTO_URL ?? "http://localhost:8089").replace(
  /\/+$/,
  "",
);
const OTTO_INTERNAL_AUTH = (process.env.OTTO_INTERNAL_AUTH ?? "").trim();

export async function GET(): Promise<Response> {
  const session = await getCurrentSession().catch(() => null);
  if (!session?.sub) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!OTTO_INTERNAL_AUTH) {
    return NextResponse.json(
      { error: "not_configured", message: "OTTO_INTERNAL_AUTH unset" },
      { status: 503 },
    );
  }
  try {
    const res = await fetch(`${OTTO_URL}/api/v1/platform/otto/stats`, {
      method: "GET",
      headers: {
        "X-Internal-Auth": OTTO_INTERNAL_AUTH,
        "X-User-Id": session.sub,
      },
      cache: "no-store",
    });
    const text = await res.text();
    const out = new NextResponse(text, { status: res.status });
    out.headers.set(
      "Content-Type",
      res.headers.get("Content-Type") || "application/json",
    );
    out.headers.set("Cache-Control", "no-store");
    return out;
  } catch (err) {
    return NextResponse.json(
      {
        error: "upstream_unreachable",
        message: err instanceof Error ? err.message : "otto unreachable",
      },
      { status: 502 },
    );
  }
}
