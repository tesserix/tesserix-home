import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { bearerToken } from "@/lib/auth/bearer";
import {
  sessionCookieName,
  verifySession,
} from "@/lib/auth/session-jwt";
import { evaluateCsrf } from "@/lib/security/csrf";

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

const PUBLIC_PATHS: ReadonlyArray<string> = [
  "/",
  "/about",
  "/contact",
  "/products",
  // Public launch countdown pages (and their generated OG images) — shared
  // on social media, so they must render for anonymous visitors and for the
  // Facebook/LinkedIn link-preview crawlers.
  "/launch",
  "/login",
  // Next.js metadata file routes (root-level opengraph image, robots.txt,
  // sitemap.xml) — fetched by social-media link-preview crawlers and search
  // engine bots, neither of which carry a tesserix-home session. Nested
  // metadata routes (e.g. /products/[slug]/opengraph-image) already inherit
  // public access from their parent path above.
  "/opengraph-image",
  "/robots.txt",
  "/sitemap.xml",
  "/api/health",
  "/api/contact",
  // "Notify me when this launches" on a coming-soon product page, plus the
  // one-click unsubscribe the launch email links to. Both are used by anonymous
  // visitors — requiring a session would mean nobody could ever join the list,
  // and an unsubscribe link that demands a login isn't an unsubscribe link.
  "/api/waitlist",
  // Support chat proxy — anonymous marketing visitors must be able to open
  // a chat (otto enforces its own OTP/session auth + the internal-auth
  // secret); a tesserix-home session is not required.
  "/api/otto",
  // Internal product-to-product endpoints. Auth is enforced by each
  // route handler via the INTERNAL_API_TOKEN bearer check — middleware
  // session auth would block legitimate server-to-server callers that
  // don't have a tesserix-home browser session.
  "/api/internal",
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) {
    return true;
  }
  return PUBLIC_PATHS.some(
    (p) =>
      pathname.startsWith(p + "/") ||
      pathname.startsWith("/_next") ||
      // Self-hosted OAuth flow (login redirect, callback, logout).
      pathname.startsWith("/auth/") ||
      // Mobile admin sign-in (verifies a Google id_token + mints a bearer
      // session; the /session route validates its own bearer). Pre-auth.
      pathname.startsWith("/api/auth/mobile/"),
  );
}

function unauthorized(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("returnTo", `${pathname}${search}`);
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
  // (the mobile admin app — it can't use the .tesserix.app httpOnly cookie).
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
