import { NextResponse } from "next/server";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";

import { checkOperatorCapability } from "@/lib/auth/operator";
import { performParityCheck } from "@/lib/billing/parity-run";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import { recordParityRun } from "@/lib/db/plan-catalog-repo";

/**
 * The plan-catalog parity check: read the catalog, read live Stripe Prices,
 * compare, record one row — triggered by an OPERATOR.
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
 * Both runners get their `clean` / `differences` / `failed` decision from
 * `lib/billing/parity-run.ts`, so the 7-day window is one sequence of rows
 * under one definition rather than a mixture of two.
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

  // The comparison itself is shared with `scripts/parity-check.ts`, which is
  // what the CronJob runs — see that module's header for why there must be
  // exactly one definition of `clean` / `differences` / `failed`.
  const { outcome, differences, error } = await performParityCheck();

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
