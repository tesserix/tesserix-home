// Server-side proxy for the otto support-chat service. The browser can't call
// otto directly — it must go through this same-origin /api/otto/* route that
// adds the X-Internal-Auth shared secret and pins the tenant/store. Mirrors
// the mark8ly storefront/admin otto proxies.
//
// tesserix-home is the single Tesserix marketing/admin site, so chats route
// to otto's "platform" tenant — the inbox Tesserix support staff already
// watch (same one merchant->platform chats land in). Logged-in admins are
// forwarded as the customer identity (skips OTP); anonymous visitors fall
// through to otto's email-OTP flow.
import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getCurrentSession } from "@/lib/auth/session-jwt";

const OTTO_URL = (process.env.OTTO_URL ?? "http://localhost:8089").replace(/\/+$/, "");
const OTTO_INTERNAL_AUTH = (process.env.OTTO_INTERNAL_AUTH ?? "").trim();
const OTTO_SESSION_COOKIE = process.env.OTTO_SESSION_COOKIE ?? "otto_session_tesserix";

// tesserix-home has no multi-store concept — one site, one support surface.
const TENANT_ID = "platform";
const STORE_ID = "default";

// Security limits for this anonymous, secret-bearing proxy.
const MAX_BODY_BYTES = 64 * 1024; // reject request bodies over 64KB
const UPSTREAM_TIMEOUT_MS = 10_000; // abort the upstream fetch after 10s
const UPSTREAM_PREFIX = `${OTTO_URL}/api/v1/storefront/otto/`;
const OTTO_ORIGIN = new URL(OTTO_URL).origin;

// Reject path segments that could break out of the storefront/otto prefix.
// Next.js has already URL-decoded these segments, so this check is decode-safe
// (e.g. "%2e%2e" arrives here as ".."). encodeURIComponent does NOT encode ".",
// so without this guard a ".." segment would traverse via "../" up to an
// admin-gated cross-tenant endpoint with the internal secret attached.
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
  // TODO(security): add per-IP rate limiting to prevent OTP-abuse

  // Path-traversal guard (see isUnsafeSegment): keep anonymous callers pinned
  // to the storefront/otto surface.
  if (pathSegments.length === 0 || pathSegments.some(isUnsafeSegment)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const path = pathSegments.map(encodeURIComponent).join("/");
  const search = request.nextUrl.searchParams.toString();
  const upstream = `${OTTO_URL}/api/v1/storefront/otto/${path}${search ? "?" + search : ""}`;

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
    "X-Tenant-Id": TENANT_ID,
    "X-Store-Id": STORE_ID,
  };
  if (OTTO_INTERNAL_AUTH) headers["X-Internal-Auth"] = OTTO_INTERNAL_AUTH;

  // Logged-in admin identity (HMAC-verified tx_session) — lets otto skip the
  // anonymous OTP step. Anonymous marketing visitors send no identity.
  const session = await getCurrentSession().catch(() => null);
  if (session?.sub) headers["X-User-Id"] = session.sub;
  if (session?.email) headers["X-User-Email"] = session.email;
  if (session?.name) headers["X-User-Name"] = session.name;

  // Forward the otto session cookie so multi-turn conversations resume.
  const jar = await cookies();
  const ottoCookie = jar.get(OTTO_SESSION_COOKIE)?.value;
  if (ottoCookie) headers["Cookie"] = `${OTTO_SESSION_COOKIE}=${ottoCookie}`;

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
      console.error(`[otto-proxy] upstream ${res.status} for ${parsedUpstream.pathname}`);
      return NextResponse.json({ error: "upstream_error" }, { status: 502 });
    }
    // 2xx and 4xx pass through: 4xx are user-facing business errors (e.g.
    // invalid/expired OTP) the widget needs to render. Only the body the
    // upstream deliberately returns is relayed — no internal detail is added.
    const text = await res.text();
    const out = new NextResponse(text, { status: res.status });
    out.headers.set("Content-Type", res.headers.get("Content-Type") || "application/json");
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) out.headers.set("set-cookie", setCookie);
    return out;
  } catch (err) {
    console.error("[otto-proxy] upstream request failed:", err);
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
