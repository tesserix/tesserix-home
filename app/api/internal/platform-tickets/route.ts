// Internal endpoint: products (mark8ly admin) call this to file a platform
// support ticket on behalf of a merchant. Auth via shared bearer token in
// env var INTERNAL_API_TOKEN. The caller (mark8ly admin server) is trusted
// to populate the submitter identity headers from its session.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  createPlatformTicket,
  listPlatformTickets,
} from "@/lib/db/platform-tickets";
import { logger } from "@/lib/logger";

const createSchema = z.object({
  productId: z.string().min(1),
  tenantId: z.string().uuid(),
  subject: z.string().min(1).max(300),
  description: z.string().min(1),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  submittedByName: z.string().min(1).max(200),
  submittedByEmail: z.string().email().max(300),
  submittedByUserId: z.string().uuid().optional(),
});

function authorize(req: NextRequest): boolean {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${expected}`;
}

export async function POST(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.format() },
      { status: 400 },
    );
  }
  try {
    const ticket = await createPlatformTicket(parsed.data);
    return NextResponse.json({ ticket }, { status: 201 });
  } catch (err) {
    logger.error("[internal platform-tickets POST] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}

// GET — used by merchant admin to list their own tenant's tickets.
// Caller must pass ?product=&tenant_id= (the trusted server forwards them
// from session). Bearer token still required.
export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const productId = url.searchParams.get("product");
  const tenantId = url.searchParams.get("tenant_id");
  if (!productId || !tenantId) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }
  try {
    const rows = await listPlatformTickets({ productId, tenantId, limit: 100 });
    return NextResponse.json({ rows });
  } catch (err) {
    logger.error("[internal platform-tickets GET] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
