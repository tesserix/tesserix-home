// GET /api/admin/apps/:product/kpis
// Product-scoped business KPIs for the overview's KPI tiles, returned as a
// { [tileKey]: number } map. Each product computes its own from its own DB.
// Unknown / not-yet-wired products return {} so the overview falls back to the
// platform dashboard (mark8ly's tenants/stores/leads path is unaffected).
//
// Auth: gated by middleware.ts (default-deny /api/* without an admin session).

import { NextResponse } from "next/server";

import { getHomechefKpisSafe } from "@/lib/db/homechef-kpis";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ product: string }> },
) {
  const { product } = await params;

  switch (product) {
    case "homechef": {
      const kpis = await getHomechefKpisSafe();
      return NextResponse.json(kpis);
    }
    default:
      // No product-scoped KPIs wired — overview uses its fallback path.
      return NextResponse.json({});
  }
}
