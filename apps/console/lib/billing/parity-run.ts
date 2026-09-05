// `server-only`: this module reaches `pg` (through `plan-catalog-repo`) and
// `stripe` (through `stripe-read`). A client component that imports it must
// fail `next build` with the chain named, exactly as its two dependencies do.
// The comparator itself — `lib/billing/parity.ts` — deliberately stays free of
// this, so P1b's surface can render a stored report without dragging either
// library into a browser bundle.
import "server-only";

import { compareCatalogToStripe } from "@/lib/billing/parity";
import { CATALOG_SOURCES, policyFor, type CatalogSource } from "@/lib/billing/source-policy";
import { STRIPE_MODES, stripePriceReader, type StripeMode } from "@/lib/billing/stripe-read";
import {
  readCatalogAmounts,
  readLivePublication,
  recordParityRun,
  type ParityRun,
} from "@/lib/db/plan-catalog-repo";

// PER (MODE, SOURCE). `performParityCheck` takes both axes and neither has a
// default, because a run that does not name the catalog it read cannot be
// filed against one: `plan_catalog_parity_runs.source` (0044) is what makes
// "every pair clean for 7 days" mean seven days of EVERY catalog agreeing
// rather than one source answering for all of them. tesserix-home#392 closed that gap
// end to end — the column, the two reads in `plan-catalog-repo.ts`, both
// runners and the console surface — so there is no single-source assumption
// left in this module to describe.
//
// `SINGLE_SOURCE` (`source-policy.ts`) still exists and is still correct for
// callers that must pick ONE source because they have nowhere to put a second
// answer — `bootstrap.ts`, the catalog surface's `page.tsx`. This is not one
// of them, and it is no longer re-exported from here: every importer already
// takes it from `source-policy.ts` directly.

/**
 * One parity check, decided but not yet recorded — the body both runners share.
 *
 * # Why this is a module and not a copy in each runner
 *
 * There are two ways to run the check, and there must only ever be one
 * DEFINITION of it:
 *
 *  - `app/api/internal/parity-check/route.ts` — an operator presses a button.
 *  - `scripts/parity-check.ts` — the Kubernetes CronJob, which has no operator
 *    and cannot mint a session, so it cannot call the route.
 *
 * Both write into `plan_catalog_parity_runs`, and #326's 7-day window is read
 * as a single sequence of rows. If each runner decided `clean` /
 * `differences` / `failed` for itself, that window would be a mixture of two
 * definitions that had drifted apart — and P2 revokes mark8ly's Stripe write
 * key on the strength of it. Removing exactly this class of duplication is why
 * #326 exists.
 *
 * # Where the runners legitimately differ, and why that is not here
 *
 * At the WRITE, and only at the write. `recordParityRun` is the one failure
 * this design cannot record — with the database unreachable there is nowhere
 * to put the evidence — and the two runners raise that alarm differently: the
 * route answers 500, the script exits non-zero so the CronJob's own failure is
 * the signal. So this function stops one step short of the write and hands
 * back the row to be written.
 */

/** The longest reason `plan_catalog_parity_runs.error` will hold. Long enough
 *  for a Stripe error plus its context, short enough that one pathological
 *  message cannot dominate the table an operator reads. */
export const MAX_ERROR_LENGTH = 512;

/**
 * Anything that looks like a Stripe key, gone before it is stored.
 *
 * Stripe echoes request context into some error messages — "Invalid API Key
 * provided: rk_live_..." among them — and the `error` column is read by an
 * operator and lives as long as the row. Covers the live, test and restricted
 * prefixes; the trailing class is deliberately greedy about what counts as key
 * material, because over-redacting an error message costs nothing and
 * under-redacting one costs a credential.
 */
const STRIPE_KEY_PATTERN = /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]+/g;

/**
 * Turn a thrown value into a reason safe to store and useful to read.
 *
 * Named separately from the driver's own message for the same reason
 * `/api/notifications` refuses to return one: an error out of `pg` can echo
 * the connection string and the role name back.
 */
export function sanitizeReason(cause: unknown): string {
  const raw =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : `Unknown error: ${String(cause)}`;
  const redacted = raw.replace(STRIPE_KEY_PATTERN, "[redacted]");
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : redacted;
}

/**
 * Read the catalog, read one mode's live Stripe Prices, compare — and never
 * throw.
 *
 * The catch is deliberately broad. Every failure becomes a `failed` run for
 * the caller to record, because a check that silently does nothing when Stripe
 * is unreachable leaves a DAY-SHAPED HOLE in the 7-day window, and a hole is
 * indistinguishable from a clean day to anybody reading the table afterwards.
 *
 * It never writes to Stripe. It cannot: `lib/billing/stripe-read.ts` exposes
 * one method and holds its `Stripe` instances privately. That is enforced
 * there, not asserted here.
 *
 * # One (mode, source) PAIR per call, and both travel with the answer
 *
 * The returned {@link ParityRun} carries the mode AND the source it checked,
 * so the row that gets written names both the account it read and the catalog
 * it compared. A run recorded under the wrong mode would make #327's gate
 * satisfiable by one mode answering twice; a run recorded under the wrong
 * source does the same thing one axis over, which is the omission
 * tesserix-home#392 closed. Either way the whole gate is defeated by one
 * mislabelled row.
 *
 * Within a mode, the SOURCE decides which catalog rows are read
 * (`readCatalogAmounts(mode, source)`) and which `lookup_key` prefix and
 * amount convention the comparison uses (`policyFor(source)`). Within a
 * source, the MODE decides which Stripe account is listed. Neither parameter
 * has a default: this is the check #327 revokes a Stripe write key on the
 * strength of, and it must say what it read rather than assume.
 */
export async function performParityCheck(
  mode: StripeMode,
  source: CatalogSource,
): Promise<ParityRun> {
  try {
    // Read first, and read once: `readCatalogAmounts` and `readLivePublication`
    // answer related questions about the SAME row (see their shared `WHERE` in
    // `plan-catalog-repo.ts`), and reading the publication here means the id
    // that lands on the returned `ParityRun` is the one this run actually
    // compared against — not a later publication that raced it. `null` is the
    // normal answer for a mode that has never been published, not a failure;
    // it flows straight through to every branch below, including
    // `not_bootstrapped`.
    //
    // BY MODE ALONE, and that is correct rather than an oversight: a
    // publication is a fact about a (mode, revision) pair and a revision holds
    // prices for every source (0035), so one publication legitimately serves
    // both sources' runs within a mode. 0044 states the same thing from the
    // schema's side, and says so explicitly to stop a later reader "fixing"
    // 0036's constraint to match the new per-pair runs.
    const publication = await readLivePublication(mode);
    const publicationId = publication ? publication.id : null;

    // Sequential, not `Promise.all`: a catalog read that fails should not also
    // spend a Stripe request, and the ordering makes "which side broke"
    // legible in the stored reason.
    const catalog = await readCatalogAmounts(mode, source);
    const prices = await stripePriceReader.listPrices(mode);
    // The source's own policy and lookup-key prefix, threaded through
    // explicitly rather than left to `compareCatalogToStripe`'s defaults.
    // Those defaults exist so a TEST fixture can omit them; this is the
    // check #327 revokes a Stripe write key on the strength of, and it must
    // say what it means rather than fall back to whatever the comparator
    // assumes when nobody says.
    const sourcePolicy = policyFor(source);
    const { differences, stripePriceCount } = compareCatalogToStripe(
      catalog,
      prices,
      sourcePolicy.lookupKeyPrefix,
      sourcePolicy,
    );

    // ZERO IS A DIFFERENT FACT, NOT A LARGER NUMBER OF DIFFERENCES.
    //
    // As of 2026-08-27 the live account holds zero `mark8ly_*` prices — zero
    // products, zero subscriptions. The catalog exists only in test mode.
    // Comparing 42 keys against nothing produces 42 `price_missing_in_stripe`
    // findings, and reporting those every night for a mode nobody has launched
    // is noise that trains people to ignore the report. The report is the only
    // evidence the observation window is made of, so training people to ignore
    // it destroys the window.
    //
    // `not_bootstrapped` says "nothing here yet". `differences` says
    // "something here is wrong". Different facts, and they must look
    // different.
    //
    // ONLY ZERO. A partial bootstrap — 20 of 42 — is genuinely `differences`
    // and stays that way. That is the case where someone ran the tool and it
    // half-worked, which is considerably more dangerous than not having run it
    // at all, and it must never hide behind "nothing here yet".
    //
    // `stripePriceCount` and NOT `prices.length`: the count is the comparator's
    // NAMESPACE-FILTERED one. The Stripe account is shared, so an account full
    // of somebody else's Prices and none of ours has still never been
    // bootstrapped — a raw length check would call that `differences`.
    //
    // The comparator's 42 findings are DISCARDED here rather than stored:
    // 0034 refuses a `not_bootstrapped` row with a non-zero count, because a
    // row asserting both "nothing here yet" and "42 findings" is incoherent
    // and unreadable a week later.
    if (stripePriceCount === 0) {
      // Note the case this also catches: an EMPTY CATALOG against an empty
      // Stripe. There are no differences, so `clean` would be defensible — and
      // it would be the wrong answer. A catalog read that returned nothing is
      // a broken read, and letting it count a day towards the window is
      // exactly the false clean everything here is built to prevent.
      // `publicationId` here is `null` exactly when the mode has never been
      // published — the ordinary shape of `not_bootstrapped` — but it is NOT
      // hard-coded: a publication that exists with zero Stripe Prices behind
      // it (a bootstrap that never ran) still names the catalog this run
      // checked, so the read above's answer travels through unchanged.
      return { mode, source, outcome: "not_bootstrapped", differences: [], error: null, publicationId };
    }

    return {
      mode,
      source,
      outcome: differences.length === 0 ? "clean" : "differences",
      differences,
      error: null,
      publicationId,
    };
  } catch (cause) {
    // `publicationId: null` here, deliberately, and not the value read above:
    // a run that failed before or during the read has no verified
    // relationship to any published catalog — it may have failed reading the
    // publication itself, or before comparing against it meant anything.
    // Recording a publication id on a `failed` row would claim this run
    // checked that catalog, which is exactly the fact a `failed` outcome
    // says it cannot prove.
    return {
      mode,
      source,
      outcome: "failed",
      differences: [],
      error: sanitizeReason(cause),
      publicationId: null,
    };
  }
}

/**
 * What one full run of every (mode, source) pair produced.
 *
 * `runs` holds only the pairs whose row was WRITTEN — a pair whose write threw
 * has no evidence behind it and is reported through `unrecordable` instead, so
 * a caller cannot mistake it for a pair that answered.
 *
 * The two flags are facts about the run, not a verdict on it: which alarm they
 * raise belongs to the caller, because the two callers raise it differently.
 * The route turns them into 500 / 502 / 200 and the CronJob's script into exit
 * codes — the same split {@link performParityCheck} stops one step short of.
 */
export interface AllParityPairsResult {
  readonly runs: readonly ParityRun[];
  /** At least one pair's row could not be written. The one failure this design
   *  cannot record, and the worse of the two: see {@link runAllParityPairs}. */
  readonly unrecordable: boolean;
  /** At least one RECORDED pair came back `failed` — a row exists saying the
   *  check could not run. */
  readonly checkFailed: boolean;
}

/**
 * Run every (mode, source) pair, record one row each, and report what happened.
 *
 * # Why this is a module function and not a loop in each caller
 *
 * The same argument {@link performParityCheck} makes, one level up. Two
 * callers run the whole cross product — the operator route
 * (`app/api/internal/parity-check/route.ts`) and the catalog surface's audited
 * re-run action — and the invariants below are the kind that are lost by
 * being restated: a copy that returned early on the first failure would keep
 * passing its own tests while writing fewer rows into the same 7-day window
 * that P2 revokes mark8ly's Stripe write key on.
 *
 * # Every (mode, source) pair, and they are independent
 *
 * One call runs every pair of `STRIPE_MODES` x `CATALOG_SOURCES` and writes a
 * row for each. Pairs and not modes since tesserix-home#392: a run recorded
 * against one catalog says nothing about another, so a mode-keyed run would
 * leave a second source's drift compared against nothing while the window
 * still read as satisfied.
 *
 * A failure in one pair must not cost the others their rows: live has no
 * restricted key provisioned yet, and a runner that gave up on the first error
 * would silently stop test's window too — turning one absent secret into a
 * hole in every day of it rather than in live's half.
 *
 * # Every failure path writes a `failed` row
 *
 * This is the one invariant worth stating above everything else. A check that
 * silently does nothing when Stripe is unreachable leaves a DAY-SHAPED HOLE in
 * the 7-day window, and a hole is indistinguishable from a clean day to
 * anybody reading `plan_catalog_parity_runs` afterwards. #327 — and mark8ly
 * #303/#304/#305 behind it — gate on that window. {@link performParityCheck}'s
 * catch is what guarantees it; the only failure that does NOT produce a row is
 * a database that cannot take one, which is what `unrecordable` reports.
 *
 * # The CronJob's script still owns its own loop
 *
 * `scripts/parity-check.ts` does not call this, and that is a deliberate limit
 * rather than an oversight to fix later: its per-pair JSON log line is the only
 * signal a 3am run produces, and one of those lines carries the CLASS AND
 * SQLSTATE of a failed write (`describeWriteFailure`) — a thrown value that
 * does not survive this function's return. Giving it back would mean either
 * leaking a `pg` message the route deliberately refuses to return, or a
 * callback parameter no other caller wants. Both callers of this function are
 * HTTP-shaped and answer with a status code; the script is not, and the
 * decision that actually matters — the four outcomes — is already shared
 * through {@link performParityCheck}.
 */
export async function runAllParityPairs(): Promise<AllParityPairsResult> {
  const runs: ParityRun[] = [];
  // Accumulated rather than returned early. Returning on the first problem is
  // the bug this shape exists to prevent: it would cost every LATER pair its
  // row, and a missing row reads as a clean day to whoever looks next week.
  let unrecordable = false;
  let checkFailed = false;

  // Nested rather than a precomputed list of pairs: two loops over the two
  // constant arrays is the whole cross product, and it keeps the order fixed
  // as mode-major (test's sources, then live's) for every caller's log lines
  // and response body alike.
  for (const mode of STRIPE_MODES) {
    for (const source of CATALOG_SOURCES) {
      // Never throws — every failure comes back as a `failed` run to record.
      const run = await performParityCheck(mode, source);

      try {
        await recordParityRun(run);
      } catch {
        // The one failure this design cannot record: with the database
        // unreachable there is nowhere to put the evidence. Noted and carried
        // on with, so the remaining pairs still get their rows.
        unrecordable = true;
        continue;
      }

      if (run.outcome === "failed") checkFailed = true;
      runs.push(run);
    }
  }

  return { runs, unrecordable, checkFailed };
}
