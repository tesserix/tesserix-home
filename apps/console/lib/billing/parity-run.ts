// `server-only`: this module reaches `pg` (through `plan-catalog-repo`) and
// `stripe` (through `stripe-read`). A client component that imports it must
// fail `next build` with the chain named, exactly as its two dependencies do.
// The comparator itself — `lib/billing/parity.ts` — deliberately stays free of
// this, so P1b's surface can render a stored report without dragging either
// library into a browser bundle.
import "server-only";

import { compareCatalogToStripe } from "@/lib/billing/parity";
import { stripePriceReader, type StripeMode } from "@/lib/billing/stripe-read";
import { readCatalogAmounts, type ParityRun } from "@/lib/db/plan-catalog-repo";

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
 * # One mode per call, and the mode travels with the answer
 *
 * The returned {@link ParityRun} carries the mode it checked, so the row that
 * gets written names the account it actually read. A run recorded under the
 * wrong mode would make #327's "both modes clean" satisfiable by one mode
 * answering twice, which is the whole gate defeated by one mislabelled row.
 *
 * The catalog side is the SAME for both modes — there is one
 * `plan_catalog_amounts` table and it is what mark8ly intends to charge,
 * everywhere. Only the Stripe side differs.
 */
export async function performParityCheck(mode: StripeMode): Promise<ParityRun> {
  try {
    // Sequential, not `Promise.all`: a catalog read that fails should not also
    // spend a Stripe request, and the ordering makes "which side broke"
    // legible in the stored reason.
    const catalog = await readCatalogAmounts();
    const prices = await stripePriceReader.listPrices(mode);
    const { differences, stripePriceCount } = compareCatalogToStripe(catalog, prices);

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
      return { mode, outcome: "not_bootstrapped", differences: [], error: null };
    }

    return {
      mode,
      outcome: differences.length === 0 ? "clean" : "differences",
      differences,
      error: null,
    };
  } catch (cause) {
    return { mode, outcome: "failed", differences: [], error: sanitizeReason(cause) };
  }
}
