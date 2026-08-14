import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  bearerToken,
  sessionCookieName,
  verifySession,
  evaluateCsrf,
} from "@tesserix/platform-auth";

// Use the Node runtime so jose's symmetric-key crypto runs natively
// (Edge runtime restricts node:crypto and forces wasm fallbacks).
export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public/).*)"],
};

// SECURITY: Production runtime assertion.
if (
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === "true"
) {
  throw new Error("SECURITY: DEV_AUTH_BYPASS cannot be enabled in production.");
}

const DEV_AUTH_BYPASS = process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === "true";

// The console has no public pages — everything behind it requires a session.
// That is the point of splitting it from the marketing/admin app.
const PUBLIC_PATHS: ReadonlyArray<string> = [];

// `/_next` is handled by the caller, before this is ever reached — it is not a
// public path, it is not a page at all. Keeping it out of here means the check
// stays true even while PUBLIC_PATHS is empty.
function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

function unauthorized(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // The console has no /login route of its own (PUBLIC_PATHS is empty by
  // design), so redirecting to a same-origin /login would just re-trigger
  // this same gate and loop. Send anonymous visitors to web's /login instead.
  //
  // KNOWN LIMITATION: web's safeReturnPath (apps/web/lib/auth/oauth.ts) only
  // accepts same-origin relative paths, as an open-redirect guard — it is
  // out of scope for M0 to loosen that. So this absolute cross-origin
  // returnTo is discarded today and the operator lands on web's own
  // /admin/dashboard rather than back in the console. We send it anyway so
  // the console -> web login handoff starts working the moment web grows an
  // origin allowlist for its own returnTo (symmetric with the
  // NEXT_PUBLIC_CONSOLE_URL Task 6 introduces for the other direction).
  const webUrl = process.env.NEXT_PUBLIC_WEB_URL ?? "http://localhost:3002";
  const loginUrl = new URL("/login", webUrl);
  loginUrl.searchParams.set(
    "returnTo",
    `${request.nextUrl.origin}${pathname}${search}`,
  );
  return NextResponse.redirect(loginUrl);
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (pathname.match(/\.(ico|png|jpg|jpeg|gif|svg|css|js|woff|woff2|map)$/)) {
    return NextResponse.next();
  }
  if (pathname.startsWith("/_next")) {
    return NextResponse.next();
  }

  const csrf = evaluateCsrf(request);
  if (csrf.blocked) {
    return NextResponse.json(
      { error: csrf.message ?? "CSRF check failed" },
      { status: 403 },
    );
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (DEV_AUTH_BYPASS) {
    return NextResponse.next();
  }

  // Accept either the encrypted session COOKIE (web) or an
  // `Authorization: Bearer <token>` header carrying the same encrypted session
  // (a mobile client — it can't use the .tesserix.app httpOnly cookie).
  // Both are the identical JWE minted by signSession, so verification is shared.
  const bearer = bearerToken(request.headers.get("authorization"));
  const sessionToken =
    request.cookies.get(sessionCookieName())?.value ?? bearer;
  if (!sessionToken) {
    return unauthorized(request);
  }
  const session = await verifySession(sessionToken);
  if (!session) {
    return unauthorized(request);
  }

  return NextResponse.next();
}
