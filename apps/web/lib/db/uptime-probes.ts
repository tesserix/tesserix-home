// M1 — Synthetic uptime probes.
// Data layer for tenant_uptime_probes (write from /api/internal/uptime/probe,
// read from /admin/uptime).

import { tesserixQuery } from "./tesserix";

export interface ProbeResultInput {
  readonly productId: string;
  readonly tenantId: string;
  readonly hostname: string;
  readonly httpStatus: number | null;
  readonly latencyMs: number | null;
  readonly ok: boolean;
  readonly error: string | null;
}

export async function recordProbeBatch(
  rows: ReadonlyArray<ProbeResultInput>,
): Promise<number> {
  if (rows.length === 0) return 0;
  // Multi-row INSERT in one round trip — the cron runs every 5 min so a
  // single batch INSERT is much cheaper than N round trips.
  const values: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const r of rows) {
    values.push(
      `($${i++}, $${i++}::uuid, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`,
    );
    params.push(
      r.productId,
      r.tenantId,
      r.hostname,
      r.httpStatus,
      r.latencyMs,
      r.ok,
      r.error,
    );
  }
  const sql = `
    INSERT INTO tenant_uptime_probes
      (product_id, tenant_id, hostname, http_status, latency_ms, ok, error)
    VALUES ${values.join(", ")}
  `;
  const res = await tesserixQuery(sql, params);
  return res.rowCount ?? 0;
}

export interface TenantUptimeRow {
  readonly product_id: string;
  readonly tenant_id: string;
  readonly hostname: string;
  /** Total probes considered in this row's window. */
  readonly probes: number;
  readonly successes: number;
  /** 0..1 success ratio. */
  readonly uptime: number;
  readonly p50_latency_ms: number | null;
  readonly p95_latency_ms: number | null;
  readonly last_probed_at: string;
  readonly last_ok: boolean;
  readonly last_error: string | null;
  readonly last_status: number | null;
}

export interface UptimeWindow {
  readonly hours: number;
}

export async function getTenantUptimeSummary(
  window: UptimeWindow = { hours: 24 },
): Promise<TenantUptimeRow[]> {
  const hours = Math.max(1, Math.min(window.hours, 24 * 30));
  // One row per (product, tenant, hostname) covering the window. Last-
  // probe details from a lateral join so a single down-now signal is
  // visible alongside the rolling uptime number.
  const sql = `
    WITH probes AS (
      SELECT product_id, tenant_id, hostname, ok, latency_ms, http_status, error, probed_at
      FROM tenant_uptime_probes
      WHERE probed_at > now() - interval '${hours} hours'
    ),
    aggs AS (
      SELECT
        product_id, tenant_id, hostname,
        count(*)::bigint                               AS probes,
        count(*) FILTER (WHERE ok)::bigint             AS successes,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok) AS p95,
        max(probed_at)                                 AS last_probed_at
      FROM probes
      GROUP BY product_id, tenant_id, hostname
    )
    SELECT
      a.product_id,
      a.tenant_id::text,
      a.hostname,
      a.probes,
      a.successes,
      CASE WHEN a.probes = 0 THEN 0
           ELSE a.successes::float / a.probes::float
      END                                              AS uptime,
      a.p50                                            AS p50_latency_ms,
      a.p95                                            AS p95_latency_ms,
      a.last_probed_at,
      latest.ok                                        AS last_ok,
      latest.error                                     AS last_error,
      latest.http_status                               AS last_status
    FROM aggs a
    LEFT JOIN LATERAL (
      SELECT ok, error, http_status
      FROM tenant_uptime_probes p
      WHERE p.product_id = a.product_id
        AND p.tenant_id  = a.tenant_id
        AND p.hostname   = a.hostname
      ORDER BY probed_at DESC
      LIMIT 1
    ) latest ON true
    ORDER BY uptime ASC, a.hostname ASC
  `;
  const res = await tesserixQuery<{
    product_id: string;
    tenant_id: string;
    hostname: string;
    probes: string;
    successes: string;
    uptime: string;
    p50_latency_ms: string | null;
    p95_latency_ms: string | null;
    last_probed_at: string;
    last_ok: boolean;
    last_error: string | null;
    last_status: number | null;
  }>(sql);
  return res.rows.map((r) => ({
    product_id: r.product_id,
    tenant_id: r.tenant_id,
    hostname: r.hostname,
    probes: Number(r.probes ?? 0),
    successes: Number(r.successes ?? 0),
    uptime: Number(r.uptime ?? 0),
    p50_latency_ms: r.p50_latency_ms ? Math.round(Number(r.p50_latency_ms)) : null,
    p95_latency_ms: r.p95_latency_ms ? Math.round(Number(r.p95_latency_ms)) : null,
    last_probed_at: r.last_probed_at,
    last_ok: r.last_ok,
    last_error: r.last_error,
    last_status: r.last_status,
  }));
}

export interface ProbeTarget {
  readonly productId: string;
  readonly tenantId: string;
  readonly hostname: string;
}
