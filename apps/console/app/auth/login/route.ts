import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import {
  buildAuthorizationUrl,
  encodeState,
  getOidcConfig,
  safeReturnPath,
} from "@/lib/auth/oidc";

// GET /auth/login — start the console's own OIDC flow against Zitadel.
//
// Reached only when AUTH_PROVIDER=zitadel; under the legacy provider the
// middleware still bounces to apps/web and never routes here.

export const runtime = "nodejs";

const STATE_COOKIE = "cx_oauth_state";
const NONCE_COOKIE = "cx_oidc_nonce";
// How long a login may take from /auth/login to the callback.
//
// Was 10 minutes, on the reasoning that it was "long enough for a real person
// to complete an MFA prompt". It was not. The first operator to actually reach
// an MFA prompt on this instance hit the callback with an expired cookie and
// got `state_mismatch` — a CSRF failure, for a login that was proceeding
// normally.
//
// Ten minutes is a stopwatch on a screen that asks someone to make a decision:
// set up a second factor now, or skip. Reading it, deciding, maybe fetching a
// phone — that is not a ten-minute task, and the failure it produces looks
// like an attack rather than a timeout.
//
// Thirty minutes still bounds an abandoned attempt to something short, and the
// value it protects is modest: the nonce is useless without the matching
// authorization code, and both cookies are deleted the moment a login
// succeeds. The window that matters for replay is the code's, which Zitadel
// owns and measures in seconds.
const STATE_MAX_AGE = 30 * 60;

// Set by /auth/callback when it bounces a cookieless callback back through
// here, and by nothing else. Folded into `state` so it survives the trip to
// Zitadel and returns on the next callback, which is what makes the retry
// one-shot rather than a loop. See RETRY_FLAG in lib/auth/oidc.ts.
const RETRY_PARAM = "retry";

export async function GET(request: NextRequest): Promise<Response> {
  const returnTo = safeReturnPath(
    request.nextUrl.searchParams.get("returnTo"),
  );
  const retried = request.nextUrl.searchParams.get(RETRY_PARAM) === "1";

  let config;
  try {
    config = getOidcConfig();
  } catch (err) {
    // A missing env var must not render as "not signed in" — that would send
    // the operator round a redirect loop with no indication of the real cause.
    console.error("[auth/login] Zitadel config missing", err);
    return NextResponse.json({ error: "auth_misconfigured" }, { status: 500 });
  }

  const stateNonce = randomBytes(16).toString("hex");
  const idNonce = randomBytes(16).toString("hex");
  const url = buildAuthorizationUrl(config, {
    state: encodeState(stateNonce, returnTo, { retried }),
    nonce: idNonce,
  });

  const res = NextResponse.redirect(url);
  const secure = new URL(config.redirectUri).protocol === "https:";
  for (const [name, value] of [
    [STATE_COOKIE, stateNonce],
    [NONCE_COOKIE, idNonce],
  ] as const) {
    res.cookies.set(name, value, {
      httpOnly: true,
      secure,
      // `lax` rather than `strict`: the callback arrives as a top-level
      // cross-site redirect from Zitadel, and `strict` would withhold the
      // cookie on exactly that request, breaking every login.
      sameSite: "lax",
      path: "/",
      maxAge: STATE_MAX_AGE,
    });
  }
  return res;
}
