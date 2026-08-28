import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// `actions.ts` reaches `publish-executor.ts` / `publish-repo.ts` (both
// `server-only`, both `pg`, one of them `stripe`) through `publishAction` —
// mocked so this render suite exercises the CLIENT half only (the operation
// summary, the refusal copy, the typed-mode gate) without dragging a
// database or a Stripe key into a jsdom test. Same discipline
// `draft-editor.render.test.tsx` applies to `setAmountAction`; the server
// half is covered directly in `actions.test.ts`.
vi.mock("./actions", () => ({
  publishAction: vi.fn().mockResolvedValue({
    ok: true,
    outcome: "succeeded",
    promoted: true,
    failedOperations: [],
  }),
}));

import { checkGuards, type GuardBreach, type GuardRule, type GuardVerdict } from "@/lib/billing/publish-guards";
import type { PublishPlan, PublishPlanCounts } from "@/lib/billing/publish-plan";
import type { StripeMode } from "@/lib/billing/stripe-read";
import { PublishView } from "./publish-view";

/**
 * task-4-brief.md's six tests, VERBATIM. Everything below the tests is the
 * fixture builder they share.
 *
 * # Why `renderPlan` opens the dialog before returning
 *
 * Tests 3-6 assert on the confirm button, the typed-mode input and the
 * dialog's own accessible description — all of which live inside
 * `DestructiveConfirmDialog` (`components/kit/`), which is a real Radix
 * modal and therefore not in the document until it is opened. The trigger
 * that opens it is deliberately NOT named "publish" ("Review changes"), so
 * `getByRole("button", { name: /publish/i })` in tests 3-5 resolves to
 * exactly one element — the dialog's own confirm button — rather than
 * ambiguously matching a trigger as well.
 */

/**
 * The brief's fixtures name two counts this codebase spells differently:
 * `update_currency_options` for what `publish-plan.ts` calls
 * `add_currency_option`, and `drift` for `driftCorrection`. Translated here
 * rather than renamed in the production type: the plan's count keys are the
 * operation kinds Stripe actually performs, and `PublishPlanCounts` is read
 * by the guards (`publish-guards.ts`) as well as by this view.
 */
interface CountsFixture {
  readonly create_product?: number;
  readonly create_price?: number;
  readonly replace_price?: number;
  readonly update_currency_options?: number;
  readonly update_tax_behavior?: number;
  readonly archive_price?: number;
  readonly intended?: number;
  readonly drift?: number;
}

/** The brief's guard fixtures carry `detail` where `GuardBreach` carries
 *  `message`; a fixture that omits it (test 6's bare `{ rule: "magnitude" }`)
 *  gets the rule's own name as its message, which is enough for a test that
 *  asserts on the DIALOG's description rather than on the breach text. */
interface BreachFixture {
  readonly rule: GuardRule;
  readonly detail?: string;
}

interface GuardsFixture {
  readonly refused?: readonly BreachFixture[];
  readonly requiresConfirmation?: readonly BreachFixture[];
}

function buildCounts(fixture: CountsFixture = {}): PublishPlanCounts {
  const kinds = {
    create_product: fixture.create_product ?? 0,
    create_price: fixture.create_price ?? 0,
    replace_price: fixture.replace_price ?? 0,
    add_currency_option: fixture.update_currency_options ?? 0,
    update_tax_behavior: fixture.update_tax_behavior ?? 0,
    archive_price: fixture.archive_price ?? 0,
  };
  const kindTotal = Object.values(kinds).reduce((sum, n) => sum + n, 0);
  const intended = fixture.intended ?? kindTotal;
  const driftCorrection = fixture.drift ?? 0;
  return {
    ...kinds,
    // `total` is `intended + driftCorrection` in a real plan — every
    // operation carries exactly one origin. Taken as the larger of the two
    // derivations so a fixture that names only kinds and one that names only
    // origins both produce a coherent count.
    total: Math.max(kindTotal, intended + driftCorrection),
    intended,
    driftCorrection,
    unactionable: 0,
  };
}

function toBreaches(fixtures: readonly BreachFixture[] | undefined): GuardBreach[] {
  return (fixtures ?? []).map((breach) => ({
    rule: breach.rule,
    message: breach.detail ?? breach.rule,
  }));
}

/**
 * A verdict the fixture named, or — when it named none — the REAL
 * `checkGuards` verdict for this plan and mode. That default is what makes
 * test 4 evidence about the shipped refusal rather than about a hand-written
 * fixture: `renderPlan({ mode: "live" })` names no guards at all, and the
 * refusal it renders comes from `publish-guards.ts`'s own `checkMode`.
 */
function buildVerdict(guards: GuardsFixture | undefined, plan: PublishPlan, mode: StripeMode): GuardVerdict {
  if (guards?.refused?.length) return { ok: false, refused: toBreaches(guards.refused) };
  if (guards?.requiresConfirmation?.length) {
    return { ok: false, requiresConfirmation: toBreaches(guards.requiresConfirmation) };
  }
  return checkGuards(plan, [], mode);
}

function renderPlan(
  options: { mode?: StripeMode; counts?: CountsFixture; guards?: GuardsFixture } = {},
) {
  const mode = options.mode ?? "test";
  const counts = buildCounts(options.counts);
  const plan: PublishPlan = { operations: [], fingerprint: "fixture", counts, unactionable: [] };

  render(
    <PublishView
      revisionId="revision-1"
      mode={mode}
      counts={counts}
      unactionable={[]}
      verdict={buildVerdict(options.guards, plan, mode)}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /review changes/i }));
}

describe("PublishView", () => {
  it("leads with what Stripe will DO, not how many rows changed", () => {
    // "6 prices changed" hides the distinction that matters: replacement
    // retires a Price object and mints a new one.
    renderPlan({ counts: { update_currency_options: 3, replace_price: 2, archive_price: 1 } });
    expect(screen.getByText(/3 updated in place/i)).toBeInTheDocument();
    expect(screen.getByText(/2 replaced/i)).toBeInTheDocument();
  });

  it("separates intended changes from drift corrections", () => {
    renderPlan({ counts: { intended: 1, drift: 39 } });
    expect(screen.getByText(/1 intended/i)).toBeInTheDocument();
    expect(screen.getByText(/39 correcting drift/i)).toBeInTheDocument();
  });

  it("requires the mode to be typed before publishing", () => {
    // v1 is test-only, but the control is built for live from the start: live's
    // first publish is a 42-price bootstrap, the largest action this tool takes.
    renderPlan({ mode: "test" });
    const confirm = screen.getByRole("button", { name: /publish/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/type the mode/i), { target: { value: "test" } });
    expect(confirm).toBeEnabled();
  });

  it("refuses a live publish and says why", () => {
    renderPlan({ mode: "live" });
    expect(screen.getByRole("alert")).toHaveTextContent(/live publishing is not enabled/i);
    expect(screen.queryByRole("button", { name: /publish/i })).toBeDisabled();
  });

  it("blocks entirely on a refusal, and only warns on a confirmation breach", () => {
    renderPlan({ guards: { refused: [{ rule: "currency-coverage", detail: "gbp missing from pro monthly" }] } });
    expect(screen.getByRole("button", { name: /publish/i })).toBeDisabled();
    expect(screen.getByText(/gbp missing/i)).toBeInTheDocument();
  });

  it("names the plan in the confirmation dialog", () => {
    // DestructiveConfirmDialog carries the aria-describedby association a
    // screen-reader operator needs to learn why a confirm button is unreachable.
    renderPlan({ guards: { requiresConfirmation: [{ rule: "magnitude" }] } });
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(/25%/);
  });

  /**
   * Not in the brief. The brief's test 5 asserts that a refusal disables the
   * confirm button; it does not assert the other half of its own name — that
   * a CONFIRMATION breach does not. Without this, a view that disabled the
   * button for any non-`ok` verdict would pass every test above while making
   * spec §7's magnitude and breadth rules unconfirmable-past, which is
   * exactly the refusal/confirmation collapse `publish-guards.ts`'s header
   * exists to prevent.
   */
  it("still allows a confirmed publish through a confirmation breach", () => {
    renderPlan({ guards: { requiresConfirmation: [{ rule: "magnitude", detail: "pro monthly moves 90%" }] } });
    const confirm = screen.getByRole("button", { name: /publish/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/type the mode/i), { target: { value: "TEST " } });
    expect(confirm).toBeEnabled();
  });
});
