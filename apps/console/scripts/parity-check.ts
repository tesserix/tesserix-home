import { pathToFileURL } from "node:url";

import { performParityCheck } from "@/lib/billing/parity-run";
import { recordParityRun } from "@/lib/db/plan-catalog-repo";
import { closeTesserixPool, isDatabaseConfigured } from "@/lib/db/tesserix";

/**
 * The plan-catalog parity check, as the scheduler runs it.
 *
 * # Why a script and not an HTTP call
 *
 * `app/api/internal/parity-check/route.ts` does this same job behind the
 * console's operator-session guard, and a Kubernetes CronJob has no operator
 * and cannot mint a session — so the scheduler CANNOT call that route. The
 * alternatives were a shared-secret header (a second auth scheme in the
 * console, and a route reachable without an operator — bad neighbours for the
 * P2 argument that revokes mark8ly's Stripe write key) or a Zitadel service
 * account (the largest option, and nothing in this repo does it today).
 *
 * So the CronJob runs THIS, directly: same comparator, same repository
 * functions, no HTTP surface, no new credential path. The route stays as the
 * operator-triggered "run it now" that P1b's surface will use.
 *
 * # It is a caller, not an implementation
 *
 * Everything below `performParityCheck` — reading the catalog, listing Prices,
 * deciding `clean` / `differences` / `failed`, redacting the reason — lives in
 * `lib/billing/parity-run.ts` and is shared with the route. A second copy of
 * that decision is the exact duplication #326 exists to remove, and it would
 * be an invisible one: the copy would pass its own tests while drifting from
 * the route's, leaving the 7-day window holding rows decided two ways.
 *
 * What this file owns is the part a CronJob needs and an HTTP handler does
 * not: exit codes, one log line, and letting the process end.
 *
 * # How it is packaged
 *
 * `Dockerfile.console` ships only Next's standalone output, so arbitrary
 * TypeScript under `apps/console/` is not in the image. `pnpm --filter console
 * build:cron` bundles this file to a single plain-JS module with esbuild, and
 * the Dockerfile copies that into the runtime stage.
 *
 * WHAT IS EXTERNAL IS DECIDED BY WHAT THE IMAGE ACTUALLY CONTAINS, and the two
 * SDKs answer differently — checked against a real `next build`, not assumed:
 *
 *  - `pg` IS in `.next/standalone/node_modules`, because Next externalises it
 *    by default. So it stays external here and the job uses the same installed
 *    driver the server does.
 *  - `stripe` IS NOT. Next inlines it into the route's own server chunk and
 *    traces no package. Marking it external would produce a bundle that passes
 *    every check in this repo and then dies in the cluster with
 *    `ERR_MODULE_NOT_FOUND: Cannot find package 'stripe'` — on a CronJob, at
 *    3am, as a `failed` job with no row. So it is INLINED, which is the same
 *    thing Next already does for the server.
 *
 * If either fact changes — a Next default, or `serverExternalPackages` in
 * `next.config.ts` — `--external:` in `build:cron` has to change with it.
 *
 * # Not in this repo
 *
 * The CronJob manifest itself lives in `tesserix-k8s`. It needs: the console
 * image, a `command` override pointing at the bundle, the `TESSERIX_DB_*`
 * environment the console already has, and `STRIPE_RESTRICTED_READ_KEY` from
 * Secret Manager.
 */

/**
 * The check ran and answered.
 *
 * `differences` IS SUCCESS. Drift is the check's output, not a crash, and it
 * must not be reported as one: a non-zero exit makes Kubernetes retry the job,
 * and the retry writes a SECOND row for the same finding — so a single drifted
 * day would be counted twice in the window that P2's decision rests on.
 */
export const EXIT_OK = 0;

/**
 * The check could not run, and said so in a `failed` row.
 *
 * Non-zero so the CronJob's own alerting fires: an unreadable catalog or an
 * unreachable Stripe is an upstream problem, categorically different from
 * "the catalog has drifted", and the two must be distinguishable without
 * opening `psql`.
 */
export const EXIT_CHECK_FAILED = 1;

/**
 * There was nowhere to write the evidence.
 *
 * The one failure this design cannot record. Distinct from
 * {@link EXIT_CHECK_FAILED} on purpose: that code means a row EXISTS saying
 * the check failed, this one means NO ROW EXISTS AT ALL — a day-shaped hole in
 * the window, indistinguishable from a clean day to whoever reads the table
 * next week. The CronJob's own failure is the only signal covering it, so it
 * has to be loud and separately identifiable.
 */
export const EXIT_UNRECORDABLE = 2;

/** How long to wait for a stray handle before forcing the exit. Long enough
 *  for one line of stdout to reach a pipe, short enough to be invisible. */
const EXIT_GRACE_MS = 2_000;

/**
 * Describe a write failure WITHOUT its message.
 *
 * `sanitizeReason` is not enough here, and the difference is the reason this
 * function exists. It redacts Stripe keys, because that is what can appear in
 * a Stripe error; a `pg` error is a different threat — "password
 * authentication failed for user tesserix_admin" names the role, and a
 * connection error echoes the host. The route sidesteps this by answering a
 * bare `{"error":"unavailable"}` and saying nothing at all, but a CronJob's
 * log line is the ONLY signal anyone gets, so it has to be informative and
 * safe at the same time.
 *
 * So: the error's class and its `code` — SQLSTATE from `pg` (`28P01` is a bad
 * password, `ECONNREFUSED` is a dead host), which is the diagnostic half of
 * the message with none of the credential half. The message itself is never
 * logged.
 */
function describeWriteFailure(cause: unknown): { errorName: string; errorCode: string | null } {
  const errorName = cause instanceof Error ? cause.name : typeof cause;
  const raw = (cause as { code?: unknown } | null)?.code;
  // Bounded and stringified rather than trusted: `code` is conventionally a
  // short enum, but it arrives from a library and this value is being written
  // to a log sink.
  const errorCode = typeof raw === "string" ? raw.slice(0, 32) : null;
  return { errorName, errorCode };
}

function log(line: Record<string, unknown>, stream: "out" | "err"): void {
  // One line, JSON, on the stream that matches the outcome — this is a
  // container whose stdout is the cluster's log sink, so structure here is
  // what makes a week of runs greppable.
  const rendered = JSON.stringify({ job: "plan-catalog-parity", ...line });
  if (stream === "err") console.error(rendered);
  else console.log(rendered);
}

/**
 * Run the check, record exactly one row, and report an exit code.
 *
 * Returns the code rather than calling `process.exit` so the whole thing is
 * testable — including the case a naive implementation gets wrong, which is
 * `differences` exiting 0.
 *
 * EXACTLY ONE ROW, ON EVERY PATH IT CAN REACH. Never zero: a run that dies
 * silently leaves a gap in the 7-day window. Never two: a duplicate makes a
 * single day's finding look like two.
 */
export async function runParityCheckJob(): Promise<number> {
  try {
    if (!isDatabaseConfigured()) {
      // Refuse before the Stripe call. The stored row IS the deliverable, so a
      // run that could not be recorded is not a run — and failing early keeps
      // a misconfigured job from spending the restricted key's rate limit on
      // every tick.
      log(
        {
          outcome: "unrecordable",
          reason: "TESSERIX_DB_HOST/USER/PASSWORD are not set; nothing could be recorded",
        },
        "err",
      );
      return EXIT_UNRECORDABLE;
    }

    const run = await performParityCheck();

    try {
      await recordParityRun(run);
    } catch (cause) {
      log(
        {
          outcome: "unrecordable",
          reason: "the parity run could not be written to plan_catalog_parity_runs",
          ...describeWriteFailure(cause),
        },
        "err",
      );
      return EXIT_UNRECORDABLE;
    }

    log(
      {
        outcome: run.outcome,
        differenceCount: run.differences.length,
        // Already redacted by `performParityCheck`; null on a clean or
        // drifted run.
        error: run.error,
      },
      run.outcome === "failed" ? "err" : "out",
    );

    return run.outcome === "failed" ? EXIT_CHECK_FAILED : EXIT_OK;
  } finally {
    // In `finally`, and swallowing its own error: by the time this runs the
    // row is written and the outcome decided, so a teardown failure must not
    // turn a clean check into a failed job.
    await closeTesserixPool().catch(() => {});
  }
}

/**
 * Only when run as a program, never when imported by a test.
 *
 * Compared against `argv[1]` rather than assumed, so the bundled `.mjs` and
 * the TypeScript source behave identically — and so importing this module
 * under Vitest does not start a run against whatever environment the test
 * machine happens to have.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void runParityCheckJob().then((code) => {
    process.exitCode = code;
    // The pool is closed by now, but the Stripe SDK's keep-alive sockets can
    // outlive the request that opened them. `exitCode` alone would leave the
    // container running until `activeDeadlineSeconds` and report a successful
    // check as a failed job; `process.exit` alone can truncate the log line
    // above before it reaches the pipe. So: exit naturally if the loop is
    // already empty (the timer is unref'd, so it does not itself keep the
    // process alive), and force it shortly after if it is not.
    setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref();
  });
}
