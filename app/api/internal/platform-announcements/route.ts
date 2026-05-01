// Internal endpoint: products (mark8ly admin) call this to fetch the
// active announcements for a given product+tenant. Symmetric to the
// platform-tickets internal route — same shared bearer token in
// INTERNAL_API_TOKEN. The caller passes `?product=` and optionally
// `?tenant_status=` (the tenant's lifecycle status — active, trialing,
// suspended — used by audience filters that target by status).

import { NextResponse, type NextRequest } from "next/server";
import { getActiveAnnouncementsForTenant } from "@/lib/db/platform-announcements";
import { logger } from "@/lib/logger";

function authorize(req: NextRequest): boolean {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${expected}`;
}

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const productId = url.searchParams.get("product");
  const tenantStatus = url.searchParams.get("tenant_status") ?? "active";
  if (!productId) {
    return NextResponse.json({ error: "missing_product" }, { status: 400 });
  }
  try {
    const rows = await getActiveAnnouncementsForTenant(productId, tenantStatus);
    return NextResponse.json({ rows });
  } catch (err) {
    logger.error("[internal platform-announcements GET] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
