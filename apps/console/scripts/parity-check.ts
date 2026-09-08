import { pathToFileURL } from "node:url";

import { machineCredential } from "@/lib/auth/machine-token";
import { performParityCheck, runEntitlementParityCheck } from "@/lib/billing/parity-run";
import { CATALOG_SOURCES } from "@/lib/billing/source-policy";
import { STRIPE_MODES } from "@/lib/billing/stripe-read";
import { recordParityRun } from "@/lib/db/plan-catalog-repo";
import { closeTesserixPool, isDatabaseConfigured } from "@/lib/db/tesserix";
import { platformApiOrigin } from "@/lib/platform-api";

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
 * # It covers every (mode, source) PAIR, in one invocation
 *
 * One process, one comparison and one row per pair of `STRIPE_MODES` x
 * `CATALOG_SOURCES` — not a CronJob each. The pairs share a pool's worth of
 * everything, and splitting them would multiply the schedule, the manifest and
 * the number of places a `TESSERIX_DB_*` typo can hide.
 *
 * Pairs and not modes since tesserix-home#392: a run recorded against one
 * catalog says nothing about another, so a mode-keyed run would leave a second
 * source's drift compared against nothing while the window still read as
 * satisfied — the silent omission, not a wrong answer.
 *
 * They are nonetheless INDEPENDENT where it counts: a pair that fails, or
 * whose row cannot be written, must not cost the other pairs their rows. Live
 * has no restricted key provisioned yet and may not for some time; if that
 * took test down with it, one absent secret would put a hole in every day of
 * the window rather than in live's half of it.
 *
 * # TWO CHECKS, ONE INVOCATION (#146)
 *
 * The price pass compares the plan catalog against Stripe Prices, per (mode,
 * source). The entitlement pass compares the published plan-feature matrix
 * against the one each PRODUCT actually enforces, per source — the mode is not
 * an input there, it is an ANSWER the product gives, so the axis is sources
 * alone (see `performEntitlementParityCheck`).
 *
 * They share this process and nothing else. In particular they share no early
 * return: a price failure must not skip the entitlement pass, and an
 * entitlement failure must not cost a price pair its row. That is the same
 * independence property the pairs already have among themselves, one axis out,
 * and for the identical reason — a missing row is the day-shaped hole this
 * design exists to prevent, and it reads as a clean day a week later.
 *
 * The entitlement pass runs AS THE CONSOLE ITSELF (`as: "machine"`, #618).
 * There is no operator here and none can be minted, so the operator resolver
 * would answer "this session carries no platform API access token" every night
 * and every run would be unattributable. The machine path was built for
 * exactly this caller and this is its first and only production selection.
 *
 * # Not in this repo
 *
 * The CronJob manifest itself lives in `tesserix-k8s` (#653). It needs: the
 * console image, a `command` override pointing at the bundle, the
 * `TESSERIX_DB_*` environment the console already has, and BOTH
 * `STRIPE_RESTRICTED_READ_KEY_TEST` and `STRIPE_RESTRICTED_READ_KEY_LIVE` from
 * Secret Manager — each gated and each `optional: true`, because a mode
 * without a key must produce a `failed` row rather than an unschedulable pod.
 *
 * tesserix-k8s#1054 adds the entitlement pass's half: `ZITADEL_MACHINE_CLIENT_ID`,
 * `ZITADEL_MACHINE_CLIENT_SECRET`, `ZITADEL_ISSUER`, `ZITADEL_PROJECT_ID` and
 * `PLATFORM_API_ORIGIN` — also `optional: true`, and see
 * {@link entitlementPreconditionGap} for what this job does when they are absent.
 */

/**
 * Every (mode, source) pair ran and answered.
 *
 * `differences` IS SUCCESS, and so is `not_bootstrapped`. Both are the check's
 * OUTPUT, not a crash, and neither must be reported as one: a non-zero exit
 * makes Kubernetes retry the job, and the retry writes a SECOND row for the
 * same finding — so a single day would be counted twice in the window that
 * P2's decision rests on.
 *
 * `not_bootstrapped` is the one worth spelling out. Live has zero
 * `mark8ly_*` prices and no date by which it will have any, so an exit code
 * that paged for it would fire nightly for months — and an alert that fires
 * nightly for months is an alert somebody mutes, taking the real failures with
 * it.
 */
export const EXIT_OK = 0;

/**
 * At least one check could not run, and said so in a `failed` row.
 *
 * ACROSS BOTH PASSES, deliberately. These codes describe the state of the
 * EVIDENCE, not which comparator produced it: a nightly job exiting 0 while an
 * entitlement row says `failed` would leave the same finding unread as a price
 * row saying it. The two passes only ever RAISE the code — they are accumulated
 * and the worst wins — so an entitlement outcome can never mask a price one,
 * and the price pass's own contribution is bit-for-bit what it was.
 *
 * Non-zero so the CronJob's own alerting fires: an unreadable catalog, an
 * unreachable Stripe or a credential that names the wrong mode is an upstream
 * problem, categorically different from "the catalog has drifted", and the two
 * must be distinguishable without opening `psql`.
 *
 * KEPT DESPITE COVERING ONLY SOME PAIRS. One pair failing while the others are
 * clean still means a day of the window has a `failed` row in it, and nobody
 * finds that out by reading a green job list.
 */
export const EXIT_CHECK_FAILED = 1;

/**
 * There was nowhere to write the evidence, for at least one attempt.
 *
 * ACROSS BOTH PASSES, and the entitlement pass reaches it two ways rather than
 * one — see {@link runEntitlementPass}. A comparison that never happened and a
 * comparison whose row would not write are different faults with different
 * remedies, but to the table they are the same fact: no evidence exists for
 * this attempt, and nothing may make that look like agreement.
 *
 * NOT reached by an UNPROVISIONED machine credential. That is a legitimate
 * deployment state, not a hole — see {@link entitlementPreconditionGap}.
 *
 * The one failure this design cannot record. Distinct from
 * {@link EXIT_CHECK_FAILED} on purpose: that code means a row EXISTS saying
 * the check failed, this one means NO ROW EXISTS AT ALL — a day-shaped hole in
 * the window, indistinguishable from a clean day to whoever reads the table
 * next week. The CronJob's own failure is the only signal covering it, so it
 * has to be loud and separately identifiable.
 *
 * OUTRANKS {@link EXIT_CHECK_FAILED} when both happen in the same invocation:
 * a `failed` row is evidence, a missing row is a gap that reads as agreement,
 * and the worse of the two is the one that must reach the exit code.
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

/** What one pass contributed to the exit code. Accumulated, never returned
 *  early on — see {@link runParityCheckJob}. */
interface PassOutcome {
  /** At least one comparison answered `failed`, and a row says so. */
  checkFailed: boolean;
  /** At least one attempt left no row at all. */
  unrecordable: boolean;
}

/**
 * Why the entitlement pass cannot run on this deployment, or `null` when it
 * can.
 *
 * # An absent credential is a STATE, not a fault
 *
 * Every variable the machine path needs is `optional: true` in tesserix-k8s#1054,
 * so a deployment without them is legitimate — and was the only state that
 * existed until #618 was provisioned. Letting that reach
 * {@link runEntitlementParityCheck} would produce an `unattributable` result
 * every night: {@link EXIT_UNRECORDABLE}, a failing CronJob, and an alert that
 * fires nightly for as long as nobody provisions the grant. That is the
 * muted-alert failure {@link EXIT_OK} already spells out for `not_bootstrapped`,
 * arriving one axis over.
 *
 * So it is checked BEFORE the first call, the pass is skipped, and the exit
 * code is left exactly where the price pass put it. Nothing is recorded and
 * nothing pretends to have been.
 *
 * # `incomplete` is checked here too, and is still not a failure
 *
 * Half a credential is a deploy that went wrong rather than one that never
 * happened, and it is worth naming loudly — `machineCredential` names the
 * missing variables and never a value. But it is no more recordable than an
 * absent one: there is still no token and so still no comparison, and turning
 * it into a non-zero exit would put the price pass's evidence behind an
 * unrelated secret's rollout.
 */
function entitlementPreconditionGap(): { reason: string; stream: "out" | "err" } | null {
  if (!platformApiOrigin()) {
    return {
      reason: "PLATFORM_API_ORIGIN is not set; no product can be asked for its matrix",
      stream: "err",
    };
  }
  const resolution = machineCredential();
  if (resolution.state === "absent") {
    // The ordinary unprovisioned state. stdout, because nothing is wrong.
    return {
      reason:
        "no machine credential is configured for the platform API (#618); entitlement parity is not enabled on this deployment",
      stream: "out",
    };
  }
  if (resolution.state === "incomplete") {
    return {
      // Names the variables, never a value — `machineCredential`'s own
      // contract, restated at the only place this job prints it.
      reason: `the platform API machine credential is incompletely configured; missing ${resolution.missing.join(", ")}`,
      stream: "err",
    };
  }
  return null;
}

/**
 * Compare each product's entitlement matrix against the published one, record
 * a row per source, and report what it contributed to the exit code.
 *
 * # Three outcomes, not two, and the log must keep them apart
 *
 * {@link runEntitlementParityCheck} carries `run` and `notRecorded`
 * independently, which is three states and not a boolean:
 *
 *  - `run === null` — UNATTRIBUTABLE. No comparison happened at all: the
 *    product did not answer, answered for nobody, answered with a mode no row
 *    can be filed under, or the read threw. THE REMEDY IS THE PRODUCT — its
 *    deployment, its `CONSOLE_CATALOG_MODE`, its federation entry.
 *  - `run !== null && notRecorded !== null` — UNRECORDABLE. The comparison was
 *    DECIDED and the row would not write. THE REMEDY IS POSTGRES, and the
 *    decided outcome is worth printing beside it because it is the only place
 *    that finding now exists.
 *  - `notRecorded === null` — recorded. The run's own outcome carries it.
 *
 * Both of the first two raise {@link EXIT_UNRECORDABLE}, because to the table
 * they are the same absence. They are logged differently because they send
 * different people at different systems, and a single "unrecordable" line would
 * send both of them at the wrong one.
 *
 * # The write failure's message is NOT logged
 *
 * `notRecorded` has been through `sanitizeReason`, which redacts Stripe keys.
 * A `pg` error is a different threat and passes through it untouched:
 * "password authentication failed for user tesserix_admin" names the role, and
 * a connection error echoes the host. So the raw `cause` is reduced by
 * {@link describeWriteFailure} — class and `code` — exactly as the price pass
 * already does, and for the same reason: this log line goes to the cluster's
 * sink at a longer retention and a wider audience than the row.
 *
 * The UNATTRIBUTABLE reason IS logged in full. It is a platform-API or
 * federation message about a product, holds no console credential, and is the
 * only thing that says which product to go and look at.
 */
async function runEntitlementPass(): Promise<PassOutcome> {
  const outcome: PassOutcome = { checkFailed: false, unrecordable: false };

  const gap = entitlementPreconditionGap();
  if (gap) {
    log({ check: "entitlements", outcome: "skipped", reason: gap.reason }, gap.stream);
    return outcome;
  }

  // One source at a time and accumulated, for the price pass's reasons
  // verbatim: an early return on the first source would cost the rest their
  // rows, and the log order stays fixed.
  for (const source of CATALOG_SOURCES) {
    // Never throws — every failure comes back as one of the three states.
    const { run, notRecorded, cause } = await runEntitlementParityCheck(source, {
      // The whole point of #618. See this file's header.
      as: "machine",
    });

    if (run === null) {
      log(
        {
          check: "entitlements",
          source,
          outcome: "unattributable",
          // No `mode`: not knowing which mode was read is the DEFINITION of
          // this state, and printing a guessed one would be the coercion
          // `performEntitlementParityCheck` refuses at the source.
          reason: notRecorded,
        },
        "err",
      );
      outcome.unrecordable = true;
      continue;
    }

    if (notRecorded !== null) {
      log(
        {
          check: "entitlements",
          mode: run.mode,
          source,
          outcome: "unrecordable",
          // What the comparison DECIDED, printed because the row that would
          // have held it does not exist. Without this the finding is gone.
          decided: run.outcome,
          differenceCount: run.differences.length,
          reason: "the entitlement parity run could not be written to plan_catalog_parity_runs",
          ...describeWriteFailure(cause),
        },
        "err",
      );
      outcome.unrecordable = true;
      continue;
    }

    log(
      {
        check: "entitlements",
        mode: run.mode,
        source,
        outcome: run.outcome,
        differenceCount: run.differences.length,
        // Already redacted by `performEntitlementParityCheck`; null on every
        // outcome except `failed`.
        error: run.error,
      },
      run.outcome === "failed" ? "err" : "out",
    );

    if (run.outcome === "failed") outcome.checkFailed = true;
  }

  return outcome;
}

/**
 * Run both checks — every (mode, source) price pair and every source's
 * entitlement matrix — record exactly one row each, and report an exit code.
 *
 * Returns the code rather than calling `process.exit` so the whole thing is
 * testable — including the cases a naive implementation gets wrong, which are
 * `differences` exiting non-zero and one pair's failure swallowing another's
 * row.
 *
 * EXACTLY ONE ROW PER PAIR, ON EVERY PATH IT CAN REACH. Never zero: a run that
 * dies silently leaves a gap in the 7-day window. Never two: a duplicate makes
 * a single day's finding look like two.
 *
 * Sequential rather than `Promise.all`, for three reasons that all point the
 * same way: the log lines come out in a fixed order (mode-major — test's
 * sources, then live's), the pairs do not contend for the same small
 * connection pool, and a rate limit hit on one account cannot be blamed on
 * another.
 */
export async function runParityCheckJob(): Promise<number> {
  try {
    if (!isDatabaseConfigured()) {
      // Refuse before ANY Stripe call, and refuse once rather than per pair:
      // nothing pair-specific has happened yet. The stored row IS the
      // deliverable, so a run that could not be recorded is not a run — and
      // failing early keeps a misconfigured job from spending both restricted
      // keys' rate limits on every tick.
      log(
        {
          outcome: "unrecordable",
          reason: "TESSERIX_DB_HOST/USER/PASSWORD are not set; nothing could be recorded",
        },
        "err",
      );
      return EXIT_UNRECORDABLE;
    }

    // Accumulated rather than returned early, which IS the independence
    // property: an early return on the first pair's failure would cost the
    // rest their rows, and a missing row is the day-shaped hole this whole
    // design exists to prevent. The entitlement pass below folds into the same
    // two flags for the same reason, one axis out.
    let unrecordable = false;
    let checkFailed = false;

    // Nested rather than a precomputed list of pairs: two loops over the two
    // constant arrays is the whole cross product, and it fixes the log order
    // as mode-major.
    for (const mode of STRIPE_MODES) {
      for (const source of CATALOG_SOURCES) {
        // Never throws — every failure comes back as a `failed` run to record.
        const run = await performParityCheck(mode, source);

        try {
          await recordParityRun(run);
        } catch (cause) {
          log(
            {
              mode,
              // Logged beside `mode` for the same reason it is stored beside
              // it: a line naming only the mode cannot say which catalog
              // failed to be recorded, which is the ambiguity
              // tesserix-home#392 closes.
              source,
              outcome: "unrecordable",
              reason: "the parity run could not be written to plan_catalog_parity_runs",
              ...describeWriteFailure(cause),
            },
            "err",
          );
          unrecordable = true;
          continue;
        }

        log(
          {
            mode,
            source,
            outcome: run.outcome,
            differenceCount: run.differences.length,
            // Already redacted by `performParityCheck`; null on every outcome
            // except `failed`.
            error: run.error,
          },
          run.outcome === "failed" ? "err" : "out",
        );

        if (run.outcome === "failed") checkFailed = true;
      }
    }

    // AFTER the price loop and OUTSIDE it, unconditionally. Not inside a
    // `if (!checkFailed)`, and not before: the two passes are independent in
    // both directions, so a Stripe outage must not cost the entitlement rows
    // and vice versa. Both have written everything they can by this point.
    const entitlements = await runEntitlementPass();
    // OR'd rather than assigned: this pass may only raise the code. See
    // {@link EXIT_CHECK_FAILED} — an entitlement result can never turn a price
    // `failed` row, or a price row that would not write, into a green job.
    checkFailed = checkFailed || entitlements.checkFailed;
    unrecordable = unrecordable || entitlements.unrecordable;

    // Precedence, worst first. See {@link EXIT_UNRECORDABLE}: a `failed` row is
    // evidence and a missing row is a gap that reads as agreement.
    if (unrecordable) return EXIT_UNRECORDABLE;
    return checkFailed ? EXIT_CHECK_FAILED : EXIT_OK;
  } finally {
    // In `finally`, and swallowing its own error: by the time this runs the
    // rows are written and the outcomes decided, so a teardown failure must not
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
