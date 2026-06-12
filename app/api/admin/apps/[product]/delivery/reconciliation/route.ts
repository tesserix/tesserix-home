// GET /api/admin/apps/:product/delivery/reconciliation — 3PL cost vs collected
// delivery fee (homechef). Read-only. Auth: middleware.ts.

import { NextResponse, type NextRequest } from "next/server";

import { getReconciliation } from "@/lib/db/homechef-delivery";
import { logger } from "@/lib/logger";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ product: string }> },
) {
  const { product } = await params;
  if (product !== "homechef") {
    return NextResponse.json({ error: "unsupported_product" }, { status: 404 });
  }
  try {
    return NextResponse.json({ data: await getReconciliation() });
  } catch (err) {
    logger.error("[homechef-delivery] reconciliation failed", err);
    return NextResponse.json({ error: "reconciliation_failed" }, { status: 500 });
  }
}
