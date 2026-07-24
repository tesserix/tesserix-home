// Internal endpoint: fetches a single ticket + its reply thread for
// the merchant detail page. Bearer-authed via X-Internal-Token. Caller
// must pass ?product= and ?tenant_id= so we can verify the ticket
// belongs to the requesting tenant — without that check, any tenant
// holding the shared bearer could read any other tenant's tickets.

import { NextResponse, type NextRequest } from "next/server";
import {
  getPlatformTicket,
  getPlatformTicketReplies,
} from "@/lib/db/platform-tickets";
import { logger } from "@/lib/logger";

function authorize(req: NextRequest): boolean {
  const expected = (process.env.INTERNAL_API_TOKEN ?? "").trim();
  if (!expected) return false;
  const supplied = (req.headers.get("x-internal-token") ?? "").trim();
  return supplied !== "" && supplied === expected;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const url = new URL(req.url);
  const productId = url.searchParams.get("product");
  const tenantId = url.searchParams.get("tenant_id");
  if (!productId || !tenantId) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  try {
    const ticket = await getPlatformTicket(id);
    if (!ticket) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // Cross-tenant guard: a merchant must only ever see their own ticket.
    // 404 (not 403) so we don't leak existence.
    if (ticket.product_id !== productId || ticket.tenant_id !== tenantId) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const replies = await getPlatformTicketReplies(id);
    return NextResponse.json({ ticket, replies });
  } catch (err) {
    logger.error("[internal platform-tickets GET id] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
