// Server-side proxy for the CROSS-TENANT otto platform inbox. The browser
// (tesserix-home admin) and the Expo mobile admin app both call this
// same-origin /api/admin/otto/* route; it adds the X-Internal-Auth shared
// secret and forwards the admin's staff identity so otto can attribute
// accept/reply/close. Targets otto's /api/v1/platform/otto/* surface — the
// unified queue across every product tenant.
//
// Mirrors the hardening of the storefront /api/otto proxy (path-traversal
// guard, host/prefix pinning, 64KB body cap, 10s timeout, 5xx suppression)
// but swaps the anonymous storefront gate for a mandatory admin session and
// points at the platform (not storefront) upstream prefix. No tenant/store
// headers and no otto_session cookie — this is a staff surface, and every
// platform write is re-scoped to the row's own tenant inside otto.
import { type NextRequest, NextResponse } from "next/server";

import { getCurrentSession } from "@tesserix/platform-auth";

const OTTO_URL = (process.env.OTTO_URL ?? "http://localhost:8089").replace(/\/+$/, "");
const OTTO_INTERNAL_AUTH = (process.env.OTTO_INTERNAL_AUTH ?? "").trim();

// Security limits — identical contract to the storefront otto proxy.
const MAX_BODY_BYTES = 64 * 1024; // reject request bodies over 64KB
const UPSTREAM_TIMEOUT_MS = 10_000; // abort the upstream fetch after 10s
const UPSTREAM_PREFIX = `${OTTO_URL}/api/v1/platform/otto/`;
const OTTO_ORIGIN = new URL(OTTO_URL).origin;

// Reject path segments that could break out of the platform/otto prefix.
// Next.js has already URL-decoded these segments, so this check is decode-safe
// (e.g. "%2e%2e" arrives here as ".."). encodeURIComponent does NOT encode ".",
// so without this guard a ".." segment could traverse up to another otto
// surface with the internal secret attached.
function isUnsafeSegment(seg: string): boolean {
  return (
    seg === "" ||
    seg === "." ||
    seg === ".." ||
    seg.includes("/") ||
    seg.includes("\\")
  );
}

async function forward(request: NextRequest, pathSegments: string[]): Promise<Response> {
  // Admin-only: the platform inbox reads/writes across every tenant, so it
  // must never fall open. getCurrentSession() accepts BOTH the tx_session
  // cookie (web) and an Authorization: Bearer session (mobile admin), so one
  // gate covers both clients — the same helper the other /api/admin/* routes use.
  const session = await getCurrentSession().catch(() => null);
  if (!session?.sub) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // 501, not 503, when the secret is unset. The console reads a status, not a
  // body: `apps/console/components/kit/surface-state.ts` maps 501 onto
  // `instrumentation-unavailable` — the calm "not measured yet" callout — and
  // maps EVERY other non-2xx onto a red error state. An unset
  // OTTO_INTERNAL_AUTH is not a fault; it is an integration nobody switched on
  // yet, and answering 503 made a parked platform inbox render as though otto
  // were down. See #198.
  //
  // The distinction the contract turns on: 501 means "never wired", the 502s
  // below mean "wired and not answering" (an upstream 5xx, a timeout, a
  // transport failure). Those must stay 502 — they are real faults and should
  // read as one. The full contract is stated in
  // docs/PLATFORM-API-CONVENTIONS.md §1c, and
  // apps/web/app/api/admin/apps/[product]/audit-logs/route.ts's header is the
  // worked example.
  if (!OTTO_INTERNAL_AUTH) {
    return NextResponse.json(
      { error: "not_configured", message: "OTTO_INTERNAL_AUTH unset" },
      { status: 501 },
    );
  }

  // Path-traversal guard — keep the caller pinned to the platform/otto surface.
  if (pathSegments.length === 0 || pathSegments.some(isUnsafeSegment)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const path = pathSegments.map(encodeURIComponent).join("/");
  const search = request.nextUrl.searchParams.toString();
  const upstream = `${OTTO_URL}/api/v1/platform/otto/${path}${search ? "?" + search : ""}`;

  // Defense-in-depth: the constructed URL must stay host-pinned to OTTO_URL and
  // remain under the intended prefix — reject anything that escaped the guard.
  let parsedUpstream: URL;
  try {
    parsedUpstream = new URL(upstream);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (parsedUpstream.origin !== OTTO_ORIGIN || !upstream.startsWith(UPSTREAM_PREFIX)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Auth": OTTO_INTERNAL_AUTH,
    // Staff identity — otto's PlatformStaff gate requires X-User-Id and
    // attributes accept/reply/close to this admin.
    "X-User-Id": session.sub,
  };
  if (session.email) headers["X-User-Email"] = session.email;
  if (session.name) headers["X-User-Name"] = session.name;

  const method = request.method;
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    // Reject oversized bodies before buffering/forwarding (resource exhaustion).
    const declaredLen = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
  }

  try {
    const res = await fetch(upstream, {
      method,
      headers,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.status >= 500) {
      // 5xx bodies can leak internal host/IP/stack — never relay them.
      console.error(`[otto-platform-proxy] upstream ${res.status} for ${parsedUpstream.pathname}`);
      return NextResponse.json({ error: "upstream_error" }, { status: 502 });
    }
    // 2xx and 4xx pass through: 4xx are business errors the inbox needs to render.
    const text = await res.text();
    const out = new NextResponse(text, { status: res.status });
    out.headers.set("Content-Type", res.headers.get("Content-Type") || "application/json");
    return out;
  } catch (err) {
    console.error("[otto-platform-proxy] upstream request failed:", err);
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}
export async function PUT(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}
