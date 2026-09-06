import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  bearerToken,
  sessionCookieName,
  verifySession,
  evaluateCsrf,
} from "@tesserix/platform-auth";

import { isInternal, requiresCapability } from "@/lib/internal-access";
import {
  CONSOLE_PATHNAME_HEADER,
  consoleGatePathname,
} from "@/lib/auth/console-pathname";
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

// Routes that authenticate a MACHINE caller (a Zitadel service user) rather
// than a console operator's browser session. NOT the same thing as
// PUBLIC_PATHS above: those are open to anyone, this is reachable by anyone
// but answers 401/403 itself — the console's session cookie / bearer-JWE
// check this middleware otherwise enforces has no way to accept a Zitadel
// machine access token (a real signed JWT, not this app's encrypted session),
// so a route on this list must do its OWN full auth
// (`verifyMachineAuthHeader` + `assertCapability`) rather than delegating any
// part of it to the matcher. Sending mark8ly's service-user token through
// `verifySession` here would reject every valid call before the route ever
// ran, presenting as an unconditional 401 no matter how correctly mark8ly
// authenticated.
//
// EXACT MATCH ONLY — deliberately not `pathname.startsWith(p + "/")` the way
// `isPublicPath` above matches a subtree. Two reasons, both found in review:
//
// 1. A subtree match fails OPEN on a normalisation shape `isPublicPath`
//    doesn't need to worry about: `%2f` survives whatever path normalisation
//    happens upstream of this middleware (dot-segments, `%2e%2e`, case
//    variation and a literal double slash all fail closed here; a literal
//    `%2f` does not), so `/api/v1/plan-catalog/..%2fadmin` would satisfy a
//    prefix match and be exempted from the session gate entirely. An exact
//    match has no subtree to smuggle a segment into.
// 2. This list is a deliberate hole in the console's global auth gate. A
//    prefix match means any FUTURE route filed under
//    `/api/v1/plan-catalog/*` inherits that hole by default, with no
//    action required from whoever adds it. Exact match makes every new
//    sub-resource opt into the hole explicitly, by adding its own literal
//    entry, rather than opt out of the session gate by accident.
//
// BOTH forms below are still exact-match entries, not a prefix — this is not
// a contradiction of point 1. Confirmed empirically (`new
// NextRequest(".../api/v1/plan-catalog/").nextUrl.pathname` ===
// `"/api/v1/plan-catalog/"`, trailing slash intact): Next has no
// `trailingSlash` config here, and whatever redirect would normally fold
// `/plan-catalog/` onto `/plan-catalog` is applied by the ROUTER, which runs
// AFTER middleware — this middleware sees the raw incoming pathname, slash
// and all. Without the second literal, a caller whose HTTP client appends a
// trailing slash (a normalisation some clients do on their own) would fall
// through to the session-cookie branch and get an unconditional 401 from
// `unauthorized()` before `route.ts` ever runs, no matter how correctly it
// authenticated. `/api/v1/plan-catalog/..%2fadmin` still equals neither
// literal, so that shape stays closed, and no future sub-resource is exempt
// by default — the allowlist is exactly as narrow as before, just complete.
// Every `/api/v1/*` route that does its OWN machine-token auth needs BOTH
// literals here, and adding the route without adding them is silent: the
// route's own `verifyMachineAuthHeader` never runs, and the caller gets this
// middleware's `unauthorized()` 401 instead. That 401 is indistinguishable
// from a bad token AND from a route that does not exist, so it reads as an
// auth problem on the caller's side — #542 shipped `/api/v1/promo-catalog`
// this way and it was found only by probing production with a real token.
// `middleware.test.ts` now enumerates `app/api/v1/` and fails on any route
// missing from this list, so the next one cannot be silent.
const MACHINE_AUTH_PATHS: ReadonlyArray<string> = [
  "/api/v1/plan-catalog",
  "/api/v1/plan-catalog/",
  "/api/v1/promo-catalog",
  "/api/v1/promo-catalog/",
];

function isMachineAuthPath(pathname: string): boolean {
  return MACHINE_AUTH_PATHS.includes(pathname);
}

// The Prometheus scrape (tesserix-home#579). A THIRD kind of exemption, and
// the widest of the three, so it is worth being precise about what it is:
//
// - PUBLIC_PATHS are pages open to anyone, because they exist to create the
//   session they could otherwise require.
// - MACHINE_AUTH_PATHS are open to anyone but authenticate the caller
//   themselves, with a Zitadel machine token this middleware cannot verify.
// - This path does not authenticate AT ALL. Prometheus holds no console
//   session, cannot mint one, and sends no credential of any kind.
//
// What stands in for auth is the console's NetworkPolicy — `charts/apps/
// console/templates/network-policy.yaml` in tesserix-k8s admits ingress from
// the `monitoring` and `istio-system` namespaces only — plus the endpoint's
// output, which is counts and timestamps and nothing else. `route.ts` states
// that second half as a rule it holds itself to, and its suite proves it.
//
// Without an entry here the route never runs: `unauthorized()` answers every
// scrape with a 401, which from Prometheus's side is indistinguishable from a
// route that was never deployed. The target would read `up 0` and the alert
// written against these series would be quiet for a reason nobody could see.
//
// EXACT MATCH, BOTH FORMS, for the identical reasons MACHINE_AUTH_PATHS gives
// above — and the argument is stronger here, since a prefix match would put
// the operator-only `/api/internal/parity-check` one crafted segment away
// from an unauthenticated hole.
const SCRAPE_PATHS: ReadonlyArray<string> = [
  "/api/internal/metrics",
  "/api/internal/metrics/",
];

function isScrapePath(pathname: string): boolean {
  return SCRAPE_PATHS.includes(pathname);
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

  if (isMachineAuthPath(pathname)) {
    return NextResponse.next();
  }

  if (isScrapePath(pathname)) {
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

  // Forward the path so the console layout can gate on it (#262).
  //
  // A Next.js server LAYOUT receives no pathname — there is no prop and no
  // API for it — so the capability gate cannot resolve which surface is being
  // requested without this. It is set here rather than the gate moving into
  // middleware because middleware holds only the session cookie, whose roles
  // are up to seven days old; the layout can consult the live capability
  // store, which is the authority every write already uses (#285). Enforcing
  // on the cookie would leave a revoked operator reading restricted surfaces
  // for a week while their writes were already refused.
  //
  // Request header, not response: it travels INTO the render and never
  // reaches the browser.
  //
  // Normalised, because `nextUrl.pathname` is NOT percent-decoded while the
  // router decodes the params it captures — see `consoleGatePathname` for the
  // whole argument. Only the value handed to the gate is normalised; every
  // check above this line still reads the raw `pathname`, so the allowlists
  // keep matching exactly what the router will.
  const forwarded = new Headers(request.headers);
  forwarded.set(CONSOLE_PATHNAME_HEADER, consoleGatePathname(pathname));
  return NextResponse.next({ request: { headers: forwarded } });
}
