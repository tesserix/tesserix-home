import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  bearerToken,
  sessionCookieName,
  verifySession,
  evaluateCsrf,
} from "@tesserix/platform-auth";

import { isInternal, requiresCapability } from "@/lib/internal-access";
import { publicOrigin } from "@/lib/public-origin";

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

// The console has no public *pages* — everything behind it requires a session.
// The one exception is its own OIDC flow: /auth/login starts the redirect to
// Zitadel and /auth/callback receives the code, and neither can require the
// session they exist to create.
// `/login` is the console's OWN sign-in page, which Zitadel routes to when
// `console-web` is on Login V2 with this origin as its base URI. It is public
// for the same reason `/auth` is: it cannot require the session it exists to
// create. Zitadel appends `/login` to the configured base URI, which is why
// the path is this and not something under `/auth`.
const PUBLIC_PATHS: ReadonlyArray<string> = ["/auth", "/login"];

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

  // With Zitadel the console owns its login: same-origin, no dependency on
  // apps/web being up, and returnTo is a plain relative path rather than the
  // cross-origin URL web's open-redirect guard discards.
  if (requiresCapability()) {
    const own = new URL("/auth/login", publicOrigin(request));
    own.searchParams.set("returnTo", `${pathname}${search}`);
    return NextResponse.redirect(own);
  }
  // The legacy path, reached only when AUTH_PROVIDER is not zitadel.
  //
  // This used to say the console had no /login route of its own and that
  // PUBLIC_PATHS was empty by design. Both stopped being true when the console
  // grew its own sign-in page — but note that page is NOT a substitute here:
  // /login is where ZITADEL routes a browser mid-flow, with an auth request id
  // it alone can mint. Sending an anonymous visitor there would land them on a
  // page that can only tell them to start somewhere else.
  //
  // So anonymous visitors still go to web's /login under the legacy provider,
  // and to the console's own /auth/login under Zitadel (above).
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
    `${publicOrigin(request)}${pathname}${search}`,
  );
  return NextResponse.redirect(loginUrl);
}

// Authenticated, but not an internal operator. Deliberately NOT a redirect to
// login: the session is valid, so logging in again would mint the same session
// and loop. 403 states the real situation — signed in, not permitted here.
function forbidden(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return new NextResponse(
    "The platform console is restricted to internal operators.",
    { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
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

  if (!isInternal(session.roles, process.env.AUTH_PROVIDER, session.email)) {
    return forbidden(request);
  }

  return NextResponse.next();
}
