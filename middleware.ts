import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  sessionCookieName,
  verifySession,
} from "@/lib/auth/session-jwt";

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
  "/login",
  "/api/health",
  "/api/contact",
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
      pathname.startsWith("/auth/"),
  );
}

interface CsrfDecision {
  blocked: boolean;
  message?: string;
}

function csrfCheck(request: NextRequest): CsrfDecision {
  const isApiRoute = request.nextUrl.pathname.startsWith("/api/");
  const isMutating = ["POST", "PUT", "DELETE", "PATCH"].includes(
    request.method,
  );
  if (!isApiRoute || !isMutating) {
    return { blocked: false };
  }
  // /api/internal/* is server-to-server with bearer-token auth (e.g.,
  // mark8ly admin filing a platform ticket on a merchant's behalf).
  // CSRF is irrelevant for non-cookie auth — the bearer token in
  // INTERNAL_API_TOKEN is the access control. Skipping the Origin/
  // Referer check here lets trusted callers POST without faking a
  // browser-style request.
  if (request.nextUrl.pathname.startsWith("/api/internal/")) {
    return { blocked: false };
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  const allowedHostnames = new Set<string>();
  const host = request.headers.get("host");
  if (host) allowedHostnames.add(host.split(":")[0]);
  const fwdHost = request.headers.get("x-forwarded-host");
  if (fwdHost)
    allowedHostnames.add(fwdHost.split(",")[0].trim().split(":")[0]);
  const csrfDomains = process.env.CSRF_ALLOWED_DOMAINS;
  if (csrfDomains) {
    csrfDomains.split(",").forEach((d) => allowedHostnames.add(d.trim()));
  }
  if (allowedHostnames.size === 0) {
    return { blocked: false };
  }

  const matches = (raw: string | null): boolean => {
    if (!raw) return false;
    try {
      return allowedHostnames.has(new URL(raw).hostname);
    } catch {
      return false;
    }
  };

  if (origin && !matches(origin)) {
    return { blocked: true, message: "CSRF check failed" };
  }
  if (!origin && referer && !matches(referer)) {
    return { blocked: true, message: "CSRF check failed" };
  }
  if (!origin && !referer && !request.nextUrl.pathname.startsWith("/api/auth")) {
    return {
      blocked: true,
      message: "CSRF check failed: Origin header required",
    };
  }
  return { blocked: false };
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

  const csrf = csrfCheck(request);
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

  // Locally verify the encrypted session cookie. This is fast (no
  // network), handled by tesserix-home itself, and removes the
  // cross-namespace dependency on auth-bff for protected page renders.
  const sessionCookie = request.cookies.get(sessionCookieName());
  if (!sessionCookie) {
    return unauthorized(request);
  }
  const session = await verifySession(sessionCookie.value);
  if (!session) {
    return unauthorized(request);
  }

  return NextResponse.next();
}
