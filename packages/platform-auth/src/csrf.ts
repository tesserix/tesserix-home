import { bearerToken } from "./bearer";

export interface CsrfDecision {
  blocked: boolean;
  message?: string;
}

export interface CsrfRequest {
  method: string;
  nextUrl: { pathname: string };
  headers: { get(name: string): string | null };
}

/**
 * The hostnames this platform is actually served on.
 *
 * Sourced from the Istio VirtualServices in the `tesserix` namespace:
 * `company-vs` serves exactly `tesserix.app` and `console-vs` serves exactly
 * `console.tesserix.app`. Nothing else routes to an app that mounts this
 * middleware. **If that routing changes, this list must change with it.**
 *
 * This lives in code rather than only in `CSRF_ALLOWED_DOMAINS` because the
 * allowlist used to be derived from the request's own `Host` /
 * `X-Forwarded-Host` headers — i.e. the request nominated the hostname its
 * `Origin` was then checked against, which is no check at all. Both derived
 * sources are gone. `Host` in particular was only load-bearing because the
 * console deployment sets no `CSRF_ALLOWED_DOMAINS` at all; this default now
 * covers that case, so the control no longer depends on deploy config being
 * right.
 */
export const DEFAULT_CSRF_HOSTNAMES: readonly string[] = [
  "tesserix.app",
  "console.tesserix.app",
];

/**
 * Defaults plus anything in `CSRF_ALLOWED_DOMAINS`. The env var is purely
 * additive: a new host can be allowed without a release, but a missing or
 * misconfigured value cannot shrink the set.
 */
function allowedCsrfHostnames(): Set<string> {
  const allowed = new Set<string>(DEFAULT_CSRF_HOSTNAMES);
  const configured = process.env.CSRF_ALLOWED_DOMAINS;
  if (configured) {
    for (const domain of configured.split(",")) {
      const trimmed = domain.trim();
      if (trimmed) allowed.add(trimmed);
    }
  }
  return allowed;
}

/**
 * `allowedHostnames` exists so the fail-closed branch below is reachable from a
 * test; production callers pass nothing and get the defaults plus the env var.
 */
export function evaluateCsrf(
  request: CsrfRequest,
  allowedHostnames: ReadonlySet<string> = allowedCsrfHostnames(),
): CsrfDecision {
  const isApiRoute = request.nextUrl.pathname.startsWith("/api/");
  const isMutating = ["POST", "PUT", "DELETE", "PATCH"].includes(request.method);
  if (!isApiRoute || !isMutating) {
    return { blocked: false };
  }
  // /api/internal/* is server-to-server bearer-token auth — CSRF is irrelevant
  // for non-cookie auth.
  if (request.nextUrl.pathname.startsWith("/api/internal/")) {
    return { blocked: false };
  }
  // Bearer-authenticated requests (the native mobile admin app) are not
  // cookie-based, so CSRF — a cookie-riding-attack defense — does not apply.
  // Exempt ONLY when there is no session cookie: a real mobile request carries
  // a bearer and no cookie; this stays safe even if CORS is later relaxed to
  // reflect origins (a cookie-bearing request never skips CSRF). Verification
  // still happens downstream (middleware auth + verifySession).
  const sessionCookieName = process.env.SESSION_COOKIE_NAME ?? "tx_session";
  const cookieHeader = request.headers.get("cookie") ?? "";
  const hasSessionCookie = new RegExp(`(?:^|;\\s*)${sessionCookieName}=`).test(cookieHeader);
  if (!hasSessionCookie && bearerToken(request.headers.get("authorization"))) {
    return { blocked: false };
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  if (allowedHostnames.size === 0) {
    // Fail closed. DEFAULT_CSRF_HOSTNAMES is non-empty, so a default caller
    // cannot land here — which is the point. Empty used to mean "allow
    // everything", the one outcome a CSRF check must never silently produce.
    return { blocked: true, message: "CSRF check failed" };
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
    return { blocked: true, message: "CSRF check failed: Origin header required" };
  }
  return { blocked: false };
}
