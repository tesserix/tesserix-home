import type { NextRequest } from "next/server";

/**
 * The public origin a request arrived on, taken from the proxy's forwarded
 * headers.
 *
 * `request.nextUrl.origin` is the pod's own bind address behind the ingress,
 * so building URLs from it points the browser at a host it cannot reach. In
 * production this shipped as `returnTo=https://0.0.0.0:3000/` on the login
 * redirect. Mirrors the helper in apps/web/app/auth/callback/route.ts, which
 * hit the identical problem.
 */
export function publicOrigin(request: NextRequest): string {
  const fwdHost =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (fwdHost) {
    // The ingress terminates TLS, so a forwarded host with no proto is still
    // https — defaulting to http would emit a downgraded URL.
    const proto =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
      "https";
    return `${proto}://${fwdHost.split(",")[0].trim()}`;
  }
  // No proxy (local dev): nextUrl.origin is genuinely the right answer.
  return request.nextUrl.origin;
}
