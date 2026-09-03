import { NextResponse } from "next/server";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";

import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { performParityCheck } from "@/lib/billing/parity-run";
import { CATALOG_SOURCES, type CatalogSource } from "@/lib/billing/source-policy";
import { STRIPE_MODES } from "@/lib/billing/stripe-read";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import { recordParityRun } from "@/lib/db/plan-catalog-repo";

/**
 * The plan-catalog parity check: read the catalog, read each mode's live
 * Stripe Prices, compare, record one row per (mode, source) pair — triggered
 * by an OPERATOR.
 *
 * # This is not what the schedule runs
 *
 * The route is guarded by the console's operator-session convention, and a
 * Kubernetes CronJob has no operator and cannot mint a session. So the
 * schedule runs `scripts/parity-check.ts` instead, which does the same work
 * directly against the same modules. Giving this route a shared-secret bypass
 * would have meant a second auth scheme in the console AND a route reachable
 * without an operator — bad neighbours for the P2 argument that revokes
 * mark8ly's Stripe write key.
 *
 * Both runners get their `clean` / `differences` / `failed` /
 * `not_bootstrapped` decision from `lib/billing/parity-run.ts`, so the 7-day
 * window is one sequence of rows under one definition rather than a mixture of
 * two.
 *
 * # Every (mode, source) pair, and they are independent
 *
 * One request runs every pair of `STRIPE_MODES` x `CATALOG_SOURCES` and writes
 * a row for each. Pairs and not modes since tesserix-home#392: a run recorded
 * against one catalog says nothing about another, so a mode-keyed run would
 * leave a second source's drift compared against nothing while the window
 * still read as satisfied.
 *
 * A failure in one pair must not cost the others their rows: live has no
 * restricted key provisioned yet, and a route that gave up on the first error
 * would silently stop test's window too — turning one absent secret into a
 * hole in every day of it rather than in live's half.
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
 * The Kubernetes CronJob that runs the script lives in `tesserix-k8s` and is a
 * separate change. Until it lands, nothing runs the check on a schedule and
 * the window has not started.
 */

// A check whose whole output is "what is true right now". Caching it would be
// a way to record the same minute seven times and call it a week.
export const dynamic = "force-dynamic";

// Re-exported, not defined here. It moved to `lib/billing/parity-run.ts` when
// the CronJob's script needed the same redaction: the script cannot import it
// from a route module without dragging `next/server` and the whole operator
// auth stack into a plain-Node bundle, and a second copy of a redaction rule
// is a second place for a credential to survive one.
export { sanitizeReason } from "@/lib/billing/parity-run";

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
    await checkOperatorCapabilityLive(session, "billing");
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw cause;
  }
  return null;
}

/** One (mode, source) pair's result, as the response carries it.
 *  `differences` is the full report so P1b can render it without a second
 *  query.
 *
 *  `source` is here for the same reason `mode` is: a payload naming only the
 *  mode cannot say which catalog answered, which is the ambiguity
 *  tesserix-home#392 closes. */
interface ParityRunBody {
  readonly mode: (typeof STRIPE_MODES)[number];
  readonly source: CatalogSource;
  readonly outcome: string;
  readonly differenceCount: number;
  readonly differences: readonly unknown[];
  readonly error: string | null;
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

  const runs: ParityRunBody[] = [];
  // Accumulated rather than returned early. Returning on the first problem is
  // the bug this shape exists to prevent: it would cost every LATER pair its
  // row, and a missing row reads as a clean day to whoever looks next week.
  let unrecordable = false;
  let checkFailed = false;

  // Nested rather than a precomputed list of pairs: two loops over the two
  // constant arrays is the whole cross product, and it keeps the log/response
  // order fixed as mode-major (test's sources, then live's).
  for (const mode of STRIPE_MODES) {
    for (const source of CATALOG_SOURCES) {
      // The comparison itself is shared with `scripts/parity-check.ts`, which
      // is what the CronJob runs — see that module's header for why there must
      // be exactly one definition of the four outcomes.
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
      runs.push({
        mode: run.mode,
        source: run.source,
        outcome: run.outcome,
        differenceCount: run.differences.length,
        differences: run.differences,
        // Already redacted by `performParityCheck`, which is why an error is
        // safe to return here at all.
        error: run.error,
      });
    }
  }

  if (unrecordable) {
    // Loud and non-2xx, and deliberately saying NOTHING else: a `pg` error
    // names the role and echoes the host. The CronJob's own alerting is what
    // covers the gap — silence here would be the day-shaped hole the module
    // header exists to prevent.
    //
    // Outranks the 502 below: a `failed` row is evidence, a missing row is a
    // gap that reads as agreement, and the worse of the two is what the status
    // code must report.
    return NextResponse.json({ error: "unavailable" }, { status: 500 });
  }

  if (checkFailed) {
    // 502, because a pair could not run — an upstream problem, not a finding.
    // Distinct from the 200 below on purpose: alerting must be able to tell
    // "the catalog has drifted" from "the check did not happen", which is the
    // same distinction the four-state outcome draws in the table.
    //
    // The body still carries EVERY pair, including the ones that answered
    // cleanly. A 502 that hid a clean result would send an operator looking
    // for a fault in a pair that had just answered correctly.
    return NextResponse.json({ runs }, { status: 502 });
  }

  // 200 for `differences` and `not_bootstrapped` as well as `clean`. Both are
  // FINDINGS; the check ran and answered. Reporting either as an error would
  // conflate the states the whole design keeps apart — and in
  // `not_bootstrapped`'s case it would do so nightly, for months, for a
  // condition nobody intends to change this week.
  return NextResponse.json({ runs });
}
