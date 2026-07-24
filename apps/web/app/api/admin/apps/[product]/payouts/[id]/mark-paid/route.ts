// PUT /api/admin/apps/:product/payouts/:id/mark-paid  { payoutRef }
// Records a manual disbursement against a weekly statement (homechef only).
// Direct homechef_db write in a txn + audit row. Idempotent. Auth: middleware.ts.

import { NextResponse, type NextRequest } from "next/server";

import { markStatementPaid } from "@/lib/db/homechef-payouts";
import { logger } from "@/lib/logger";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ product: string; id: string }> },
) {
  const { product, id } = await params;
  if (product !== "homechef") {
    return NextResponse.json({ error: "unsupported_product" }, { status: 404 });
  }

  let body: { payoutRef?: string };
  try {
    body = (await req.json()) as { payoutRef?: string };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const payoutRef = body.payoutRef?.trim();
  if (!payoutRef) {
    return NextResponse.json({ error: "payoutRef_required" }, { status: 400 });
  }

  try {
    const { row, alreadyPaid } = await markStatementPaid(id, payoutRef);
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ data: row, alreadyPaid });
  } catch (err) {
    logger.error("[homechef-payouts] mark-paid failed", err);
    return NextResponse.json({ error: "mark_paid_failed" }, { status: 500 });
  }
}
