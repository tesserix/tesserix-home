// M2 — Custom-domain DNS verification: read endpoint.

import { NextResponse } from "next/server";
import { listCustomDomains } from "@/lib/db/custom-domains";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const domains = await listCustomDomains();
    return NextResponse.json({ domains });
  } catch (err) {
    logger.error("[admin custom-domains GET] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
