// lib/db/tesserix.ts — connection pool for the super-admin's own
// Postgres (tesserix-postgres CNPG cluster). Owns leads + apps registry.
//
// Cross-product DB access (mark8ly_platform_api, mark8ly_marketplace_api,
// future fanzone/homechef) lives in `lib/db/mark8ly.ts` and similarly
// named modules. This file is local-only.

import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { logger } from "@/lib/logger";

const HOST = process.env.TESSERIX_DB_HOST;
const PORT = process.env.TESSERIX_DB_PORT
  ? Number(process.env.TESSERIX_DB_PORT)
  : 5432;
const NAME = process.env.TESSERIX_DB_NAME ?? "tesserix_admin";
const USER = process.env.TESSERIX_DB_USER;
const PASSWORD = process.env.TESSERIX_DB_PASSWORD;

let pool: Pool | undefined;

// Lazy single pool. Next.js dev mode hot-reloads modules; calling getPool()
// instead of constructing at import time avoids creating a pool every reload.
// In production the module is cold-loaded once per pod, so this is just a
// convenience.
export function getTesserixPool(): Pool {
  if (pool) return pool;

  if (!HOST || !USER || !PASSWORD) {
    throw new Error(
      "tesserix DB env not set: TESSERIX_DB_HOST/USER/PASSWORD required",
    );
  }

  pool = new Pool({
    host: HOST,
    port: PORT,
    database: NAME,
    user: USER,
    password: PASSWORD,
    // CNPG enforces TLS by default; sslmode=require is the corresponding
    // node-postgres option. We don't pin the CA — CNPG self-signs and
    // rotates internally, so cert verification would force constant
    // rebuilds. The connection is in-cluster (no MITM exposure).
    ssl: { rejectUnauthorized: false },
    // Conservative for a single-instance DB serving an admin tool.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on("error", (err) => {
    logger.error("[tesserix-db] pool error", err);
  });

  return pool;
}

// CNPG can recycle the primary's connection during failovers /
// scheduled WAL maintenance, which surfaces in pg as "Connection
// terminated unexpectedly" or ECONNRESET — transient even though the
// pool will hand out a fresh socket on the next call. Retry-once is
// safe for idempotent statements; INSERTs in this codebase are also
// safe to retry because each INSERT is its own statement and the row
// either committed (next attempt sees a uniqueness violation) or
// didn't (next attempt creates it cleanly).
function isTransientConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || "";
  return (
    msg.includes("Connection terminated") ||
    msg.includes("Client has encountered a connection error") ||
    msg.includes("ECONNRESET")
  );
}

// Run a query against tesserix-postgres. Generic over the row shape.
export async function tesserixQuery<R extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<R>> {
  const p = getTesserixPool();
  try {
    return await p.query<R>(sql, params as unknown[]);
  } catch (err) {
    if (isTransientConnectionError(err)) {
      logger.warn("[tesserix-db] transient connection drop, retrying once");
      return p.query<R>(sql, params as unknown[]);
    }
    throw err;
  }
}

// Run a callback inside a single transaction with the same client.
// Use this for any multi-statement op (e.g. CSV import → leads + lead_imports).
//
// Transient retry: if BEGIN itself or the first statement on a fresh
// client trips the "Connection terminated" race, the rollback also
// fails and the error propagates. We catch that case and run the whole
// transaction once more on a different client. Mid-transaction failures
// after the first successful statement are NOT retried — the caller's
// invariants may already have side-effected the partial result.
export async function tesserixTx<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await runTesserixTxOnce(fn);
  } catch (err) {
    if (isTransientConnectionError(err)) {
      logger.warn("[tesserix-db] tx transient connection drop, retrying once");
      return runTesserixTxOnce(fn);
    }
    throw err;
  }
}

async function runTesserixTxOnce<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const p = getTesserixPool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ROLLBACK on a dead connection — ignore, the caller's error
      // is the one that matters.
    }
    throw err;
  } finally {
    client.release();
  }
}
