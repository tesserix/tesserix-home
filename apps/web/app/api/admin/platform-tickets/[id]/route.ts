// Super-admin endpoints for a single platform ticket.
//   GET    — fetch ticket + thread for the detail page
//   PATCH  — change status (Reopen banner, manual transitions)
// Session auth is enforced by the global middleware before the handler
// runs; we still call getCurrentSession() to attribute reply/status
// changes to the platform admin who acted.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  getPlatformTicket,
  getPlatformTicketReplies,
  updatePlatformTicketStatus,
} from "@/lib/db/platform-tickets";
import { getCurrentSession } from "@/lib/auth/session-jwt";
import { logger } from "@/lib/logger";

const patchSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed"]),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const ticket = await getPlatformTicket(id);
    if (!ticket) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const replies = await getPlatformTicketReplies(id);
    return NextResponse.json({ ticket, replies });
  } catch (err) {
    logger.error("[admin platform-tickets GET id] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.format() },
      { status: 400 },
    );
  }
  try {
    const ticket = await updatePlatformTicketStatus(id, parsed.data.status);
    if (!ticket) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ticket });
  } catch (err) {
    logger.error("[admin platform-tickets PATCH] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
