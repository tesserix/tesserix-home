// GET /api/admin/apps/:product/payouts/export?status=&chefId=&week=
// Streams all matching weekly statements as CSV (homechef only, no pagination).
// Auth: middleware.ts.

import { type NextRequest } from "next/server";

import { listStatementsForExport } from "@/lib/db/homechef-payouts";
import { logger } from "@/lib/logger";

const HEADER = [
  "statement_id", "chef_id", "chef_name", "week_start", "week_end",
  "orders", "gross_revenue", "platform_commission", "cgst", "sgst", "igst",
  "tds", "net_payout", "currency", "status", "paid_at", "payout_ref",
];

function csvCell(v: string | number | null): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ product: string }> },
) {
  const { product } = await params;
  if (product !== "homechef") {
    return new Response(JSON.stringify({ error: "unsupported_product" }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const filter = {
    status: url.searchParams.get("status") ?? undefined,
    chefId: url.searchParams.get("chefId") ?? undefined,
    week: url.searchParams.get("week") ?? undefined,
  };

  try {
    const rows = await listStatementsForExport(filter);
    const lines = [HEADER.join(",")];
    for (const s of rows) {
      lines.push([
        s.id, s.chef_id, s.chef_name ?? "", s.week_start.slice(0, 10), s.week_end.slice(0, 10),
        s.orders_count, s.gross_revenue.toFixed(2), s.platform_commission.toFixed(2),
        s.cgst.toFixed(2), s.sgst.toFixed(2), s.igst.toFixed(2), s.tds.toFixed(2),
        s.net_payout.toFixed(2), s.currency, s.status, s.paid_at ?? "", s.payout_ref ?? "",
      ].map(csvCell).join(","));
    }
    return new Response(lines.join("\n"), {
      status: 200,
      headers: {
        "content-type": "text/csv",
        "content-disposition": "attachment; filename=homechef_weekly_statements.csv",
      },
    });
  } catch (err) {
    logger.error("[homechef-payouts] export failed", err);
    return new Response(JSON.stringify({ error: "export_failed" }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
}
