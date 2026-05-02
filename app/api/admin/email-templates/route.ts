// B1 — Email templates registry: list endpoint.

import { NextResponse, type NextRequest } from "next/server";
import { listEmailTemplates } from "@/lib/db/email-templates";
import { logger } from "@/lib/logger";
import type { Mark8lyDatabase } from "@/lib/db/mark8ly";

const ALLOWED_DBS: ReadonlyArray<Mark8lyDatabase> = ["platform_api", "marketplace_api"];

function pickDB(raw: string | null): Mark8lyDatabase {
  if (!raw) return "platform_api";
  return ALLOWED_DBS.includes(raw as Mark8lyDatabase)
    ? (raw as Mark8lyDatabase)
    : "platform_api";
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const database = pickDB(url.searchParams.get("database"));
  try {
    const templates = await listEmailTemplates(database);
    return NextResponse.json({ database, templates });
  } catch (err) {
    logger.error("[admin email-templates GET] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
