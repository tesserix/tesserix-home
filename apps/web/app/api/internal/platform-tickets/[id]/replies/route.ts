// Internal endpoint: merchant reply on a ticket. Bearer-authed.
// Caller forwards the merchant's identity (name/email/userId) from
// its own authenticated session. Cross-tenant guard mirrors the GET
// route — merchant can only reply to their own ticket.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  createPlatformTicketReply,
  getPlatformTicket,
} from "@/lib/db/platform-tickets";
import { logger } from "@/lib/logger";

const replySchema = z.object({
  productId: z.string().min(1),
  tenantId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid UUID"),
  content: z.string().min(1).max(10_000),
  authorName: z.string().min(1).max(200),
  authorEmail: z.string().email().max(300).optional(),
  // Foreign user id (Firebase UID, etc.) — not enforced as UUID.
  authorUserId: z.string().min(1).max(200).optional(),
});

function authorize(req: NextRequest): boolean {
  const expected = (process.env.INTERNAL_API_TOKEN ?? "").trim();
  if (!expected) return false;
  const supplied = (req.headers.get("x-internal-token") ?? "").trim();
  return supplied !== "" && supplied === expected;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!authorize(req)) {
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
    // Verify ownership before writing — same 404-on-mismatch convention.
    const ticket = await getPlatformTicket(id);
    if (
      !ticket ||
      ticket.product_id !== parsed.data.productId ||
      ticket.tenant_id !== parsed.data.tenantId
    ) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // Merchants can't reply once the ticket is closed (resolved is fine —
    // the merchant might want to reopen with a follow-up).
    if (ticket.status === "closed") {
      return NextResponse.json({ error: "ticket_closed" }, { status: 409 });
    }

    const reply = await createPlatformTicketReply({
      ticketId: id,
      authorType: "merchant",
      authorName: parsed.data.authorName,
      authorEmail: parsed.data.authorEmail,
      authorUserId: parsed.data.authorUserId,
      content: parsed.data.content,
      // If the ticket was resolved, a merchant reply re-opens it so the
      // platform team sees the new message in their open queue.
      newStatus: ticket.status === "resolved" ? "open" : undefined,
    });
    return NextResponse.json({ reply }, { status: 201 });
  } catch (err) {
    logger.error("[internal platform-tickets reply POST] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
