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

// Accept any 8-4-4-4-12 hex string for UUID fields. We avoid z.string().uuid()
// because newer Zod versions enforce variant/version bits — mark8ly's tenant
// and user IDs are real UUIDs but not strict v4. Postgres still rejects
// malformed UUIDs at the ::uuid cast in the INSERT, so this stays safe.
const uuidLike = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid UUID");

const createSchema = z.object({
  productId: z.string().min(1),
  tenantId: uuidLike,
  subject: z.string().min(1).max(300),
  description: z.string().min(1),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  submittedByName: z.string().min(1).max(200),
  submittedByEmail: z.string().email().max(300),
  submittedByUserId: uuidLike.optional(),
});

function authorize(req: NextRequest): boolean {
  // We use a custom X-Internal-Token header instead of Authorization
  // because the istio-ingress layer has a RequestAuthentication policy
  // that intercepts `Authorization: Bearer ...`, tries to parse it as
  // a JWT, and rejects opaque tokens with 401 ("Jwt is not in the form
  // of Header.Payload.Signature..."). A custom header bypasses that.
  //
  // trim() defends against trailing whitespace introduced by GSM/ESO
  // when a secret was created with `<<<` heredoc or echo (both append a
  // newline). An attacker can't influence env, so this is loss-less.
  const expected = (process.env.INTERNAL_API_TOKEN ?? "").trim();
  if (!expected) return false;
  const supplied = (req.headers.get("x-internal-token") ?? "").trim();
  return supplied !== "" && supplied === expected;
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
