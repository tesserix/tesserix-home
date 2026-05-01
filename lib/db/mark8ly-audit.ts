// Cross-DB read helpers for mark8ly audit_logs. Read-only.

import { mark8lyQuery } from "./mark8ly";

export interface AuditLogRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly store_id: string;
  readonly actor_user_id: string | null;
  readonly actor_email: string | null;
  readonly actor_type: string;
  readonly action: string;
  readonly resource_type: string;
  readonly resource_id: string | null;
  readonly status: string;
  readonly severity: string;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly metadata: Record<string, unknown>;
  readonly created_at: string;
}

export interface AuditFilter {
  readonly severity?: string;
  readonly status?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly actorEmail?: string;
  readonly tenantId?: string;
  readonly sinceHours?: number;
  readonly limit?: number;
}

export async function listAuditLogs(filter: AuditFilter = {}): Promise<AuditLogRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (filter.severity) {
    where.push(`severity = $${i++}`);
    params.push(filter.severity);
  }
  if (filter.status) {
    where.push(`status = $${i++}`);
    params.push(filter.status);
  }
  if (filter.action) {
    where.push(`action ILIKE $${i++}`);
    params.push(`%${filter.action}%`);
  }
  if (filter.resourceType) {
    where.push(`resource_type = $${i++}`);
    params.push(filter.resourceType);
  }
  if (filter.actorEmail) {
    where.push(`actor_email ILIKE $${i++}`);
    params.push(`%${filter.actorEmail}%`);
  }
  if (filter.tenantId) {
    where.push(`tenant_id = $${i++}::uuid`);
    params.push(filter.tenantId);
  }
  if (filter.sinceHours) {
    where.push(`created_at >= now() - ($${i++} || ' hours')::interval`);
    params.push(String(filter.sinceHours));
  }

  const limit = Math.min(filter.limit ?? 200, 1000);
  const sql = `
    SELECT id, tenant_id, store_id, actor_user_id, actor_email, actor_type,
           action, resource_type, resource_id, status, severity,
           host(ip_address)::text AS ip_address, user_agent, metadata, created_at
    FROM audit_logs
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  const res = await mark8lyQuery<AuditLogRow>("marketplace_api", sql, params);
  return res.rows;
}

export async function getCriticalEventCount(sinceHours = 24): Promise<number> {
  const res = await mark8lyQuery<{ n: string }>(
    "marketplace_api",
    `SELECT count(*)::bigint AS n
     FROM audit_logs
     WHERE severity = 'critical'
       AND created_at >= now() - ($1 || ' hours')::interval`,
    [String(sinceHours)],
  );
  return Number(res.rows[0]?.n ?? 0);
}

// Distinct values for filter dropdowns. Cached implicitly by the route's
// SWR layer; cheap on a small audit table.
export async function getAuditFilterOptions(): Promise<{
  actions: string[];
  resourceTypes: string[];
}> {
  const [actions, resources] = await Promise.all([
    mark8lyQuery<{ action: string }>(
      "marketplace_api",
      `SELECT DISTINCT action FROM audit_logs ORDER BY action LIMIT 100`,
    ),
    mark8lyQuery<{ resource_type: string }>(
      "marketplace_api",
      `SELECT DISTINCT resource_type FROM audit_logs ORDER BY resource_type LIMIT 100`,
    ),
  ]);
  return {
    actions: actions.rows.map((r) => r.action),
    resourceTypes: resources.rows.map((r) => r.resource_type),
  };
}
