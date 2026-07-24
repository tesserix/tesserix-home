// GET /api/admin/apps/:product/revenue?window=30d
// Aggregate MRR/ARR/churn/new-trials for the product Overview Revenue tile.

import { NextResponse, type NextRequest } from "next/server";

import { getRevenueMetrics } from "@/lib/metrics/revenue";
import { getProductConfig } from "@/lib/products/configs";
import { logger } from "@/lib/logger";

const VALID_DAYS = new Set(["30", "90", "365"]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ product: string }> },
) {
  const { product } = await params;
  let config;
  try {
    config = getProductConfig(product);
  } catch {
    return NextResponse.json({ error: "unknown_product" }, { status: 404 });
  }
  if (!config.pricingByPlan || !config.pricingCurrency) {
    return NextResponse.json({ error: "billing_not_configured" }, { status: 404 });
  }

  const url = new URL(req.url);
  const rawDays = url.searchParams.get("days") ?? "30";
  const days = VALID_DAYS.has(rawDays) ? Number(rawDays) : 30;

  try {
    const data = await getRevenueMetrics(config, days);
    if (!data) {
      return NextResponse.json({ error: "billing_not_configured" }, { status: 404 });
    }
    return NextResponse.json({ ...data, days, generatedAt: new Date().toISOString() });
  } catch (err) {
    logger.error(`[revenue] failed for ${product}`, err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
