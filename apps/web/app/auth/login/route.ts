// GET /auth/login — initiate Google OAuth.
//
// Server-side OAuth flow (rather than client-side GIS popup) so the
// flow works across browsers without depending on third-party cookies
// or the `accounts.google.com/gsi/client` SDK. Tesserix-home owns its
// own session cookie minting; auth-bff is no longer involved.

import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";

import { buildAuthorizationUrl } from "@/lib/auth/oauth";
import { logger } from "@/lib/logger";

const STATE_COOKIE_NAME = "tx_oauth_state";
const STATE_COOKIE_MAX_AGE = 10 * 60; // 10 minutes — covers the OAuth round-trip

export async function GET(req: NextRequest): Promise<Response> {
  const returnTo = req.nextUrl.searchParams.get("returnTo") ?? "/admin/dashboard";
  const prompt = req.nextUrl.searchParams.get("prompt") ?? undefined;

  // CSRF state — random nonce + base64-encoded returnTo so the
  // callback knows where to send the user after a successful exchange.
  const nonce = randomBytes(16).toString("hex");
  const state = `${nonce}.${Buffer.from(returnTo).toString("base64url")}`;

  let url: string;
  try {
    url = buildAuthorizationUrl({ state, prompt });
  } catch (err) {
    logger.error("[auth/login] config missing", err);
    return NextResponse.json(
      { error: "auth_misconfigured" },
      { status: 500 },
    );
  }

  const res = NextResponse.redirect(url);
  res.cookies.set(STATE_COOKIE_NAME, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/auth",
    maxAge: STATE_COOKIE_MAX_AGE,
  });
  return res;
}
