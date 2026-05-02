// B2 — Lead templates list endpoint.
import { NextResponse } from "next/server";
import { listLeadTemplates } from "@/lib/db/lead-templates";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const templates = await listLeadTemplates();
    return NextResponse.json({ templates });
  } catch (err) {
    logger.error("[admin lead-templates GET] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
