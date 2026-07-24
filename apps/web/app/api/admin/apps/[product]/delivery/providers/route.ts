// GET /api/admin/apps/:product/delivery/providers — 3PL providers (homechef).
// Read-only list; key config + test stay in homechef-api. Auth: middleware.ts.

import { NextResponse, type NextRequest } from "next/server";

import { listProviders } from "@/lib/db/homechef-delivery";
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
    return NextResponse.json({ data: await listProviders() });
  } catch (err) {
    logger.error("[homechef-delivery] providers list failed", err);
    return NextResponse.json({ error: "providers_query_failed" }, { status: 500 });
  }
}
