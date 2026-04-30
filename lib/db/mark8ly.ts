// lib/db/mark8ly.ts — cross-namespace connection pools for the
// mark8ly Postgres cluster, connecting as mark8ly_platform_admin.
//
// mark8ly_platform_admin has CRUD scope on every table in both
// mark8ly_platform_api and mark8ly_marketplace_api but is NOT a
// superuser and CANNOT do DDL (CREATE/DROP/ALTER TABLE). See
// tesserix-k8s/docs/cross-db-admin.md.
//
// We expose ONE pool per logical database (platform_api, marketplace_api)
// because pg pools are per-database. Both pools share the same
// host/credentials.

import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { logger } from "@/lib/logger";

export type Mark8lyDatabase = "platform_api" | "marketplace_api";

const HOST = process.env.MARK8LY_DB_HOST;
const PORT = process.env.MARK8LY_DB_PORT
  ? Number(process.env.MARK8LY_DB_PORT)
  : 5432;
const USER = process.env.MARK8LY_DB_USER;
const PASSWORD = process.env.MARK8LY_DB_PASSWORD;

const DB_NAMES: Record<Mark8lyDatabase, string> = {
  platform_api: "mark8ly_platform_api",
  marketplace_api: "mark8ly_marketplace_api",
};

const pools = new Map<Mark8lyDatabase, Pool>();

export function getMark8lyPool(db: Mark8lyDatabase): Pool {
  const existing = pools.get(db);
  if (existing) return existing;

  if (!HOST || !USER || !PASSWORD) {
    throw new Error(
      "mark8ly DB env not set: MARK8LY_DB_HOST/USER/PASSWORD required",
    );
  }

  const pool = new Pool({
    host: HOST,
    port: PORT,
    database: DB_NAMES[db],
    user: USER,
    password: PASSWORD,
    ssl: { rejectUnauthorized: false },
    // Smaller than tesserix's pool — these are read-mostly cross-DB
    // queries; we don't expect bursty write traffic against mark8ly.
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on("error", (err) => {
    logger.error(`[mark8ly-db:${db}] pool error`, err);
  });

  pools.set(db, pool);
  return pool;
}

export async function mark8lyQuery<R extends QueryResultRow = QueryResultRow>(
  db: Mark8lyDatabase,
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<R>> {
  const p = getMark8lyPool(db);
  return p.query<R>(sql, params as unknown[]);
}

// Run a callback inside a single transaction. ALWAYS use this for
// cross-DB destructive operations (tenant cleanup, billing override) so
// that the transaction can roll back cleanly on failure. Per the runbook
// the transaction must also insert an audit_events row in the same
// transaction so the product's audit log stays honest.
export async function mark8lyTx<T>(
  db: Mark8lyDatabase,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const p = getMark8lyPool(db);
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
