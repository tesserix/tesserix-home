// POST /api/auth/mobile/google — mobile admin sign-in.
// The web trusts the id_token because it comes straight from Google's token
// endpoint over TLS (decodeIdTokenUnsafe). A mobile client is NOT trusted, so
// here we cryptographically VERIFY the Google id_token (signature via Google's
// JWKS, issuer, audience) before enforcing the same ALLOWED_ADMIN_EMAILS
// allowlist and minting the same encrypted session (returned as a bearer).

import { NextResponse, type NextRequest } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { isEmailAllowed } from "@/lib/auth/oauth";
import { signSession } from "@/lib/auth/session-jwt";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

// The Google OAuth client ids whose id_tokens we accept (the mobile app's
// iOS + web client ids). Falls back to the web OAUTH_CLIENT_ID.
function allowedAudiences(): string[] {
  const raw = process.env.GOOGLE_MOBILE_CLIENT_IDS || process.env.OAUTH_CLIENT_ID || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function POST(request: NextRequest) {
  let idToken: string | undefined;
  try {
    const body = (await request.json()) as { idToken?: unknown };
    if (typeof body.idToken === "string") idToken = body.idToken;
  } catch {
    /* handled below */
  }
  if (!idToken) {
    return NextResponse.json({ error: "idToken is required" }, { status: 400 });
  }

  const audience = allowedAudiences();
  if (audience.length === 0) {
    return NextResponse.json({ error: "mobile sign-in is not configured" }, { status: 503 });
  }

  let email: string;
  let name: string;
  try {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience,
    });
    if (payload.email_verified === false || typeof payload.email !== "string") {
      throw new Error("email not present/verified");
    }
    email = payload.email;
    name = typeof payload.name === "string" ? payload.name : email;
  } catch (err) {
    logger.warn("mobile google sign-in: token verification failed", { err: String(err) });
    return NextResponse.json({ error: "Invalid Google token" }, { status: 401 });
  }

  if (!isEmailAllowed(email)) {
    logger.warn("mobile google sign-in: email not on allowlist", { email });
    return NextResponse.json(
      { error: "Your account is not on the admin allowlist" },
      { status: 403 },
    );
  }

  const token = await signSession({ sub: email, email, name });
  return NextResponse.json({ token, email, name });
}
