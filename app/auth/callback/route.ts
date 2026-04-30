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
} from "@/lib/auth/session-jwt";
import { logger } from "@/lib/logger";

const STATE_COOKIE_NAME = "tx_oauth_state";

function loginErrorRedirect(req: NextRequest, code: string): Response {
  const url = new URL("/login", req.url);
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
  const dest = new URL(returnTo, req.url);
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
