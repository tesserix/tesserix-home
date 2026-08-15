import { NextResponse, type NextRequest } from "next/server";

import {
  signSession,
  sessionCookieName,
  sessionCookieOptions,
  verifyIdToken,
  isInternal,
  toCapabilities,
} from "@tesserix/platform-auth";

import { decodeState, exchangeCode, getOidcConfig } from "@/lib/auth/oidc";

// GET /auth/callback — finish the OIDC flow and mint the session.

export const runtime = "nodejs";

const STATE_COOKIE = "cx_oauth_state";
const NONCE_COOKIE = "cx_oidc_nonce";

function failure(reason: string, status = 401): NextResponse {
  // Deliberately terse to the browser, detailed in the log. The operator does
  // not need to know which check failed; whoever reads the logs does.
  return NextResponse.json({ error: reason }, { status });
}

export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams;

  const oauthError = params.get("error");
  if (oauthError) {
    console.error("[auth/callback] provider returned an error", {
      error: oauthError,
      description: params.get("error_description"),
    });
    return failure("provider_error");
  }

  const code = params.get("code");
  if (!code) return failure("missing_code");

  const state = decodeState(params.get("state"));
  if (!state) return failure("bad_state");

  // CSRF: the nonce in `state` must match the httpOnly cookie set at /auth/login.
  // Without this an attacker can feed the browser a code of their choosing and
  // have the console mint a session for THEIR identity.
  const stateCookie = request.cookies.get(STATE_COOKIE)?.value;
  if (!stateCookie || stateCookie !== state.nonce) {
    return failure("state_mismatch");
  }

  let config;
  try {
    config = getOidcConfig();
  } catch (err) {
    console.error("[auth/callback] Zitadel config missing", err);
    return failure("auth_misconfigured", 500);
  }

  let idToken: string | undefined;
  try {
    ({ id_token: idToken } = await exchangeCode(config, code));
  } catch (err) {
    console.error("[auth/callback] token exchange failed", err);
    return failure("token_exchange_failed");
  }
  if (!idToken) return failure("no_id_token");

  // Replay protection: the nonce we generated at /auth/login must come back
  // inside the token, so a stolen or replayed code cannot mint a session.
  const expectedNonce = request.cookies.get(NONCE_COOKIE)?.value;
  if (!expectedNonce) return failure("missing_nonce");

  // VERIFY, never decode. The token carries the roles that decide whether this
  // operator may rotate live payment keys or move money; that has to be
  // cryptographically attributable to Zitadel, not merely well-formed.
  let identity;
  try {
    identity = await verifyIdToken(
      idToken,
      {
        issuer: config.issuer,
        clientId: config.clientId,
        internalOrgId: config.internalOrgId,
      },
      expectedNonce,
    );
  } catch (err) {
    console.error("[auth/callback] id_token verification failed", err);
    return failure("invalid_id_token");
  }

  if (!isInternal(identity, { internalOrgId: config.internalOrgId })) {
    // Authenticated, but not an internal operator — no roles on the Platform
    // Console project, or a member of another organization. 403 rather than
    // 401: signing in again would produce the same result.
    console.warn("[auth/callback] refused a non-internal identity", {
      sub: identity.sub,
      orgId: identity.orgId,
      roleCount: identity.roles.length,
    });
    return failure("not_internal", 403);
  }

  const token = await signSession({
    sub: identity.sub,
    email: identity.email,
    name: identity.name,
    // Narrow to known capabilities before they reach the session: an
    // unrecognised role cannot be checked meaningfully, and carrying it invites
    // code elsewhere to match on a string the capability model never sanctioned.
    roles: toCapabilities(identity.roles),
  });

  const res = NextResponse.redirect(new URL(state.returnTo, request.nextUrl.origin));
  const cookie = sessionCookieOptions();
  res.cookies.set(sessionCookieName(), token, {
    httpOnly: true,
    secure: new URL(config.redirectUri).protocol === "https:",
    sameSite: "lax",
    path: "/",
    domain: cookie.domain,
    maxAge: cookie.maxAge,
  });
  // One-shot values: leaving them set would let a stale nonce satisfy a later
  // callback.
  res.cookies.delete(STATE_COOKIE);
  res.cookies.delete(NONCE_COOKIE);
  return res;
}
