import { NextResponse } from "next/server";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";

import { checkOperatorCapability } from "@/lib/auth/operator";
import { compareCatalogToStripe } from "@/lib/billing/parity";
import { stripePriceReader } from "@/lib/billing/stripe-read";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import { readCatalogAmounts, recordParityRun } from "@/lib/db/plan-catalog-repo";

/**
 * The plan-catalog parity check: read the catalog, read live Stripe Prices,
 * compare, record one row.
 *
 * # Every failure path writes a `failed` row
 *
 * This is the one invariant worth stating above everything else. A check that
 * silently does nothing when Stripe is unreachable leaves a DAY-SHAPED HOLE in
 * the 7-day window, and a hole is indistinguishable from a clean day to
 * anybody reading `plan_catalog_parity_runs` afterwards. #327 — and mark8ly
 * #303/#304/#305 behind it — gate on that window, and P2 revokes mark8ly's
 * Stripe write key on it. So the catch below is deliberately broad, and the
 * only failure that does NOT produce a row is a database that cannot take one
 * (see {@link POST}).
 *
 * # It never writes to Stripe
 *
 * It cannot: `lib/billing/stripe-read.ts` exposes one method and holds its
 * `Stripe` instance privately. That is enforced there, not asserted here.
 *
 * # Not in this PR
 *
 * The Kubernetes CronJob that calls this route lives in `tesserix-k8s` and is
 * a separate change. Until it lands, nothing calls this on a schedule and the
 * window has not started.
 */

// A check whose whole output is "what is true right now". Caching it would be
// a way to record the same minute seven times and call it a week.
export const dynamic = "force-dynamic";

/** The longest reason `plan_catalog_parity_runs.error` will hold. Long enough
 *  for a Stripe error plus its context, short enough that one pathological
 *  message cannot dominate the table an operator reads. */
const MAX_ERROR_LENGTH = 512;

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

async function authorize(): Promise<null | NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    // `billing`, not `platform`: this reads the estate's pricing and writes a
    // record about it, which is the billing surface's business. The console's
    // existing convention — the handler asserts for itself rather than
    // inheriting safety from the middleware matcher — is what
    // `/api/notifications` does, and this follows it rather than inventing a
    // second scheme.
    checkOperatorCapability(session, "billing");
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw cause;
  }
  return null;
}

export async function POST(): Promise<NextResponse> {
  const refusal = await authorize();
  // A refusal is not a check that failed — it is a check that never started,
  // by someone not entitled to start it. Recording it would let an
  // unauthorized caller write into the window's own evidence.
  if (refusal) return refusal;

  if (!isDatabaseConfigured()) {
    // The stored row IS the deliverable, so a run that could not be recorded
    // is not a run. 501 is the estate's "data plane parked" signal, distinct
    // from a real failure.
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  let outcome: "clean" | "differences" | "failed";
  let differences: ReturnType<typeof compareCatalogToStripe>["differences"] = [];
  let error: string | null = null;

  try {
    // Sequential, not `Promise.all`: a catalog read that fails should not also
    // spend a Stripe request, and the ordering makes "which side broke"
    // legible in the stored reason.
    const catalog = await readCatalogAmounts();
    const prices = await stripePriceReader.listPrices();
    const report = compareCatalogToStripe(catalog, prices);
    differences = report.differences;
    outcome = differences.length === 0 ? "clean" : "differences";
  } catch (cause) {
    outcome = "failed";
    differences = [];
    error = sanitizeReason(cause);
  }

  try {
    await recordParityRun({ outcome, differences, error });
  } catch {
    // The one failure this design cannot record: with the database unreachable
    // there is nowhere to put the evidence. Loud and non-2xx, so the CronJob's
    // own alerting is what covers the gap — silence here would be the
    // day-shaped hole the module header exists to prevent.
    return NextResponse.json({ error: "unavailable" }, { status: 500 });
  }

  if (outcome === "failed") {
    // 502, because the check could not run — an upstream problem, not a
    // finding. Distinct from `differences` below on purpose: a CronJob's
    // alerting must be able to tell "the catalog has drifted" from "the check
    // did not happen", which is the same distinction the three-state outcome
    // draws in the table.
    return NextResponse.json({ outcome, error }, { status: 502 });
  }

  // 200 for `differences` as well as `clean`. Drift is a FINDING; the check
  // ran and answered. Reporting it as an error would conflate the two states
  // the whole design keeps apart.
  return NextResponse.json({
    outcome,
    differenceCount: differences.length,
    differences,
  });
}
