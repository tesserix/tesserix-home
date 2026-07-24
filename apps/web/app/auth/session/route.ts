// GET /auth/session — return session info derived from the local
// JWE-encrypted session cookie. Drop-in replacement for the
// auth-bff /auth/session response shape that `lib/auth/auth-client`
// already consumes.
//
// This is the route the React UI polls to know whether the user is
// authenticated. We don't go through middleware's protection because
// returning 401 IS the authoritative signal for "not authenticated".

import { NextResponse, type NextRequest } from "next/server";

import {
  sessionCookieName,
  verifySession,
} from "@/lib/auth/session-jwt";

export async function GET(req: NextRequest): Promise<Response> {
  const cookie = req.cookies.get(sessionCookieName());
  if (!cookie) {
    return NextResponse.json(
      { authenticated: false, error: "no_cookie" },
      { status: 401 },
    );
  }
  const session = await verifySession(cookie.value);
  if (!session) {
    return NextResponse.json(
      { authenticated: false, error: "invalid_session" },
      { status: 401 },
    );
  }
  return NextResponse.json({
    authenticated: true,
    userId: session.sub,
    email: session.email,
    displayName: session.name,
    expiresAt: session.exp,
    authContext: "platform-admin",
  });
}
