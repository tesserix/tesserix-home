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
// Covers the round trip through Zitadel and Google. Long enough for a real
// person to complete an MFA prompt; short enough that an abandoned attempt
// does not leave a usable nonce lying around.
const STATE_MAX_AGE = 10 * 60;

export async function GET(request: NextRequest): Promise<Response> {
  const returnTo = safeReturnPath(
    request.nextUrl.searchParams.get("returnTo"),
  );

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
    state: encodeState(stateNonce, returnTo),
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
