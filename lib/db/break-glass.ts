// F4 — Break-glass account audit (read-only).
// Reads mark8ly_marketplace_api.break_glass_accounts, joining stores
// for context. SLA: any account not rotated in 90 days is "stale";
// any account used in the last 7 days is interesting and surfaces with
// a flag (legitimate break-glass use should be rare).

import { mark8lyQuery } from "./mark8ly";

export interface BreakGlassRow {
  readonly tenant_id: string;
  readonly secret_path: string;
  readonly totp_enrolled: boolean;
  readonly last_rotated_at: string | null;
  readonly last_used_at: string | null;
  readonly rotation_scheduled_at: string | null;
  readonly created_at: string;
  readonly tenant_name: string | null;
  readonly days_since_rotation: number | null;
  readonly days_since_use: number | null;
}

export interface BreakGlassSummary {
  readonly total: number;
  readonly mfaEnrolled: number;
  readonly stale90d: number;
  readonly usedThisWeek: number;
}

const STALE_AFTER_DAYS = 90;

export async function getBreakGlassSummary(): Promise<BreakGlassSummary> {
  const sql = `
    SELECT
      count(*)::bigint                                           AS total,
      count(*) FILTER (WHERE totp_enrolled)::bigint              AS mfa_enrolled,
      count(*) FILTER (WHERE last_rotated_at IS NULL
                       OR last_rotated_at <= now() - interval '${STALE_AFTER_DAYS} days')::bigint AS stale_90d,
      count(*) FILTER (WHERE last_used_at >= now() - interval '7 days')::bigint AS used_this_week
    FROM break_glass_accounts
  `;
  const res = await mark8lyQuery<{
    total: string;
    mfa_enrolled: string;
    stale_90d: string;
    used_this_week: string;
  }>("marketplace_api", sql);
  const r = res.rows[0];
  return {
    total: Number(r?.total ?? 0),
    mfaEnrolled: Number(r?.mfa_enrolled ?? 0),
    stale90d: Number(r?.stale_90d ?? 0),
    usedThisWeek: Number(r?.used_this_week ?? 0),
  };
}

// stores.tenant_id → tenant name comes from platform_api.tenants, so
// we resolve the human-readable name in two queries (one per DB) and
// merge in app code rather than try a cross-DB join.
export async function listBreakGlassAccounts(): Promise<BreakGlassRow[]> {
  const sql = `
    SELECT
      tenant_id::text,
      secret_path,
      totp_enrolled,
      last_rotated_at,
      last_used_at,
      rotation_scheduled_at,
      created_at,
      CASE WHEN last_rotated_at IS NULL THEN NULL
           ELSE EXTRACT(EPOCH FROM (now() - last_rotated_at)) / 86400.0
      END AS days_since_rotation,
      CASE WHEN last_used_at IS NULL THEN NULL
           ELSE EXTRACT(EPOCH FROM (now() - last_used_at)) / 86400.0
      END AS days_since_use
    FROM break_glass_accounts
    ORDER BY
      CASE WHEN last_rotated_at IS NULL THEN 0 ELSE 1 END,
      last_rotated_at ASC NULLS FIRST
  `;
  const res = await mark8lyQuery<{
    tenant_id: string;
    secret_path: string;
    totp_enrolled: boolean;
    last_rotated_at: string | null;
    last_used_at: string | null;
    rotation_scheduled_at: string | null;
    created_at: string;
    days_since_rotation: string | null;
    days_since_use: string | null;
  }>("marketplace_api", sql);

  const rows = res.rows;
  if (rows.length === 0) return [];

  // Resolve tenant names in a second query against platform_api so the
  // operator sees "Acme Co" rather than a UUID. Tolerate failure
  // (table missing, grant gap) by leaving tenant_name null.
  const tenantIds = rows.map((r) => r.tenant_id);
  let nameById = new Map<string, string>();
  try {
    const nameRes = await mark8lyQuery<{ id: string; name: string }>(
      "platform_api",
      `SELECT id::text, name FROM tenants WHERE id::text = ANY($1::text[])`,
      [tenantIds],
    );
    nameById = new Map(nameRes.rows.map((r) => [r.id, r.name]));
  } catch {
    /* leave names null */
  }

  return rows.map((r) => ({
    tenant_id: r.tenant_id,
    secret_path: r.secret_path,
    totp_enrolled: r.totp_enrolled,
    last_rotated_at: r.last_rotated_at,
    last_used_at: r.last_used_at,
    rotation_scheduled_at: r.rotation_scheduled_at,
    created_at: r.created_at,
    tenant_name: nameById.get(r.tenant_id) ?? null,
    days_since_rotation: r.days_since_rotation
      ? Math.round(Number(r.days_since_rotation))
      : null,
    days_since_use: r.days_since_use
      ? Math.round(Number(r.days_since_use))
      : null,
  }));
}
