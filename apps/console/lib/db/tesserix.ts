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

/**
 * How to negotiate TLS with tesserix-postgres.
 *
 * CNPG self-signs and rotates internally, so the connection is encrypted but
 * NOT verified — pinning the CA would force a rebuild on every rotation, and
 * this is an in-cluster connection with no MITM exposure.
 *
 * `TESSERIX_DB_SSLMODE=disable` turns TLS off entirely, for local development
 * only: a plain Postgres speaks no TLS and REFUSES the negotiation, so without
 * this the console cannot reach the dev database at all and every CRM surface
 * renders "Could not load organisations" — the exact failure #271 exists to
 * end.
 *
 * OPT-OUT ONLY, AND NEVER THE DEFAULT. Any other value — unset, mistyped,
 * empty, `require` — leaves TLS on, so a misconfiguration cannot silently
 * downgrade a deployed connection to plaintext. The Helm charts set `require`,
 * which is treated exactly as unset.
 *
 * Exported so that property is a test rather than a comment.
 */
export function sslOption(): false | { rejectUnauthorized: boolean } {
  return env("TESSERIX_DB_SSLMODE") === "disable"
    ? false
    : { rejectUnauthorized: false };
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
    ssl: sslOption(),
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

/** The query shape handed to a `tesserixTx` callback — same signature as
 *  `tesserixQuery`, but every call runs on the transaction's own client. */
export type TxQuery = <R extends QueryResultRow>(
  sql: string,
  params?: readonly unknown[],
) => Promise<R[]>;

/** The minimal shape `runTesserixTx` needs from a client: something it can
 *  send `BEGIN`/`COMMIT`/`ROLLBACK` and every statement in between to. A
 *  `pg.PoolClient` satisfies this structurally, which is all `tesserixTx`
 *  needs — and so does anything else with the same `query` signature, which
 *  is what makes this testable (see crm-repo.write.integration.test.ts). */
export interface TxClient {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/**
 * The transactional core: `BEGIN`, run the callback, `COMMIT` — or
 * `ROLLBACK` on failure — against whatever client it's given.
 *
 * Pulled out of `tesserixTx` and exported specifically so it can be tested
 * against a real database. `tesserixTx` below is untestable without a real
 * network Postgres (it calls `pool.connect()`), but the thing the "one
 * transaction" guarantee actually rests on is this function, not how the
 * client was acquired — and this function's only requirement of its client
 * is the structural `TxClient` shape above, which an embedded Postgres
 * (pglite) satisfies too. A mock that reimplements BEGIN/COMMIT/ROLLBACK by
 * hand, however faithfully, is still not a test of this code; a test that
 * calls this function IS.
 */
export async function runTesserixTx<T>(
  client: TxClient,
  fn: (query: TxQuery) => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    const scopedQuery: TxQuery = async <R extends QueryResultRow>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      const result = await client.query<R>(sql, params as unknown[]);
      return result.rows;
    };
    const out = await fn(scopedQuery);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ROLLBACK on a dead connection — ignore, the caller's error is the
      // one that matters.
    }
    throw err;
  }
}

/**
 * Run a callback inside a single transaction, on a single client.
 *
 * `tesserixQuery` pulls from a 2-connection pool — a BEGIN and the UPDATE
 * that follows it can land on two different connections, which is not a
 * transaction at all, just two unrelated statements that happen to run near
 * each other. Any multi-statement write that must be atomic (crm-repo's
 * `advanceStage`, which updates the opportunity and inserts its
 * `stage_change` activity together) needs one client held for BEGIN,
 * every statement, and COMMIT/ROLLBACK.
 *
 * That client comes out of the pool for the whole transaction, not just one
 * statement — with `max: 2`, two concurrent stage saves already hold both
 * connections between them, and a third caller (a save, or an unrelated
 * read anywhere else in the console) queues behind `connectionTimeoutMillis`
 * (5s) rather than failing outright. Acceptable today at this write volume;
 * raise `max` only against measurement, not in anticipation of this.
 */
export async function tesserixTx<T>(fn: (query: TxQuery) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await runTesserixTx(client, fn);
  } finally {
    client.release();
  }
}
