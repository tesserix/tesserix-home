// GET /api/admin/apps/:product/payouts?status=&chefId=&week=&page=&limit=
// Paginated list of all chefs' weekly settlement statements (homechef only).
// Reads homechef_db directly as homechef_platform_admin. Auth: middleware.ts.

import { NextResponse, type NextRequest } from "next/server";

import { countStatements, listStatements } from "@/lib/db/homechef-payouts";
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
  const limitRaw = Number(url.searchParams.get("limit") ?? "20") || 20;
  const limit = Math.min(100, Math.max(1, limitRaw));
  const offset = (page - 1) * limit;

  const filter = {
    status: url.searchParams.get("status") ?? undefined,
    chefId: url.searchParams.get("chefId") ?? undefined,
    week: url.searchParams.get("week") ?? undefined,
    limit,
    offset,
  };

  try {
    const [data, total] = await Promise.all([
      listStatements(filter),
      countStatements(filter),
    ]);
    return NextResponse.json({
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error("[homechef-payouts] list failed", err);
    return NextResponse.json({ error: "payouts_query_failed" }, { status: 500 });
  }
}
