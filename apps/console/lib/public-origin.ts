import type { NextRequest } from "next/server";

/** The console's declared identity. Shared with lib/platform-api.ts, which
 *  sends the same value as an Origin to apps/web's CSRF gate — one variable so
 *  the two cannot drift apart. Read per call rather than at module load so a
 *  test (or a pod restart with new config) sees the current value. */
const DEFAULT_ORIGIN = "https://console.tesserix.app";

function configuredOrigin(): string {
  const raw = process.env.CONSOLE_PUBLIC_ORIGIN ?? DEFAULT_ORIGIN;
  try {
    // Parse to prove it is an origin, but return the configured string itself:
    // `new URL(x).origin` would silently rewrite the value we hand the browser.
    new URL(raw);
    return raw;
  } catch {
    // A malformed CONSOLE_PUBLIC_ORIGIN must not take the allowlist down with
    // it — an empty allowlist would send every request to the fallback, which
    // would be that same malformed string.
    return DEFAULT_ORIGIN;
  }
}

/** Hostname (with port, lowercased) of an origin string. */
function hostOf(origin: string): string {
  return new URL(origin).host.toLowerCase();
}

/**
 * Hosts this app answers to. The configured origin's host always; anything
 * else must be named explicitly in CONSOLE_ALLOWED_HOSTS (comma separated,
 * for preview or alternate hostnames).
 *
 * Deliberately no `*.tesserix.app` wildcard: that would make every subdomain
 * that exists now or is ever parked, delegated or taken over a valid redirect
 * target, which is most of the hole this closes. Explicit hosts cost one env
 * var and nothing else.
 */
function allowedHosts(origin: string): ReadonlySet<string> {
  const extra = (process.env.CONSOLE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set([hostOf(origin), ...extra]);
}

/**
 * Loopback, with or without a port. `[::1]:3003` keeps its brackets, so the
 * port split has to skip anything inside them.
 */
function isLoopback(host: string): boolean {
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The public origin a request arrived on.
 *
 * `request.nextUrl.origin` is the pod's own bind address behind the ingress,
 * so building URLs from it points the browser at a host it cannot reach. In
 * production this shipped as `returnTo=https://0.0.0.0:3000/` on the login
 * redirect. Mirrors the helper in apps/web/app/auth/callback/route.ts, which
 * hit the identical problem.
 *
 * Trust boundary: `X-Forwarded-Host` and `X-Forwarded-Proto` are *proxy*
 * headers, but our ingress forwards the client's values instead of overwriting
 * them, so they arrive attacker-controlled:
 *
 *     curl -H "X-Forwarded-Host: evil.example.com" https://console.tesserix.app/
 *     -> location: https://evil.example.com/auth/login?returnTo=%2F
 *
 * So the forwarded host is treated as a *claim to be checked*, not as an
 * answer. On a match against the configured origin we return that configured
 * string verbatim rather than reassembling `${proto}://${host}` — which drops
 * the `X-Forwarded-Proto` trust in the same move, so a forged `http` cannot
 * produce a downgraded URL.
 *
 * A host that fails the check is not an error: we fall back to the configured
 * origin and carry on. Rejecting the request would turn a header no legitimate
 * client ever sends into a denial-of-service knob.
 */
export function publicOrigin(request: NextRequest): string {
  const configured = configuredOrigin();
  const isProduction = process.env.NODE_ENV === "production";

  const claimed = (
    request.headers.get("x-forwarded-host") ?? request.headers.get("host")
  )
    ?.split(",")[0] // A proxy chain appends; only the first value is client-facing.
    ?.trim()
    .toLowerCase();

  if (!claimed) {
    // No proxy and no Host header at all. In dev nextUrl.origin is genuinely
    // the right answer; in production it is the pod's bind address, which is
    // the bug this helper exists to avoid.
    return isProduction ? configured : request.nextUrl.origin;
  }

  if (claimed === hostOf(configured)) return configured;

  const allowed = allowedHosts(configured);
  if (allowed.has(claimed)) {
    // An alternate hostname has to be returned as itself — collapsing it onto
    // the configured origin would defeat the point of listing it. The ingress
    // terminates TLS for these too, so the proto is https regardless of what
    // the request claimed.
    return `https://${claimed}`;
  }

  if (!isProduction && isLoopback(claimed)) {
    // Local dev has no proxy but does have a Host header (`localhost:3003`),
    // so a bare allowlist would send developers to console.tesserix.app. Proto
    // comes from nextUrl.origin, which keeps dev on http.
    return `${new URL(request.nextUrl.origin).protocol}//${claimed}`;
  }

  return configured;
}
