// GET /api/admin/apps/:product/metrics?window=24h
// Aggregated resource + cost + email metrics for one product. Auth gated
// by middleware.ts (default-deny without admin session). Per-route 60s
// cache lives in the underlying Prometheus/OpenCost clients.

import { NextResponse, type NextRequest } from "next/server";

import { getProductMetrics } from "@/lib/metrics/product-metrics";
import { getProductConfig } from "@/lib/products/configs";
import { isValidWindow, type Window } from "@/lib/metrics/window";
import { logger } from "@/lib/logger";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ product: string }> },
) {
  const { product } = await params;
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
    const data = await getProductMetrics(config, window);
    return NextResponse.json(data);
  } catch (err) {
    logger.error(`[product-metrics] aggregation failed for ${product}`, err);
    return NextResponse.json(
      { error: "metrics_unavailable" },
      { status: 500 },
    );
  }
}
