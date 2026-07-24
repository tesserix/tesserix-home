// F3 — GDPR erasure request queue (read-only).
// Reads mark8ly_marketplace_api.customer_erasure_requests, joining stores
// for human-readable context. Status values per mark8ly migration:
// "pending", "processing", "completed", "failed".

import { mark8lyQuery } from "./mark8ly";

export interface ErasureRequestRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly store_id: string;
  readonly customer_email: string;
  readonly requested_at: string;
  readonly status: string;
  readonly processed_at: string | null;
  readonly notes: string | null;
  readonly store_name: string | null;
  /** Hours since request — used to flag SLA breaches in the UI. */
  readonly hours_pending: number;
}

export interface ErasureRequestsSummary {
  readonly pending: number;
  readonly processing: number;
  readonly completedThisWeek: number;
  readonly failed: number;
  /** Oldest pending request, in hours. Null when none pending. */
  readonly oldestPendingHours: number | null;
}

export interface ListFilter {
  readonly status?: "pending" | "processing" | "completed" | "failed" | "all";
  readonly limit?: number;
}

export async function getErasureRequestsSummary(): Promise<ErasureRequestsSummary> {
  const sql = `
    SELECT
      count(*) FILTER (WHERE status = 'pending')::bigint                              AS pending,
      count(*) FILTER (WHERE status = 'processing')::bigint                           AS processing,
      count(*) FILTER (WHERE status = 'completed' AND processed_at >= now() - interval '7 days')::bigint AS completed_this_week,
      count(*) FILTER (WHERE status = 'failed')::bigint                               AS failed,
      EXTRACT(EPOCH FROM (now() - min(requested_at) FILTER (WHERE status = 'pending'))) / 3600.0 AS oldest_pending_hours
    FROM customer_erasure_requests
  `;
  const res = await mark8lyQuery<{
    pending: string;
    processing: string;
    completed_this_week: string;
    failed: string;
    oldest_pending_hours: string | null;
  }>("marketplace_api", sql);
  const r = res.rows[0];
  return {
    pending: Number(r?.pending ?? 0),
    processing: Number(r?.processing ?? 0),
    completedThisWeek: Number(r?.completed_this_week ?? 0),
    failed: Number(r?.failed ?? 0),
    oldestPendingHours: r?.oldest_pending_hours
      ? Math.round(Number(r.oldest_pending_hours))
      : null,
  };
}

export async function listErasureRequests(
  filter: ListFilter = {},
): Promise<ErasureRequestRow[]> {
  const status = filter.status ?? "pending";
  const limit = Math.min(filter.limit ?? 200, 500);

  const where: string[] = [];
  const params: unknown[] = [];
  if (status !== "all") {
    where.push(`er.status = $${params.length + 1}`);
    params.push(status);
  }

  const sql = `
    SELECT
      er.id::text,
      er.tenant_id::text,
      er.store_id::text,
      er.customer_email,
      er.requested_at,
      er.status,
      er.processed_at,
      er.notes,
      s.name AS store_name,
      EXTRACT(EPOCH FROM (now() - er.requested_at)) / 3600.0 AS hours_pending
    FROM customer_erasure_requests er
    LEFT JOIN stores s ON s.id = er.store_id
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY
      CASE er.status
        WHEN 'pending' THEN 0
        WHEN 'processing' THEN 1
        WHEN 'failed' THEN 2
        WHEN 'completed' THEN 3
        ELSE 4
      END,
      er.requested_at DESC
    LIMIT ${limit}
  `;
  const res = await mark8lyQuery<{
    id: string;
    tenant_id: string;
    store_id: string;
    customer_email: string;
    requested_at: string;
    status: string;
    processed_at: string | null;
    notes: string | null;
    store_name: string | null;
    hours_pending: string;
  }>("marketplace_api", sql, params);

  return res.rows.map((r) => ({
    id: r.id,
    tenant_id: r.tenant_id,
    store_id: r.store_id,
    customer_email: r.customer_email,
    requested_at: r.requested_at,
    status: r.status,
    processed_at: r.processed_at,
    notes: r.notes,
    store_name: r.store_name,
    hours_pending: Math.round(Number(r.hours_pending ?? 0)),
  }));
}
