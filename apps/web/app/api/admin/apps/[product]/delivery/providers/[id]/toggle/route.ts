// PUT /api/admin/apps/:product/delivery/providers/:id/toggle — flip is_enabled
// (homechef). Direct DB write in a txn + audit row. Auth: middleware.ts.

import { NextResponse, type NextRequest } from "next/server";

import { toggleProvider } from "@/lib/db/homechef-delivery";
import { logger } from "@/lib/logger";

export async function PUT(
  _req: NextRequest,
  { params }: { params: Promise<{ product: string; id: string }> },
) {
  const { product, id } = await params;
  if (product !== "homechef") {
    return NextResponse.json({ error: "unsupported_product" }, { status: 404 });
  }
  try {
    const result = await toggleProvider(id);
    if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ data: result });
  } catch (err) {
    logger.error("[homechef-delivery] toggle failed", err);
    return NextResponse.json({ error: "toggle_failed" }, { status: 500 });
  }
}
