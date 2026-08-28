import { pathToFileURL } from "node:url";

import { runBootstrap } from "@/lib/billing/bootstrap";
import { sanitizeReason } from "@/lib/billing/parity-run";
import { STRIPE_MODES, type StripeMode } from "@/lib/billing/stripe-read";
import { closeTesserixPool, isDatabaseConfigured } from "@/lib/db/tesserix";

/**
 * The catalog bootstrap, as an operator runs it once against an empty Stripe
 * mode.
 *
 * # Why a script, run directly, rather than a route
 *
 * `scripts/parity-check.ts` is the pattern this follows, and its reasoning
 * applies unchanged: whoever runs this — a person rehearsing against
 * `catalog-bootstrap-rehearsal`, or later a one-off job — has a Stripe write
 * credential and a database connection, not an operator session the console
 * issues. There is no route behind this because a bootstrap is not something
 * the console's UI triggers; see Task A/B's plan for why this stays a script.
 *
 * # It is a caller, not an implementation
 *
 * Everything that decides WHAT gets created — reading the catalog, reading
 * what Stripe already has, refusing a populated mode without `--force`,
 * creating Products before Prices — lives in `lib/billing/bootstrap.ts`. This
 * file owns exactly what a CLI entry point needs and a library function does
 * not: argv parsing, exit codes, one JSON log line, and letting the process
 * end. A second copy of the bootstrap DECISION here would be the same
 * duplication `parity-check.ts`'s header warns against, just for writes
 * instead of reads.
 *
 * # How it is packaged
 *
 * Bundled with esbuild via `pnpm --filter console build:bootstrap`, mirroring
 * `build:cron` exactly — including its `--external:pg` / inlined-`stripe`
 * split. `pg` IS in `.next/standalone/node_modules` (Next externalises it by
 * default) so it stays external here too; `stripe` is NOT, so it must be
 * inlined or the bundle dies at runtime with `ERR_MODULE_NOT_FOUND`. See
 * `parity-check.ts`'s own comment for the verification story behind that
 * split — nothing here changes it, so nothing here re-derives it.
 *
 * `tsx` is not installed anywhere in this workspace; the bundled `.mjs` is run
 * with plain `node`, not `tsx scripts/catalog-bootstrap.ts`.
 */

/** Every mode ran and either created what it planned or found nothing left to
 *  create. Both are success — a `skipped: 42` run against an
 *  already-populated mode (with `--force`) is the tool working, not failing. */
export const EXIT_OK = 0;

/** The database wasn't configured, `--mode` was missing or invalid, or
 *  `runBootstrap` itself rejected — most commonly the populated-mode guard,
 *  or a Stripe credential problem surfaced by `stripe-write.ts`. */
export const EXIT_FAILED = 1;

/** How long to wait for a stray handle before forcing the exit — mirrors
 *  `parity-check.ts`'s `EXIT_GRACE_MS`, for the same reason: the Stripe SDK's
 *  keep-alive sockets can outlive the request that opened them. */
const EXIT_GRACE_MS = 2_000;

function log(line: Record<string, unknown>, stream: "out" | "err"): void {
  const rendered = JSON.stringify({ job: "plan-catalog-bootstrap", ...line });
  if (stream === "err") console.error(rendered);
  else console.log(rendered);
}

/**
 * Pull `--mode=test|live` out of argv.
 *
 * Required, not defaulted — a missing `--mode` at a CLI is an operator who
 * has not yet said which account they mean, and defaulting to `test` would
 * make that silent rather than a refusal.
 */
export function parseMode(argv: readonly string[]): StripeMode {
  const arg = argv.find((a) => a.startsWith("--mode="));
  if (!arg) {
    throw new Error(`catalog-bootstrap: --mode=<${STRIPE_MODES.join("|")}> is required`);
  }
  const value = arg.slice("--mode=".length);
  if (!(STRIPE_MODES as readonly string[]).includes(value)) {
    throw new Error(`catalog-bootstrap: --mode must be one of ${STRIPE_MODES.join(", ")}, got "${value}"`);
  }
  return value as StripeMode;
}

/** `--force`, present or not — see `BootstrapOptions.force` in
 *  `lib/billing/bootstrap.ts` for what it overrides. */
export function parseForce(argv: readonly string[]): boolean {
  return argv.includes("--force");
}

/**
 * `--dry-run`, present or not — see `BootstrapOptions.dryRun` in
 * `lib/billing/bootstrap.ts` for what it does. Composes with `--mode` and
 * `--force`; it is not a third `--mode` value, so it gets its own parse
 * function rather than a case inside `parseMode`.
 */
export function parseDryRun(argv: readonly string[]): boolean {
  return argv.includes("--dry-run");
}

/**
 * Parse argv, run the bootstrap, log exactly one line, return an exit code.
 *
 * Returns the code rather than calling `process.exit` so the whole thing is
 * testable — mirrors `runParityCheckJob`'s shape for the same reason.
 */
export async function runCatalogBootstrapJob(argv: readonly string[]): Promise<number> {
  try {
    if (!isDatabaseConfigured()) {
      // Refused before any argv parsing or Stripe call: the catalog read is
      // the first thing `runBootstrap` needs, and a job that cannot reach the
      // database cannot do anything useful with a Stripe write credential
      // either.
      log(
        { outcome: "failed", reason: "TESSERIX_DB_HOST/USER/PASSWORD are not set; nothing could be read" },
        "err",
      );
      return EXIT_FAILED;
    }

    let mode: StripeMode;
    try {
      mode = parseMode(argv);
    } catch (cause) {
      log({ outcome: "failed", reason: cause instanceof Error ? cause.message : String(cause) }, "err");
      return EXIT_FAILED;
    }

    const force = parseForce(argv);
    const dryRun = parseDryRun(argv);

    try {
      const result = await runBootstrap(mode, { force, dryRun });
      // `force` and `dryRun` are logged alongside the result, not just
      // consumed: whether the populated-mode guard was bypassed, and whether
      // this run wrote anything at all, are the two most forensically useful
      // bits this line carries, and this line is the only artefact the run
      // leaves. `result`'s own field names (`productsCreated`,
      // `pricesCreated`, `skipped`) are unchanged between a dry run and a
      // real one — a dry run's numbers mean "would create", a real run's
      // mean "did create" — so the two log lines are comparable field for
      // field; `dryRun` is what tells them apart.
      log({ mode, outcome: "ok", force, dryRun, ...result }, "out");
      return EXIT_OK;
    } catch (cause) {
      // `sanitizeReason` — shared with `parity-run.ts` — redacts anything
      // that looks like a Stripe key before this reaches a log line that
      // outlives the run. The populated-mode guard's own message never
      // contains one, but a Stripe API error easily can.
      log({ mode, outcome: "failed", reason: sanitizeReason(cause) }, "err");
      return EXIT_FAILED;
    }
  } finally {
    // In `finally`, swallowing its own error — mirrors `parity-check.ts`: by
    // the time this runs the outcome is already decided and logged, so a
    // teardown failure must not turn a successful bootstrap into a failed
    // job.
    await closeTesserixPool().catch(() => {});
  }
}

/**
 * Only when run as a program, never when imported by a test. Mirrors
 * `parity-check.ts`'s own guard exactly, including comparing against
 * `argv[1]` so the bundled `.mjs` and this source behave identically.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void runCatalogBootstrapJob(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref();
  });
}
