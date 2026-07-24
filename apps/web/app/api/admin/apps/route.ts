// GET /api/admin/apps — list every product this super-admin oversees.
// Read-only Phase 1: new product onboarding is a runbook step (see
// tesserix-k8s/docs/cross-db-admin.md).

import { NextResponse } from "next/server";

import { tesserixQuery } from "@/lib/db/tesserix";
import type { AppRow } from "@/lib/db/types";
import { logger } from "@/lib/logger";

export async function GET(): Promise<Response> {
  try {
    const result = await tesserixQuery<AppRow>(
      `SELECT id, slug, name, description, status,
              db_namespace, db_host, db_port, db_admin_secret_name, db_databases,
              primary_domain, admin_url, created_at, updated_at
       FROM apps ORDER BY created_at`,
    );
    return NextResponse.json({ apps: result.rows });
  } catch (err) {
    logger.error("[apps GET] failed", err);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
