// POST /api/auth/mobile/dev — local-dev sign-in for the mobile app, mirroring
// the web's NEXT_PUBLIC_DEV_AUTH_BYPASS. Hard-gated: 404 unless the bypass flag
// is explicitly on, so it can never mint a session in production.

import { NextResponse } from "next/server";
import { signSession } from "@/lib/auth/session-jwt";

export const runtime = "nodejs";

export async function POST() {
  if (process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS !== "true") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const email = "admin@tesserix.local";
  const name = "Dev Admin";
  const token = await signSession({ sub: email, email, name });
  return NextResponse.json({ token, email, name });
}
