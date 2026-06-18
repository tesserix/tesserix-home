// lib/db/homechef.ts — cross-namespace connection pool for the HomeChef
// Postgres, connecting as homechef_platform_admin (read-mostly platform
// oversight: KPI roll-ups for the admin dashboard).
//
// Unlike mark8ly (two logical databases), HomeChef is a single database
// (`homechef_db`), so we expose one pool. Credentials come from the
// `homechef-platform-admin` ExternalSecret, injected as HOMECHEF_DB_* env.
// See tesserix-k8s/docs/cross-db-admin.md.

import { Pool } from "pg";
import type { QueryResult, QueryResultRow } from "pg";

import { logger } from "@/lib/logger";

const HOST = process.env.HOMECHEF_DB_HOST;
const PORT = process.env.HOMECHEF_DB_PORT ? Number(process.env.HOMECHEF_DB_PORT) : 5432;
const USER = process.env.HOMECHEF_DB_USER;
const PASSWORD = process.env.HOMECHEF_DB_PASSWORD;
const DB_NAME = process.env.HOMECHEF_DB_NAME ?? "homechef_db";

let pool: Pool | null = null;

/** True when the HomeChef DB credentials are present (i.e. KPIs can be read). */
export function homechefDbConfigured(): boolean {
  return Boolean(HOST && USER && PASSWORD);
}

export function getHomechefPool(): Pool {
  if (pool) return pool;

  if (!HOST || !USER || !PASSWORD) {
    throw new Error("homechef DB env not set: HOMECHEF_DB_HOST/USER/PASSWORD required");
  }

  pool = new Pool({
    host: HOST,
    port: PORT,
    database: DB_NAME,
    user: USER,
    password: PASSWORD,
    ssl: { rejectUnauthorized: false },
    // Read-mostly cross-DB KPI queries — keep the pool small.
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
