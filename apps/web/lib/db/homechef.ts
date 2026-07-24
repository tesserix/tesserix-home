// lib/db/homechef.ts — cross-namespace connection pool for the Home Chef
// Postgres cluster, connecting as homechef_platform_admin.
//
// homechef_platform_admin has CRUD scope on every table in homechef_db but
// is NOT a superuser and CANNOT do DDL (CREATE/DROP/ALTER TABLE). See
// tesserix-k8s/docs/cross-db-admin.md + Home-Chef-App/docs/ops/CUTOVER-RUNBOOK.md.
//
// Home Chef is a single-database product (homechef_db), so — unlike mark8ly's
// two pools — there's one pool here.

import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { logger } from "@/lib/logger";

const HOST = process.env.HOMECHEF_DB_HOST;
const PORT = process.env.HOMECHEF_DB_PORT
  ? Number(process.env.HOMECHEF_DB_PORT)
  : 5432;
const USER = process.env.HOMECHEF_DB_USER;
const PASSWORD = process.env.HOMECHEF_DB_PASSWORD;
const DB_NAME = process.env.HOMECHEF_DB_NAME ?? "homechef_db";

let pool: Pool | null = null;

export function getHomechefPool(): Pool {
  if (pool) return pool;

  if (!HOST || !USER || !PASSWORD) {
    throw new Error(
      "homechef DB env not set: HOMECHEF_DB_HOST/USER/PASSWORD required",
    );
  }

  pool = new Pool({
    host: HOST,
    port: PORT,
    database: DB_NAME,
    user: USER,
    password: PASSWORD,
    ssl: { rejectUnauthorized: false },
    // Read-mostly cross-DB queries; no bursty write traffic expected.
    max: 3,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on("error", (err) => {
    logger.error("[homechef-db] pool error", err);
  });

  return pool;
}

// Retry once on transient connection drops — same rationale as mark8ly.ts:
// node-postgres pools occasionally hand out a server-closed socket.
function isTransientConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || "";
  return (
    msg.includes("Connection terminated") ||
    msg.includes("Client has encountered a connection error") ||
    msg.includes("ECONNRESET")
  );
}

export async function homechefQuery<R extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<R>> {
  const p = getHomechefPool();
  try {
    return await p.query<R>(sql, params as unknown[]);
  } catch (err) {
    if (isTransientConnectionError(err)) {
      logger.warn("[homechef-db] transient connection drop, retrying once");
      return p.query<R>(sql, params as unknown[]);
    }
    throw err;
  }
}

// Transaction helper for destructive cross-DB writes (mark-paid, etc.). Per the
// cross-db-admin runbook these must also insert an audit row in the same txn.
export async function homechefTx<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const p = getHomechefPool();
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
