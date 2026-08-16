import { Pool } from "pg";
import type { QueryResultRow } from "pg";

/**
 * The console's connection to tesserix-postgres.
 *
 * Mirrors apps/web/lib/db/tesserix.ts, which reads the same database with the
 * same credentials (the tesserix-postgres-tesserix-admin Secret, already
 * present in the namespace). Duplicated rather than shared because the two
 * apps are separately deployed processes with separate lifetimes; a shared
 * package would couple their pool tuning and their restarts.
 *
 * This is the console reading its OWN store — tesserix-postgres is
 * platform-owned, not a product database, so it does not couple a product to
 * the platform's availability.
 */

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Is the connection wired up at all?
 *
 * Read at call time, not at import: this ships BEFORE the chart change that
 * supplies the variables, and for that window every consumer must be able to
 * ask and get a truthful "no" rather than throwing on import and taking the
 * whole sidebar down with it.
 */
export function isDatabaseConfigured(): boolean {
  return Boolean(
    env("TESSERIX_DB_HOST") &&
      env("TESSERIX_DB_USER") &&
      env("TESSERIX_DB_PASSWORD"),
  );
}

let pool: Pool | undefined;

function getPool(): Pool {
  if (pool) return pool;
  if (!isDatabaseConfigured()) {
    throw new Error(
      "tesserix DB env not set: TESSERIX_DB_HOST/USER/PASSWORD required",
    );
  }
  pool = new Pool({
    host: env("TESSERIX_DB_HOST"),
    port: Number(env("TESSERIX_DB_PORT") ?? 5432),
    database: env("TESSERIX_DB_NAME") ?? "tesserix_admin",
    user: env("TESSERIX_DB_USER"),
    password: env("TESSERIX_DB_PASSWORD"),
    // CNPG self-signs and rotates internally; pinning the CA would force
    // rebuilds on every rotation. In-cluster connection, no MITM exposure.
    ssl: { rejectUnauthorized: false },
    // The console polls; it does not batch. Two connections is plenty and
    // leaves headroom on a single-instance database shared with apps/web.
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // An unhandled 'error' event on an idle client crashes the process. CNPG
  // recycles connections during failover, so this fires in normal operation.
  pool.on("error", () => {});
  return pool;
}

export async function tesserixQuery<R extends QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  const result = await getPool().query<R>(sql, params as unknown[]);
  return result.rows;
}
