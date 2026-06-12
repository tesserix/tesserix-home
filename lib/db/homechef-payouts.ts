// Chef weekly-settlement (payout) admin reads/writes against homechef_db as
// homechef_platform_admin. Statement *calculation* is automated in homechef-api
// (statement_cron); this is the platform-operator oversight + manual
// disbursement-tracking surface (Home Chef 5B / Wave 7E payout admin).
//
// Schema (Home-Chef-App models): weekly_statements (incl. status/paid_at/
// payout_ref, added 2026-06-12), chef_profiles(business_name), audit_logs.

import { homechefQuery, homechefTx } from "@/lib/db/homechef";

export interface StatementRow {
  id: string;
  chef_id: string;
  chef_name: string | null;
  week_start: string;
  week_end: string;
  currency: string;
  orders_count: number;
  gross_revenue: number;
  platform_commission: number;
  cgst: number;
  sgst: number;
  igst: number;
  tds: number;
  net_payout: number;
  status: string;
  paid_at: string | null;
  payout_ref: string | null;
  created_at: string;
}

export interface StatementFilter {
  status?: string;
  chefId?: string;
  week?: string; // YYYY-MM-DD (matches week_start calendar date)
  limit?: number;
  offset?: number;
}

const toNum = (v: string | number | null | undefined): number =>
  v == null ? 0 : Number(v);

// Builds the shared WHERE clause + params for list/count/export.
function buildWhere(filter: StatementFilter): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    params.push(filter.status);
    clauses.push(`s.status = $${params.length}`);
  }
  if (filter.chefId) {
    params.push(filter.chefId);
    clauses.push(`s.chef_id = $${params.length}`);
  }
  if (filter.week) {
    params.push(filter.week);
    clauses.push(`s.week_start >= $${params.length}::date AND s.week_start < ($${params.length}::date + interval '1 day')`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function mapRow(r: Record<string, unknown>): StatementRow {
  return {
    id: String(r.id),
    chef_id: String(r.chef_id),
    chef_name: (r.chef_name as string) ?? null,
    week_start: String(r.week_start),
    week_end: String(r.week_end),
    currency: (r.currency as string) ?? "INR",
    orders_count: toNum(r.orders_count as string),
    gross_revenue: toNum(r.gross_revenue as string),
    platform_commission: toNum(r.platform_commission as string),
    cgst: toNum(r.cgst as string),
    sgst: toNum(r.sgst as string),
    igst: toNum(r.igst as string),
    tds: toNum(r.tds as string),
    net_payout: toNum(r.net_payout as string),
    status: (r.status as string) ?? "pending",
    paid_at: (r.paid_at as string) ?? null,
    payout_ref: (r.payout_ref as string) ?? null,
    created_at: String(r.created_at),
  };
}

const SELECT_COLS = `
  s.id, s.chef_id, cp.business_name AS chef_name, s.week_start, s.week_end,
  s.currency, s.orders_count, s.gross_revenue, s.platform_commission,
  s.cgst, s.sgst, s.igst, s.tds, s.net_payout, s.status, s.paid_at,
  s.payout_ref, s.created_at`;

export async function listStatements(filter: StatementFilter): Promise<StatementRow[]> {
  const { where, params } = buildWhere(filter);
  const limit = filter.limit && filter.limit > 0 ? filter.limit : 20;
  const offset = filter.offset && filter.offset > 0 ? filter.offset : 0;
  const sql = `
    SELECT ${SELECT_COLS}
      FROM weekly_statements s
      LEFT JOIN chef_profiles cp ON cp.id = s.chef_id
      ${where}
     ORDER BY s.week_start DESC, s.created_at DESC
     LIMIT ${limit} OFFSET ${offset}`;
  const res = await homechefQuery<Record<string, unknown>>(sql, params);
  return res.rows.map(mapRow);
}

export async function countStatements(filter: StatementFilter): Promise<number> {
  const { where, params } = buildWhere(filter);
  const res = await homechefQuery<{ count: string }>(
    `SELECT count(*)::bigint AS count FROM weekly_statements s ${where}`,
    params,
  );
  return toNum(res.rows[0]?.count);
}

// Full result set for CSV export (no pagination), same filters.
export async function listStatementsForExport(filter: StatementFilter): Promise<StatementRow[]> {
  const { where, params } = buildWhere(filter);
  const sql = `
    SELECT ${SELECT_COLS}
      FROM weekly_statements s
      LEFT JOIN chef_profiles cp ON cp.id = s.chef_id
      ${where}
     ORDER BY s.week_start DESC, s.created_at DESC`;
  const res = await homechefQuery<Record<string, unknown>>(sql, params);
  return res.rows.map(mapRow);
}

export interface MarkPaidResult {
  row: StatementRow | null;
  alreadyPaid: boolean;
}

// Records a manual disbursement: status→paid, paid_at, payout_ref. Runs in a
// transaction that also writes an audit_logs row (actor = platform admin) so
// homechef's audit trail stays honest for writes that bypass its handlers — per
// tesserix-k8s/docs/cross-db-admin.md. Idempotent: a no-op if already paid.
export async function markStatementPaid(id: string, payoutRef: string): Promise<MarkPaidResult> {
  const reread = async (
    client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  ): Promise<StatementRow | null> => {
    const cur = await client.query(
      `SELECT ${SELECT_COLS} FROM weekly_statements s
         LEFT JOIN chef_profiles cp ON cp.id = s.chef_id WHERE s.id = $1`,
      [id],
    );
    return cur.rows[0] ? mapRow(cur.rows[0]) : null;
  };

  return homechefTx(async (client) => {
    const upd = await client.query(
      `UPDATE weekly_statements
          SET status = 'paid', paid_at = now(), payout_ref = $2
        WHERE id = $1 AND status <> 'paid'`,
      [id, payoutRef],
    );

    if (upd.rowCount === 0) {
      // Not found or already paid — re-read to disambiguate (no audit write).
      const row = await reread(client);
      return { row, alreadyPaid: row?.status === "paid" };
    }

    await client.query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, new_value, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [
        "admin.payout.mark_paid",
        "weekly_statement",
        id,
        JSON.stringify({ payoutRef, actor: "homechef_platform_admin", source: "tesserix-home" }),
      ],
    );

    return { row: await reread(client), alreadyPaid: false };
  });
}
