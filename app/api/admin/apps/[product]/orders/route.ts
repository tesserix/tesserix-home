// GET /api/admin/apps/:product/orders?status=&page=
// Recent orders + GMV summary (homechef only), direct from homechef_db.
// Read-only customer-ops oversight. Auth: middleware.ts.

import { NextResponse, type NextRequest } from "next/server";

import { countOrders, getOrdersSummary, listOrders } from "@/lib/db/homechef-orders";
import { logger } from "@/lib/logger";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ product: string }> },
) {
  const { product } = await params;
  if (product !== "homechef") {
    return NextResponse.json({ error: "unsupported_product" }, { status: 404 });
  }

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const limit = 25;
  const offset = (page - 1) * limit;
  const filter = { status: url.searchParams.get("status") ?? undefined, limit, offset };

  try {
    const [data, total, summary] = await Promise.all([
      listOrders(filter),
      countOrders(filter),
      getOrdersSummary({ status: filter.status }),
    ]);
    return NextResponse.json({
      data,
      summary,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error("[homechef-orders] list failed", err);
    return NextResponse.json({ error: "orders_query_failed" }, { status: 500 });
  }
}
