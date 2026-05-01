// GET /api/admin/apps/:product/audit-logs?severity=&status=&action=&resource_type=&actor_email=&since_hours=&tenant_id=

import { NextResponse, type NextRequest } from "next/server";

import { mark8lyQuery } from "@/lib/db/mark8ly";
import {
  getAuditFilterOptions,
  getCriticalEventCount,
  listAuditLogs,
  type AuditLogRow,
} from "@/lib/db/mark8ly-audit";
import { getProductConfig } from "@/lib/products/configs";
import { logger } from "@/lib/logger";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ product: string }> },
) {
  const { product } = await params;
  try {
    getProductConfig(product);
  } catch {
    return NextResponse.json({ error: "unknown_product" }, { status: 404 });
  }

  const url = new URL(req.url);
  const sinceHoursRaw = url.searchParams.get("since_hours");
  const sinceHours = sinceHoursRaw ? Math.max(1, Math.min(720, Number(sinceHoursRaw))) : 24;

  try {
    const [rows, criticalCount, options] = await Promise.all([
      listAuditLogs({
        severity: url.searchParams.get("severity") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        action: url.searchParams.get("action") ?? undefined,
        resourceType: url.searchParams.get("resource_type") ?? undefined,
        actorEmail: url.searchParams.get("actor_email") ?? undefined,
        tenantId: url.searchParams.get("tenant_id") ?? undefined,
        sinceHours,
      }),
      getCriticalEventCount(24),
      getAuditFilterOptions(),
    ]);

    const tenantIds = Array.from(new Set(rows.map((r) => r.tenant_id)));
    const namesById = new Map<string, string>();
    if (tenantIds.length > 0) {
      const namesRes = await mark8lyQuery<{ id: string; name: string }>(
        "platform_api",
        `SELECT id::text, name FROM tenants WHERE id = ANY($1::uuid[])`,
        [tenantIds],
      );
      for (const r of namesRes.rows) namesById.set(r.id, r.name);
    }

    return NextResponse.json({
      summary: { criticalLast24h: criticalCount },
      filterOptions: options,
      rows: rows.map((r: AuditLogRow) => ({
        ...r,
        tenantName: namesById.get(r.tenant_id) ?? r.tenant_id,
      })),
      sinceHours,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error(`[audit-logs] failed for ${product}`, err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
