import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Use the Node runtime so the middleware can resolve K8s service DNS names
// (in-cluster fetch to auth-bff for session validation). Edge runtime would
// otherwise restrict outbound networking.
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

// auth-bff sets a single session cookie. The name is configured per-app
// via SESSION_COOKIE_NAME in the auth-bff deployment (tx_session for
// tesserix.app). Matching env on this app keeps both halves in sync.
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "tx_session";

// In-cluster URL of the auth-bff. Falls back to the public URL if the
// internal one isn't reachable (e.g. local dev). Production resolves to
// http://tesserix-auth-bff.tesserix.svc.cluster.local:8087.
const AUTH_BFF_INTERNAL_URL =
  process.env.AUTH_BFF_INTERNAL_URL ??
  "http://tesserix-auth-bff.tesserix.svc.cluster.local:8087";

const PUBLIC_PATHS: ReadonlyArray<string> = [
  "/",
  "/about",
  "/contact",
  "/products",
  "/login",
  "/api/health",
  "/api/contact",
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) {
    return true;
  }
  return PUBLIC_PATHS.some(
    (p) =>
      pathname.startsWith(p + "/") ||
      pathname.startsWith("/_next") ||
      pathname.startsWith("/auth/error") ||
      pathname.startsWith("/api/auth"),
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

// Validate the session by asking auth-bff. The presence of the cookie is
// not enough — anyone who can set a cookie on .tesserix.app could otherwise
// bypass auth. auth-bff's GET /auth/session decrypts the cookie, checks
// expiry, and returns 200 + user info on success or 401 on failure.
async function validateSession(cookieValue: string): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH_BFF_INTERNAL_URL}/auth/session`, {
      method: "GET",
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}`,
        // Skip middleware caching layers; these calls are per-request.
        "Cache-Control": "no-store",
      },
      // Don't follow auth-bff redirects in middleware.
      redirect: "manual",
    });
    return res.status === 200;
  } catch {
    // Treat network failure as auth failure (fail closed). The route
    // handler will return 503; the user retries.
    return false;
  }
}

function unauthorized(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("returnTo", pathname);
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

  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME);
  if (!sessionCookie) {
    return unauthorized(request);
  }

  const valid = await validateSession(sessionCookie.value);
  if (!valid) {
    return unauthorized(request);
  }

  return NextResponse.next();
}
