// GET /auth/callback — Google OAuth redirect target.
//
// 1. Verify state matches the CSRF cookie set by /auth/login.
// 2. Exchange the authorization code for an id_token + access_token.
// 3. Decode the id_token (just-exchanged over TLS, channel-trusted).
// 4. Enforce the email allowlist (ALLOWED_ADMIN_EMAILS).
// 5. Mint our own session cookie and redirect to the original returnTo.

import { NextResponse, type NextRequest } from "next/server";

import {
  decodeIdTokenUnsafe,
  exchangeCodeForTokens,
  isEmailAllowed,
  safeReturnPath,
} from "@/lib/auth/oauth";
import {
  sessionCookieName,
  sessionCookieOptions,
  signSession,
} from "@tesserix/platform-auth";
import { logger } from "@/lib/logger";
import { siteOrigin } from "@/lib/site-origin";

const STATE_COOKIE_NAME = "tx_oauth_state";

/** Loopback with or without a port. `[::1]:3002` keeps its brackets. */
function isLoopback(host: string): boolean {
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

// Build redirect URLs using the public origin from forwarded headers
// instead of req.url, which reflects the pod's internal HOSTNAME
// (0.0.0.0:3000) and would send the browser to a non-existent host.
//
// The forwarded headers are proxy headers, but our ingress forwards the
// client's values rather than overwriting them, so they arrive
// attacker-controlled — `X-Forwarded-Host: evil.example.com` used to come
// straight back as the /login and post-login redirect target. The claimed host
// is therefore checked against this site's own origin, and on a match we
// return the configured origin string verbatim rather than reassembling
// `${proto}://${host}`, which drops the X-Forwarded-Proto trust too: a forged
// `http` can no longer produce a downgraded URL. A host that fails the check is
// not an error — we fall back to our own origin, because rejecting the request
// would turn a header no legitimate client sends into a DoS knob.
//
// The origin it checks against comes from lib/site-origin.ts — see there for
// why it is a runtime `SITE_ORIGIN` and no longer an inlined
// `NEXT_PUBLIC_SITE_URL`.
//
// Mirrors apps/console/lib/public-origin.ts, which has the same helper (and
// had the same hole) against CONSOLE_PUBLIC_ORIGIN.
function publicOrigin(req: NextRequest): string {
  const site = siteOrigin();
  const claimed = (
    req.headers.get("x-forwarded-host") ?? req.headers.get("host")
  )
    ?.split(",")[0] // Only the first value in a proxy chain is client-facing.
    ?.trim()
    .toLowerCase();

  if (!claimed) return site;
  if (claimed === new URL(site).host.toLowerCase()) return site;
  // Local dev has no proxy but does have a Host header, so a bare allowlist
  // would send developers to tesserix.app.
  if (process.env.NODE_ENV !== "production" && isLoopback(claimed)) {
    return `http://${claimed}`;
  }
  return site;
}

function loginErrorRedirect(req: NextRequest, code: string): Response {
  const url = new URL("/login", publicOrigin(req));
  url.searchParams.set("error", code);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;

  // Google can redirect with `error=access_denied` if the user cancels
  // the consent screen. Surface that on /login.
  const oauthError = sp.get("error");
  if (oauthError) {
    return loginErrorRedirect(req, oauthError);
  }

  const code = sp.get("code");
  const stateRaw = sp.get("state");
  if (!code || !stateRaw) {
    return loginErrorRedirect(req, "missing_code_or_state");
  }

  // State is "<nonce>.<base64url(returnTo)>". Validate the nonce against
  // the cookie set by /auth/login.
  const dot = stateRaw.indexOf(".");
  if (dot < 0) return loginErrorRedirect(req, "bad_state");
  const nonce = stateRaw.slice(0, dot);
  const returnToB64 = stateRaw.slice(dot + 1);
  const stateCookie = req.cookies.get(STATE_COOKIE_NAME);
  if (!stateCookie || stateCookie.value !== nonce) {
    return loginErrorRedirect(req, "csrf_mismatch");
  }

  let returnTo = "/admin/dashboard";
  try {
    returnTo = safeReturnPath(
      Buffer.from(returnToB64, "base64url").toString("utf8"),
    );
  } catch {
    // ignore decode error; safe default already in place
  }

  // Exchange and decode.
  let idToken: string;
  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.id_token) {
      return loginErrorRedirect(req, "no_id_token");
    }
    idToken = tokens.id_token;
  } catch (err) {
    logger.error("[auth/callback] token exchange failed", err);
    return loginErrorRedirect(req, "token_exchange_failed");
  }

  let claims;
  try {
    claims = decodeIdTokenUnsafe(idToken);
  } catch (err) {
    logger.error("[auth/callback] id_token decode failed", err);
    return loginErrorRedirect(req, "bad_id_token");
  }

  if (!claims.email || claims.email_verified === false) {
    return loginErrorRedirect(req, "email_unverified");
  }
  if (!isEmailAllowed(claims.email)) {
    logger.warn(
      "[auth/callback] denied — email not in allowlist",
      { email: claims.email },
    );
    return loginErrorRedirect(req, "not_allowed");
  }

  // Mint session cookie scoped to .tesserix.app so all subdomains share it.
  const session = await signSession({
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    name: claims.name,
  });

  const cookieOpts = sessionCookieOptions();
  const dest = new URL(returnTo, publicOrigin(req));
  const res = NextResponse.redirect(dest);
  res.cookies.set(sessionCookieName(), session, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    domain: cookieOpts.domain,
    path: "/",
    maxAge: cookieOpts.maxAge,
  });
  // Clear the short-lived state cookie.
  res.cookies.set(STATE_COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/auth",
    maxAge: 0,
  });
  return res;
}
