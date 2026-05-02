// Super-admin reply on a platform ticket. Session-authed via the
// global middleware. Body may include a status transition that fires
// in the same transaction as the reply (per UX-SPEC §3 "status change
// on send").

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createPlatformTicketReply } from "@/lib/db/platform-tickets";
import { getCurrentSession } from "@/lib/auth/session-jwt";
import { logger } from "@/lib/logger";

const replySchema = z.object({
  content: z.string().min(1).max(10_000),
  newStatus: z
    .enum(["open", "in_progress", "resolved", "closed"])
    .optional(),
});

export async function POST(
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
  const parsed = replySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.format() },
      { status: 400 },
    );
  }
  try {
    const reply = await createPlatformTicketReply({
      ticketId: id,
      authorType: "platform_admin",
      authorName: session.name ?? session.email,
      authorEmail: session.email,
      // session.sub is the Google `sub` (a stable opaque string, NOT
      // a UUID) — the column is TEXT for exactly this reason.
      authorUserId: session.sub,
      content: parsed.data.content,
      newStatus: parsed.data.newStatus,
    });
    return NextResponse.json({ reply }, { status: 201 });
  } catch (err) {
    logger.error("[admin platform-tickets reply POST] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
