import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { PublishAttemptOutcome } from "@/lib/db/publish-repo";
import { SINGLE_SOURCE } from "@/lib/billing/source-policy";
import type { StripeMode } from "@/lib/billing/stripe-read";
import { PublishOutcome, type PublishOutcomeOperation, type PublishOutcomeOrphan } from "./publish-outcome";

/**
 * task-5-brief.md's four tests, VERBATIM. Everything below the tests is the
 * fixture builder they share.
 *
 * # Why fixtures are narrower than the real row shapes
 *
 * The brief's operation fixtures (`{ sequence, kind, lookupKey, status,
 * error }`) carry fewer fields than `PublishOperationRow` (`publish-repo.ts`)
 * — no `id`, `attemptId`, `stripeCall`, `source`, `currency`,
 * `stripePriceId`, `idempotencyKey`, `startedAt`, `finishedAt` — and the
 * brief's `kind` value (`"update_currency_options"`) is not even a real
 * `OperationKind` (`publish-plan.ts` spells it `"add_currency_option"`,
 * singular, no `update_` prefix). `publish-view.render.test.tsx` hits the
 * identical mismatch for `PublishPlanCounts` and resolves it the same way
 * this file does: the component's own prop type
 * (`PublishOutcomeOperation`) is a display-shaped subset the production
 * type can always be mapped onto, not a re-export of the DB row, so the
 * brief's fixtures type-check as written rather than needing translation.
 */
interface OperationFixture {
  readonly sequence: number;
  readonly kind: string;
  readonly lookupKey: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly error?: string;
}

interface OrphanFixture {
  readonly priceId: string;
  readonly lookupKey: string;
  readonly source?: string;
}

function buildOperations(fixtures: readonly OperationFixture[] | undefined): PublishOutcomeOperation[] {
  return (fixtures ?? []).map((fixture) => ({
    sequence: fixture.sequence,
    kind: fixture.kind,
    lookupKey: fixture.lookupKey,
    status: fixture.status,
    error: fixture.error ?? null,
  }));
}

function buildOrphans(fixtures: readonly OrphanFixture[] | undefined): PublishOutcomeOrphan[] {
  // Same discipline `buildOperations` already applies to `error`: the
  // brief's fixture is narrower than the production `Orphan` type
  // (`orphans.ts`), and the fix belongs in the builder, not in a widened
  // (optional) field on the component's own prop type. Every real orphan
  // row carries a `source` — `findOrphans` always populates it — so a
  // fixture that omits one gets the same constant `findOrphans` itself
  // defaults to (`SINGLE_SOURCE`, `source-policy.ts`), not a magic string.
  return (fixtures ?? []).map((fixture) => ({
    priceId: fixture.priceId,
    lookupKey: fixture.lookupKey,
    source: fixture.source ?? SINGLE_SOURCE,
  }));
}

function renderOutcome(
  options: {
    mode?: StripeMode;
    // `| null` is not laxness: it is the shape a PERSISTED attempt can have
    // (tesserix-home#410) — one that never recorded a verdict — so the
    // fixture builder has to be able to express it.
    outcome?: PublishAttemptOutcome | null;
    promoted?: boolean;
    operations?: readonly OperationFixture[];
    orphans?: readonly OrphanFixture[];
  } = {},
) {
  // Defaults to `"failed"`: that is the outcome this whole surface exists
  // for (see `publish-outcome.tsx`'s header), and every test that does not
  // name an outcome either asserts on failed-attempt behaviour or does not
  // care which outcome it sees.
  //
  // Compared against `undefined` rather than written with `??`: `null` is a
  // MEANINGFUL outcome here (an attempt still in flight, which never
  // recorded a verdict), and `??` would silently coerce it to the `"failed"`
  // default — quietly disarming every in-flight test below.
  const outcome = options.outcome === undefined ? "failed" : options.outcome;
  render(
    <PublishOutcome
      attemptId="attempt-1"
      mode={options.mode ?? "test"}
      outcome={outcome}
      // Mirrors `publishAction`'s own rule (`actions.ts`): promoted only on
      // a fully succeeded outcome, unless a test names otherwise.
      promoted={options.promoted ?? outcome === "succeeded"}
      operations={buildOperations(options.operations)}
      orphans={buildOrphans(options.orphans)}
      replanHref="/platform/billing/catalog"
    />,
  );
}

describe("PublishOutcome", () => {
  it("shows which operations landed and which did not, immediately", () => {
    // Not "logged, detectable later". A publish that errors with a spinner and
    // no detail leaves the operator guessing whether Stripe is half-changed.
    renderOutcome({
      operations: [
        { sequence: 1, kind: "update_currency_options", lookupKey: "a", status: "succeeded" },
        { sequence: 2, kind: "replace_price", lookupKey: "b", status: "failed", error: "rate limited" },
      ],
    });
    expect(screen.getByText(/rate limited/)).toBeInTheDocument();
    // Header row + one row per operation — but the count alone does not
    // prove the two rows read differently, and a component that just prints
    // `operation.error` whenever present (ignoring `status` entirely) would
    // still pass a bare length assertion, since only the failed fixture
    // supplies an error. Scope into each data row and require it to name
    // its OWN status, so a component that renders every row identically
    // fails here.
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText(/succeeded/i)).toBeInTheDocument();
    expect(within(rows[2]).getByText(/failed/i)).toBeInTheDocument();
    expect(within(rows[1]).queryByText(/failed/i)).toBeNull();
    expect(within(rows[2]).queryByText(/^succeeded$/i)).toBeNull();
  });

  it("surfaces orphans found by the automatic post-failure check", () => {
    // The parity check CANNOT see these — it skips prices with a null
    // lookup_key, and a transferred-away price has one. It would report clean.
    renderOutcome({ orphans: [{ priceId: "price_old", lookupKey: "b" }] });
    expect(screen.getByText(/price_old/)).toBeInTheDocument();
    expect(screen.getByText(/still active in Stripe/i)).toBeInTheDocument();
  });

  it("offers re-planning rather than retrying the same plan", () => {
    // Recovery is re-observe-and-re-plan. Retrying a stale plan risks acting on
    // a captured price id that is no longer what it was.
    renderOutcome({ outcome: "failed" });
    expect(screen.getByRole("link", { name: /re-plan/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
  });

  it("says the publication was NOT promoted when the attempt failed", () => {
    renderOutcome({ outcome: "failed", promoted: false });
    expect(screen.getByText(/still published/i)).toBeInTheDocument();
  });

  it("says an attempt that never recorded an outcome has no verdict, rather than calling it failed", () => {
    // The single most important attempt to render well: a publish that died
    // between `startPublishAttempt` and `finishPublishAttempt` is exactly
    // the crash that strands an orphaned Price. Saying "failed" would
    // assert more than the log knows.
    renderOutcome({ outcome: null });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/never recorded an outcome/i);
    expect(status).toHaveTextContent(/does not say it failed/i);
    // The same truthful claim the failed branch makes, worded the same way.
    expect(status).toHaveTextContent(/NOT promoted/);
    expect(status).toHaveTextContent(/previous revision is still published/i);
    // Re-plan, never retry — this surface's rule everywhere.
    expect(status).toHaveTextContent(/re-plan against what Stripe holds now/i);
    // And it points at the orphan risk without asserting an orphan exists.
    expect(status).toHaveTextContent(/orphan/i);
  });

  it("shows the operations an in-flight attempt already wrote", () => {
    // An unresolved attempt is not an aborted one: `executePublish` DID
    // enter `plan.operations`, so the write-ahead log has rows and they are
    // the only evidence of what reached Stripe.
    renderOutcome({
      outcome: null,
      operations: [
        { sequence: 1, kind: "replace_price", lookupKey: "a", status: "succeeded" },
        { sequence: 2, kind: "replace_price", lookupKey: "b", status: "pending" },
      ],
    });
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText(/succeeded/i)).toBeInTheDocument();
    expect(within(rows[2]).getByText(/pending/i)).toBeInTheDocument();
  });

  it("does not claim promotion for an in-flight attempt", () => {
    renderOutcome({ outcome: null });
    // The success sentence claims Stripe matches the revision; an attempt
    // with no verdict claims nothing of the sort.
    expect(screen.queryByText(/Stripe now matches this revision/i)).toBeNull();
    expect(screen.getByText(/Re-planning observes Stripe fresh/i)).toBeInTheDocument();
  });

  it("offers re-planning for an in-flight attempt", () => {
    renderOutcome({ outcome: null });
    expect(screen.getByRole("link", { name: /re-plan/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
  });
});
