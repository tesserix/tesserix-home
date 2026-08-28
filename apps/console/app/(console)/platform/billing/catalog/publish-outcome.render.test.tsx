import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import type { PublishAttemptOutcome } from "@/lib/db/publish-repo";
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
  return (fixtures ?? []).map((fixture) => ({
    priceId: fixture.priceId,
    lookupKey: fixture.lookupKey,
  }));
}

function renderOutcome(
  options: {
    mode?: StripeMode;
    outcome?: PublishAttemptOutcome;
    promoted?: boolean;
    operations?: readonly OperationFixture[];
    orphans?: readonly OrphanFixture[];
  } = {},
) {
  // Defaults to `"failed"`: that is the outcome this whole surface exists
  // for (see `publish-outcome.tsx`'s header), and every test below either
  // asserts on failed-attempt behaviour or does not care which outcome it
  // sees.
  const outcome = options.outcome ?? "failed";
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
    expect(screen.getAllByRole("row")).toHaveLength(3);
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
});
