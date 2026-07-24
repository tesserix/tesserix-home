// GET /api/auth/mobile/session — the mobile app confirms a restored bearer on
// boot. Validates the encrypted session carried in Authorization: Bearer.

import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/session-jwt";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const header = request.headers.get("authorization");
  const token =
    header && header.toLowerCase().startsWith("bearer ")
      ? header.slice(7).trim()
      : null;
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const session = await verifySession(token);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    email: session.email,
    name: session.name ?? session.email,
  });
}
