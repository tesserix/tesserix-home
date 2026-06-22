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

async function forward(request: NextRequest, pathSegments: string[]): Promise<Response> {
  const path = pathSegments.map(encodeURIComponent).join("/");
  const search = request.nextUrl.searchParams.toString();
  const upstream = `${OTTO_URL}/api/v1/storefront/otto/${path}${search ? "?" + search : ""}`;

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
  const body = method === "GET" || method === "HEAD" ? undefined : await request.text();

  try {
    const res = await fetch(upstream, { method, headers, body, cache: "no-store" });
    const text = await res.text();
    const out = new NextResponse(text, { status: res.status });
    out.headers.set("Content-Type", res.headers.get("Content-Type") || "application/json");
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) out.headers.set("set-cookie", setCookie);
    return out;
  } catch (err) {
    return NextResponse.json(
      { error: "upstream_unreachable", message: err instanceof Error ? err.message : "otto unreachable" },
      { status: 502 },
    );
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
