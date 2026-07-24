import { NextResponse } from "next/server";
import {
  getBreakGlassSummary,
  listBreakGlassAccounts,
} from "@/lib/db/break-glass";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const [summary, rows] = await Promise.all([
      getBreakGlassSummary(),
      listBreakGlassAccounts(),
    ]);
    return NextResponse.json({
      summary,
      rows,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("[break-glass GET] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
