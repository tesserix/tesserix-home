import { NextResponse, type NextRequest } from "next/server";

import {
  signSession,
  sessionCookieName,
  sessionCookieOptions,
  verifyIdToken,
  isInternal,
  toCapabilities,
} from "@tesserix/platform-auth";

import {
  decodeState,
  exchangeCode,
  getOidcConfig,
  type TokenResponse,
} from "@/lib/auth/oidc";
import { publicOrigin } from "@/lib/public-origin";

// GET /auth/callback — finish the OIDC flow and mint the session.

export const runtime = "nodejs";

const STATE_COOKIE = "cx_oauth_state";
const NONCE_COOKIE = "cx_oidc_nonce";

function failure(reason: string, status = 401): NextResponse {
  // Deliberately terse to the browser, detailed in the log. The operator does
  // not need to know which check failed; whoever reads the logs does.
  return NextResponse.json({ error: reason }, { status });
}

/**
 * Reduce a token response to the session fields, dropping anything absent.
 *
 * `expires_in` is turned into an absolute instant here, at the only moment the
 * relative value means anything. Carried as seconds since the epoch to match
 * `iat`/`exp` in the same cookie — two time units in one payload is how an
 * off-by-1000 gets written.
 *
 * A missing `expires_in` yields no expiry rather than a guessed one. The
 * refresh path treats an unknown expiry as "refresh on the next opportunity",
 * which is the safe direction: a token refreshed too eagerly costs a request,
 * one refreshed too late costs a failed operator action.
 */
function tokensFor(tokens: TokenResponse): {
  accessToken?: string;
  accessTokenExpiresAt?: number;
  refreshToken?: string;
} {
  return {
    ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
    ...(tokens.expires_in
      ? { accessTokenExpiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in }
      : {}),
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
  };
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
  // The CSRF check: the nonce inside `state` must match the httpOnly cookie
  // /auth/login set. Without it an attacker can feed the browser a code of
  // their choosing and have the console mint a session for THEIR identity.
  //
  // The two ways this fails are logged apart, because they have completely
  // different fixes and the single "state_mismatch" that used to cover both
  // cost an afternoon:
  //
  //   ABSENT  — this browser never visited /auth/login, or did so more than
  //             STATE_MAX_AGE ago. Landing straight on an authorize URL (a
  //             bookmark, a pasted link, a stale tab) does exactly this.
  //   DIFFERS — a login was started more than once and an OLDER tab was
  //             completed: each /auth/login overwrites the cookie, so the
  //             newest one no longer matches the state the old tab carries.
  //
  // Only the log distinguishes them; the response deliberately does not, so a
  // probe cannot learn whether a given browser has a live login in flight.
  const stateCookie = request.cookies.get(STATE_COOKIE)?.value;
  if (!stateCookie) {
    console.warn("[auth/callback] no state cookie", {
      reason: "absent",
      hint: "this browser did not start at /auth/login, or the cookie expired",
    });
    return failure("state_mismatch");
  }
  if (stateCookie !== state.nonce) {
    console.warn("[auth/callback] state cookie does not match", {
      reason: "differs",
      hint: "an older login tab was completed after a newer one was started",
    });
    return failure("state_mismatch");
  }

  let config;
  try {
    config = getOidcConfig();
  } catch (err) {
    console.error("[auth/callback] Zitadel config missing", err);
    return failure("auth_misconfigured", 500);
  }

  let tokens: TokenResponse;
  try {
    tokens = await exchangeCode(config, code);
  } catch (err) {
    console.error("[auth/callback] token exchange failed", err);
    return failure("token_exchange_failed");
  }
  const idToken = tokens.id_token;
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
    // The platform API's credentials, retained rather than dropped.
    //
    // This is the change ADR-003 D8 asked for and the reason the tickets
    // module shipped switched off: the API takes a Zitadel ACCESS token, and
    // until now this handler destructured `id_token` and let the rest fall on
    // the floor. `lib/auth/platform-token.ts` reads what lands here.
    //
    // Absent is tolerated at every layer below, deliberately. Zitadel issues a
    // refresh token only when the application has the Refresh Token grant
    // enabled; `console-web` does not have it today, so this ships knowing the
    // refresh half may be missing. A session with an access token and no
    // refresh token still works — it just stops being able to call the
    // platform API when that token expires, rather than for the whole 7 days
    // the session lives.
    ...tokensFor(tokens),
  });

  // publicOrigin, NOT nextUrl.origin: behind the ingress the latter is the pod's
  // own bind address, so this redirect shipped the browser to
  // http://0.0.0.0:3000 — the third time this codebase has made that mistake.
  const res = NextResponse.redirect(
    new URL(state.returnTo, publicOrigin(request)),
  );
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
