import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { closeTesserixPool, isDatabaseConfigured, tesserixQuery } from "@/lib/db/tesserix";

/**
 * The console's startup preflight: refuse to serve against a database whose
 * `schema_migrations` ledger is behind the migrations this image ships.
 *
 * # Why this exists
 *
 * Migrations here are applied BY HAND and deploys are NOT. Kargo ships the
 * console on merge; `apps/web/scripts/db-migrate.mjs` does not ride along.
 * Nothing in CI, ArgoCD or Kargo checks that the schema a new image needs is
 * actually present, so the only thing between a merge and a broken surface was
 * whether somebody read the PR description. That failed twice inside one hour
 * on 2026-09-07:
 *
 *  1. An image expecting 0051 was built and shipped while production sat at
 *     0050. Caught by hand, with minutes to spare, because someone thought to
 *     look.
 *  2. The recovery then applied 0051 by piping the file through `psql`. The
 *     DDL landed; `schema_migrations` was never written. Schema and ledger
 *     disagreed and nothing said so.
 *
 * Both are the same missing assertion, and the second is why this compares the
 * LEDGER and not the columns — see {@link readAppliedVersions}.
 *
 * # Why a failed start, and not a health route
 *
 * The console's readiness probe is `tcpSocket`: it passes the moment the port
 * opens, so it asserts nothing about correctness. Rather than add an HTTP
 * surface and change the probe, this runs BEFORE the server and exits
 * non-zero, so the port never opens at all. With `maxSurge: 0,
 * maxUnavailable: 1` across 2 replicas that halts the rollout with an old
 * replica still serving — which is the correct outcome, because the OLD image
 * is the one the database's schema matches.
 *
 * It composes with the existing probe instead of replacing it, and it needs no
 * new route, no new credential and no chart change beyond the command.
 *
 * # What it deliberately does NOT do
 *
 * It does not apply migrations. Auto-applying is mark8ly's `migrate`
 * initContainer pattern, is probably the right end state, and needs a locking
 * story for 2 replicas racing the same DDL. That is a separate decision and is
 * not smuggled in here: this reports and exits.
 *
 * # How it is packaged
 *
 * Exactly like `parity-check.ts`, and for the same reason: Next's standalone
 * output contains only what the server needs, so arbitrary TypeScript under
 * `apps/console/` is not in the runtime image. `pnpm --filter console
 * build:preflight` bundles this with esbuild, and `Dockerfile.console` copies
 * the bundle INSIDE the standalone tree so that `pg` — left external because
 * it IS in the standalone `node_modules` — resolves by walking up to the
 * image's hoisted `/app/node_modules`. Getting that external/inline choice
 * backwards produces an image that builds green and dies in the cluster; the
 * Dockerfile says so at the copy, and it is the same trap here.
 */

/** The ledger holds every version this image ships. Start the server. */
export const EXIT_OK = 0;

/**
 * The database is MISSING at least one migration this image requires.
 *
 * The expected failure, and the one the message is written for: a human has to
 * run the migration runner and then let the pod restart.
 */
export const EXIT_SCHEMA_BEHIND = 1;

/**
 * The check could not be performed at all.
 *
 * Separate from {@link EXIT_SCHEMA_BEHIND} because the remedy is different —
 * nobody should go running migrations because the version file failed to
 * parse — but emphatically still NON-ZERO.
 *
 * A DATABASE THAT CANNOT BE REACHED IS NOT A PASS. Neither is a missing or
 * unreadable version file. Every one of those is a path where a naive
 * implementation "fails open" and starts the server anyway, which converts a
 * loud failure into a green one — the exact defect this check exists to
 * prevent. If we cannot prove the database is caught up, we have not proved
 * anything, and the only honest answer is to refuse.
 */
export const EXIT_PREFLIGHT_FAILED = 2;

/**
 * Where the baked version file sits at RUNTIME.
 *
 * Resolved from this module's own URL rather than from `process.cwd()`: the
 * container's working directory is `/app` (the standalone root) while the
 * bundle and its JSON both live in `/app/apps/console/scripts/`, and a
 * cwd-relative path would silently miss — which, on a check like this one,
 * means it would need to be treated as a failure at every startup rather than
 * found. `import.meta.url` survives the esbuild bundling unchanged and points
 * at wherever the `.mjs` actually landed.
 *
 * The TypeScript source resolves to the same directory, where no JSON exists —
 * correct, and deliberately so: running this from source without a build is
 * not a configuration anybody should get a pass from. Tests pass an explicit
 * path.
 */
export const DEFAULT_VERSION_FILE = new URL("./schema-version.json", import.meta.url);

/** What the log lines are prefixed with, so a startup failure is greppable in
 *  a stream shared with Next's own output. */
const TAG = "[schema-preflight]";

/** `51` -> `0051`, matching the migration FILENAMES rather than the integer in
 *  the ledger. Whoever reads this message next has to go find a file. */
function formatVersion(version: number): string {
  return String(version).padStart(4, "0");
}

/**
 * The versions this image ships, read from the file baked in at build time.
 *
 * THROWS on anything it cannot fully trust — absent file, unparseable JSON,
 * wrong shape, an empty list, a non-integer. Every one of those is a broken
 * build, and every one of them is a way for a lenient reader to return "no
 * versions expected" and make the comparison below trivially succeed against
 * an empty database.
 *
 * See `emit-schema-version.mjs` for why the file carries the whole list rather
 * than a maximum: a maximum cannot describe a hole, and a hole is exactly what
 * the 2026-09-07 `psql` recovery left behind.
 */
export async function readExpectedVersions(source: URL | string): Promise<number[]> {
  const raw = await readFile(source, "utf8");
  const parsed: unknown = JSON.parse(raw);

  const versions = (parsed as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(versions)) {
    throw new Error(`version file has no "versions" array`);
  }
  if (versions.length === 0) {
    throw new Error(`version file lists no migrations`);
  }
  for (const value of versions) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`version file contains a non-positive-integer version: ${String(value)}`);
    }
  }

  return [...(versions as number[])].sort((a, b) => a - b);
}

/**
 * The versions the DATABASE says are applied.
 *
 * THE LEDGER IS THE SOURCE OF TRUTH, NOT THE COLUMNS. A check that inspected
 * `information_schema` for the columns this image expects would have called
 * the 2026-09-07 `psql` recovery HEALTHY: the DDL was there, the ledger was
 * not, and the system was in a state nobody had declared. Comparing versions
 * is what makes "applied" mean "applied by the runner, inside a transaction,
 * and recorded".
 *
 * A missing `schema_migrations` table throws (`42P01`), which is right: a
 * database with no ledger at all has certainly not been migrated by the
 * runner.
 */
export async function readAppliedVersions(): Promise<Set<number>> {
  const rows = await tesserixQuery<{ version: number }>(
    `SELECT version FROM schema_migrations`,
  );
  // `pg` decodes `integer` as a JS number, but pglite and any future column
  // widening can hand back a string. Coerced rather than trusted, because a
  // string "51" would silently never match the number 51 and every startup
  // would report every migration missing.
  return new Set(rows.map((row) => Number(row.version)));
}

/**
 * Describe a database failure without its message.
 *
 * The same trade-off `parity-check.ts` makes, for the same reason: a `pg`
 * error message names the role (`password authentication failed for user
 * tesserix_admin`) or echoes the host, and this line goes to the cluster's log
 * sink. The error's class plus its `code` — SQLSTATE, or `ECONNREFUSED` for a
 * dead host — is the diagnostic half with none of the credential half.
 */
function describeDatabaseFailure(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : typeof cause;
  const raw = (cause as { code?: unknown } | null)?.code;
  const code = typeof raw === "string" ? raw.slice(0, 32) : null;
  return code === null ? name : `${name} (${code})`;
}

/** Everything a caller needs to inject to test this without a container. */
export interface PreflightOptions {
  /** Where to read the baked version list from. Defaults to the runtime path. */
  versionFile?: URL | string;
  /** How to read the ledger. Defaults to querying tesserix-postgres. */
  readApplied?: () => Promise<Set<number>>;
  /** Whether the DB connection is wired up at all. */
  databaseConfigured?: () => boolean;
}

/**
 * Run the check and report an exit code.
 *
 * Returns the code rather than calling `process.exit`, so every branch —
 * including the ones that matter, which are the FAILURES — is reachable from a
 * test. The check is trivial; everything that makes it worth building is in
 * what happens when it fires.
 *
 * AHEAD PASSES, BEHIND FAILS. A database at 0052 running an image that expects
 * up to 0051 MUST start: that is the normal rollout window, and it is the
 * whole reason migrations are written to be compatible with the image they
 * precede. Only "the database is missing versions this image needs" is an
 * error, so the comparison is a subset test and never an equality or a
 * maximum-versus-maximum.
 */
export async function runSchemaPreflight(options: PreflightOptions = {}): Promise<number> {
  const versionFile = options.versionFile ?? DEFAULT_VERSION_FILE;
  const readApplied = options.readApplied ?? readAppliedVersions;
  const databaseConfigured = options.databaseConfigured ?? isDatabaseConfigured;

  let expected: number[];
  try {
    expected = await readExpectedVersions(versionFile);
  } catch (cause) {
    // Our own file, our own error text — safe to print in full, and the only
    // thing that makes a broken build diagnosable from a crash loop.
    console.error(
      `${TAG} REFUSING TO START: could not read the baked schema version from ` +
        `${String(versionFile)}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    console.error(
      `${TAG} This is a BUILD problem, not a database one — the image is ` +
        `missing the artefact 'pnpm --filter console build:schema-version' ` +
        `produces. Do not run migrations for this.`,
    );
    return EXIT_PREFLIGHT_FAILED;
  }

  const highestExpected = expected[expected.length - 1];

  if (!databaseConfigured()) {
    console.error(
      `${TAG} REFUSING TO START: TESSERIX_DB_HOST/USER/PASSWORD are not set, ` +
        `so the schema_migrations ledger cannot be read.`,
    );
    console.error(
      `${TAG} An unverifiable database is NOT a pass. This image requires ` +
        `migrations up to ${formatVersion(highestExpected)}.`,
    );
    return EXIT_PREFLIGHT_FAILED;
  }

  let applied: Set<number>;
  try {
    applied = await readApplied();
  } catch (cause) {
    console.error(
      `${TAG} REFUSING TO START: could not read schema_migrations — ` +
        `${describeDatabaseFailure(cause)}.`,
    );
    console.error(
      `${TAG} An unreachable database is NOT a pass: starting anyway would ` +
        `turn this into a silent success, which is the failure this check ` +
        `exists to prevent. Likely the connection (ECONNREFUSED, 28P01); or ` +
        `TLS, which is ON by default here — a plain Postgres REFUSES the ` +
        `negotiation rather than falling back, so the failure reads like bad ` +
        `credentials (set TESSERIX_DB_SSLMODE=disable against one, exactly as ` +
        `db-migrate.mjs documents); or a database that has never been ` +
        `migrated by the runner at all (42P01 — no schema_migrations table).`,
    );
    return EXIT_PREFLIGHT_FAILED;
  }

  const missing = expected.filter((version) => !applied.has(version));

  if (missing.length === 0) {
    const highestApplied = applied.size === 0 ? null : Math.max(...applied);
    console.log(
      `${TAG} ok — all ${expected.length} migration(s) up to ` +
        `${formatVersion(highestExpected)} are recorded in schema_migrations` +
        // Named explicitly, because "ahead" is a PASS and a reader seeing a
        // higher number in the log should not have to wonder whether it was.
        (highestApplied !== null && highestApplied > highestExpected
          ? ` (the database is ahead, at ${formatVersion(highestApplied)} — expected during a rollout).`
          : `.`),
    );
    return EXIT_OK;
  }

  const list = missing.map(formatVersion).join(", ");
  console.error(
    `${TAG} REFUSING TO START: the database is missing ${missing.length} ` +
      `migration(s) this image requires: ${list}.`,
  );
  console.error(
    `${TAG} This image ships migrations up to ${formatVersion(highestExpected)}. ` +
      `The pod will keep failing until the ledger catches up — which is ` +
      `deliberate: the previous image still serves while it does.`,
  );
  console.error(
    `${TAG} FIX: apply them with the runner, from a checkout at this image's ` +
      `commit, with TESSERIX_DB_HOST/PORT/NAME/USER/PASSWORD set:`,
  );
  console.error(`${TAG}     node apps/web/scripts/db-migrate.mjs`);
  console.error(
    `${TAG} Do NOT pipe the .sql files through psql. That applies the DDL ` +
      `WITHOUT writing schema_migrations, so the schema is right, the ledger ` +
      `is wrong, and this check keeps failing for a database that looks ` +
      `correct — the exact state that followed the 2026-09-07 recovery.`,
  );
  return EXIT_SCHEMA_BEHIND;
}

/**
 * Only when run as a program, never when imported by a test.
 *
 * Compared against `argv[1]` rather than assumed, exactly as `parity-check.ts`
 * does, so the bundled `.mjs` and the TypeScript source behave identically and
 * importing this module under Vitest does not start a check against whatever
 * database the test machine happens to have configured.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void runSchemaPreflight()
    .then(async (code) => {
      // The pool holds the event loop open, and this process must END — the
      // container's `CMD` runs the server only after this exits, so a preflight
      // that hangs is a console that never starts, with no error to show for it.
      await closeTesserixPool().catch(() => {});
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // Belt to the braces above: every expected failure is already a returned
      // code, so reaching here means an unanticipated throw — which must still
      // be a refusal and not an unhandled rejection that Node may or may not
      // treat as fatal depending on its flags.
      console.error(
        `${TAG} REFUSING TO START: unexpected error — ${describeDatabaseFailure(err)}.`,
      );
      process.exitCode = EXIT_PREFLIGHT_FAILED;
    });
}
