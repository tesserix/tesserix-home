// GET /api/admin/apps/:product/tenants/:id/metrics?window=24h
// Tenant-level activity + cost-share + email metrics. Auth via middleware.ts.

import { NextResponse, type NextRequest } from "next/server";

import { getTenantMetrics } from "@/lib/metrics/tenant-metrics";
import { getProductConfig } from "@/lib/products/configs";
import { isValidWindow, type Window } from "@/lib/metrics/window";
import { logger } from "@/lib/logger";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ product: string; id: string }> },
) {
  const { product, id } = await params;
  const url = new URL(req.url);
  const rawWindow = url.searchParams.get("window") ?? "24h";
  const window: Window = isValidWindow(rawWindow) ? rawWindow : "24h";

  let config;
  try {
    config = getProductConfig(product);
  } catch {
    return NextResponse.json({ error: "unknown_product" }, { status: 404 });
  }

  try {
    const data = await getTenantMetrics(config, id, window);
    return NextResponse.json(data);
  } catch (err) {
    logger.error(`[tenant-metrics] aggregation failed for ${product}/${id}`, err);
    return NextResponse.json(
      { error: "metrics_unavailable" },
      { status: 500 },
    );
  }
}
