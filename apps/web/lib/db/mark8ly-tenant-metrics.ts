// Per-tenant metrics queried directly from mark8ly Postgres via the
// existing mark8ly_platform_admin role. Read-only.
//
// Storage attribution is an estimate, not a measurement — pg has no
// per-tenant disk accounting on shared tables. We approximate with
//   tenant_storage = table_total_bytes × (tenant_rows / total_rows)
// which is cheap (uses pg_total_relation_size + two count queries) and
// good enough for an admin overview. Documented as estimated in the UI.

import { mark8lyQuery } from "./mark8ly";
import type { RowCountTable } from "@/lib/products/types";

export interface TenantRowCounts {
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
}

export interface TenantStorageEstimate {
  readonly bytes: number;
  readonly perTable: Readonly<Record<string, number>>;
}

function isSafeTableName(name: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(name);
}

export async function getTenantRowCounts(
  tenantId: string,
  tables: ReadonlyArray<RowCountTable>,
): Promise<TenantRowCounts> {
  const counts: Record<string, number> = {};
  let total = 0;

  for (const t of tables) {
    if (!isSafeTableName(t.tableName)) {
      throw new Error(`unsafe table name: ${t.tableName}`);
    }
    const sql = `SELECT count(*)::bigint AS n FROM ${t.tableName} WHERE tenant_id = $1`;
    const res = await mark8lyQuery<{ n: string }>(t.database, sql, [tenantId]);
    const n = Number(res.rows[0]?.n ?? 0);
    counts[t.label] = n;
    total += n;
  }

  return { counts, total };
}

export async function getTenantStorageEstimate(
  tenantId: string,
  tables: ReadonlyArray<RowCountTable>,
): Promise<TenantStorageEstimate> {
  const perTable: Record<string, number> = {};
  let totalBytes = 0;

  for (const t of tables) {
    if (!isSafeTableName(t.tableName)) {
      throw new Error(`unsafe table name: ${t.tableName}`);
    }
    const sql = `
      SELECT
        pg_total_relation_size(quote_ident($2))::bigint AS table_bytes,
        (SELECT count(*) FROM ${t.tableName})::bigint AS total_rows,
        (SELECT count(*) FROM ${t.tableName} WHERE tenant_id = $1)::bigint AS tenant_rows
    `;
    const res = await mark8lyQuery<{
      table_bytes: string;
      total_rows: string;
      tenant_rows: string;
    }>(t.database, sql, [tenantId, t.tableName]);

    const tableBytes = Number(res.rows[0]?.table_bytes ?? 0);
    const totalRows = Number(res.rows[0]?.total_rows ?? 0);
    const tenantRows = Number(res.rows[0]?.tenant_rows ?? 0);

    const tenantBytes = totalRows > 0 ? Math.round(tableBytes * (tenantRows / totalRows)) : 0;
    perTable[t.label] = tenantBytes;
    totalBytes += tenantBytes;
  }

  return { bytes: totalBytes, perTable };
}
