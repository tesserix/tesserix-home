// POST /auth/logout — clear the session cookie.
// GET also supported for browser-initiated logout from a link.

import { NextResponse, type NextRequest } from "next/server";

import {
  sessionCookieName,
  sessionCookieOptions,
} from "@/lib/auth/session-jwt";

function clearSession(req: NextRequest): Response {
  const cookieOpts = sessionCookieOptions();
  const url = new URL("/login", req.url);
  const res = NextResponse.redirect(url);
  res.cookies.set(sessionCookieName(), "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    domain: cookieOpts.domain,
    path: "/",
    maxAge: 0,
  });
  return res;
}

export async function GET(req: NextRequest): Promise<Response> {
  return clearSession(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return clearSession(req);
}
