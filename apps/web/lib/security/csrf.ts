import { bearerToken } from "@/lib/auth/bearer";

export interface CsrfDecision {
  blocked: boolean;
  message?: string;
}

export interface CsrfRequest {
  method: string;
  nextUrl: { pathname: string };
  headers: { get(name: string): string | null };
}

export function evaluateCsrf(request: CsrfRequest): CsrfDecision {
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
  // Same rationale as /api/internal above; React Native sends no Origin/Referer.
  // Verification still happens downstream (middleware auth + verifySession).
  if (bearerToken(request.headers.get("authorization"))) {
    return { blocked: false };
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  const allowedHostnames = new Set<string>();
  const host = request.headers.get("host");
  if (host) allowedHostnames.add(host.split(":")[0]);
  const fwdHost = request.headers.get("x-forwarded-host");
  if (fwdHost) allowedHostnames.add(fwdHost.split(",")[0].trim().split(":")[0]);
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
    return { blocked: true, message: "CSRF check failed: Origin header required" };
  }
  return { blocked: false };
}
