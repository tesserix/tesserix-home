import { NextResponse, type NextRequest } from "next/server";
import {
  getPlatformTicketsSummary,
  listPlatformTickets,
} from "@/lib/db/platform-tickets";
import { logger } from "@/lib/logger";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  try {
    const [summary, rows] = await Promise.all([
      getPlatformTicketsSummary(),
      listPlatformTickets({
        status: url.searchParams.get("status") ?? undefined,
        priority: url.searchParams.get("priority") ?? undefined,
        productId: url.searchParams.get("product") ?? undefined,
      }),
    ]);
    return NextResponse.json({ summary, rows, generatedAt: new Date().toISOString() });
  } catch (err) {
    logger.error("[platform-tickets list] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
