// GET /api/admin/tenants — list tenants from mark8ly_platform_api.
// Read-only on this endpoint. Status mutation goes through PATCH on
// /api/admin/tenants/:id (not the same as mark8ly's own tenants UI).

import { NextResponse, type NextRequest } from "next/server";

import { mark8lyQuery } from "@/lib/db/mark8ly";
import type { TenantRow } from "@/lib/db/types";
import { logger } from "@/lib/logger";

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status");

  try {
    const result = statusFilter
      ? await mark8lyQuery<TenantRow>(
          "platform_api",
          `SELECT id, name, owner_user_id, owner_email, status, created_at, updated_at
           FROM tenants WHERE status = $1
           ORDER BY created_at DESC LIMIT 500`,
          [statusFilter],
        )
      : await mark8lyQuery<TenantRow>(
          "platform_api",
          `SELECT id, name, owner_user_id, owner_email, status, created_at, updated_at
           FROM tenants
           ORDER BY created_at DESC LIMIT 500`,
        );
    return NextResponse.json({ tenants: result.rows });
  } catch (err) {
    logger.error("[tenants GET] failed", err);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
