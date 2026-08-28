import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// `actions.ts` reaches `publish-repo.ts` (`server-only`, `pg`) through
// `setAmountAction` — mocked so this render suite exercises the CLIENT half
// only (validation, the magnitude warning, the subscriber-safety note)
// without dragging a database into a jsdom test. `AmountCell.handleBlur` is
// the only caller, and none of the tests below blur an input, so the mock is
// never actually invoked; it exists so the module graph resolves at all.
vi.mock("./actions", () => ({
  setAmountAction: vi.fn().mockResolvedValue({ ok: true }),
}));

import { DraftEditor, type DraftEditorRow } from "./draft-editor";

/**
 * task-3-brief.md's five tests, MODIFIED for two of them per a controller
 * ruling (2026-08-28) that overrode the brief: tests 4 and 5, as the brief
 * wrote them, encoded draft 3 of
 * `docs/superpowers/specs/2026-08-27-console-catalog-authoring-design.md` —
 * a "non-baseline currency edit reprices existing subscribers" claim §6 of
 * the FINAL (third) draft disproves by sandbox experiment: `[V]` there is no
 * in-place amount edit at all, so no catalog edit here can reprice an
 * existing subscriber. Shipping the brief's test 4 as written would have
 * encoded a false safety claim in the product. See `draft-editor.tsx`'s
 * module header for the full citation.
 *
 * What changed: the original test 4 ("marks an in-place currency edit as one
 * that reprices existing subscribers") is REMOVED, not weakened. In its
 * place: a test asserting the spec §6-prescribed statement is shown ("new
 * subscriptions only, existing subscribers stay on their Price"), and a
 * regression guard asserting no "reprices existing subscribers" / "next
 * renewal" text can render — so a future edit cannot silently reintroduce
 * the disproved claim. The brief's test 5 (no claim about WHICH or how many
 * subscribers) is kept verbatim; it still holds, and per spec §6 it now also
 * guards the read client's narrow scope ("Do not widen it").
 */

const LOOKUP_KEY = "mark8ly_pro_monthly_developed_v1";

/**
 * Builds a single-row, single-lookup-key fixture whose baseline currency is
 * always `usd`. `published` defaults to 10_700 for the baseline cell so the
 * "10x lower" test and the "published beside draft" test agree on the same
 * starting point without each having to restate it.
 *
 * `currency` — when given and different from the baseline — adds a SECOND
 * cell for that currency, published `null` unless overridden: a currency
 * absent from what Stripe currently holds. Kept for the "does not claim to
 * know WHICH subscribers" test (the brief's test 5, unchanged); it no longer
 * carries an in-place-vs-replacement implication — see `draft-editor.tsx`'s
 * module header.
 */
function buildRow(overrides: {
  currency?: string;
  published?: number | null;
  draft?: number;
} = {}): DraftEditorRow {
  const baselineCell = {
    currency: "usd",
    draftUnitAmountMinor: 10_700,
    publishedUnitAmountMinor: 10_700,
    taxBehavior: "unspecified" as const,
  };

  const amounts = [baselineCell];

  if (overrides.currency && overrides.currency !== "usd") {
    amounts.push({
      currency: overrides.currency,
      draftUnitAmountMinor: overrides.draft ?? 10_700,
      publishedUnitAmountMinor: overrides.published === undefined ? null : overrides.published,
      taxBehavior: "unspecified" as const,
    });
  } else {
    amounts[0] = {
      ...baselineCell,
      draftUnitAmountMinor: overrides.draft ?? baselineCell.draftUnitAmountMinor,
      publishedUnitAmountMinor:
        overrides.published === undefined ? baselineCell.publishedUnitAmountMinor : overrides.published,
    };
  }

  return {
    lookupKey: LOOKUP_KEY,
    plan: "pro",
    period: "monthly",
    tier: "developed",
    baselineCurrency: "usd",
    amounts,
  };
}

function renderEditor(overrides: { currency?: string; published?: number | null; draft?: number } = {}) {
  const row = buildRow(overrides);
  render(<DraftEditor revisionId="draft-1" rows={[row]} />);
  return row;
}

function amountInput(lookupKey: string, currency: string): HTMLElement {
  return screen.getByLabelText(`${lookupKey} ${currency} amount`);
}

/**
 * Renders a fresh editor for `lookupKey`/`currency` and types `minor` into
 * that cell's input — the interaction, not the render, is the unit under
 * test in the two `it`s that call this.
 */
function editAmount(lookupKey: string, currency: string, minor: number) {
  const row: DraftEditorRow = {
    lookupKey,
    plan: "pro",
    period: "monthly",
    tier: "developed",
    baselineCurrency: currency,
    amounts: [
      {
        currency,
        draftUnitAmountMinor: 10_700,
        publishedUnitAmountMinor: 10_700,
        taxBehavior: "unspecified",
      },
    ],
  };
  render(<DraftEditor revisionId="draft-1" rows={[row]} />);
  fireEvent.change(amountInput(lookupKey, currency), { target: { value: String(minor) } });
}

describe("DraftEditor", () => {
  it("warns at the point of edit when an amount moves more than 25%", () => {
    // Guards in the plan builder are LATE — the wrong number entered here is
    // cheapest to catch here. The plan-level guard still runs; this is the
    // early one. Published is 10_700 (see `editAmount`'s fixture); 1_070 is
    // exactly 10x lower.
    editAmount(LOOKUP_KEY, "usd", 1070); // was 10700
    expect(screen.getByRole("status")).toHaveTextContent(/10x lower than the published/i);
  });

  it("refuses a non-integer or negative amount before it reaches the server", () => {
    editAmount("k", "usd", -1);
    expect(screen.getByRole("alert")).toHaveTextContent(/whole number of minor units/i);
  });

  it("shows the published value beside the draft value", () => {
    // An operator editing needs to see what they are changing FROM.
    renderEditor({ published: 10_700, draft: 11_900 });
    expect(screen.getByText("10700")).toBeInTheDocument();
    expect(screen.getByDisplayValue("11900")).toBeInTheDocument();
  });

  it("states that a change applies to new subscriptions only, and existing subscribers stay on their Price", () => {
    // Spec §6's own closing statement (experiment-settled, `[V]`): "a price
    // change applies to new subscriptions only. Existing subscribers stay
    // on the Price object they were created against until something
    // migrates them deliberately, which is not in scope."
    renderEditor();
    expect(
      screen.getByText(/new subscriptions only.*stay on the price they were created against/i),
    ).toBeInTheDocument();
  });

  it("never renders a 'reprices existing subscribers' or 'next renewal' warning — regression guard", () => {
    // §6: "No catalog edit this design can perform will reprice an existing
    // subscriber." §7 removed the confirmation this warning used to trigger,
    // calling it "a guard against an impossible action". A prior version of
    // this component rendered exactly this false claim for a non-baseline
    // currency addition — this test exists so that claim cannot creep back.
    renderEditor({ currency: "gbp" }); // the exact fixture that used to trip it
    expect(screen.queryByText(/reprices existing subscribers/i)).toBeNull();
    expect(screen.queryByText(/next renewal/i)).toBeNull();
  });

  it("does not claim to know WHICH subscribers", () => {
    // The read client performs no Subscription reads and its key must not be
    // widened for this. The rule is stated; the population is not. Per spec
    // §6, this now also guards the read client's narrow scope: "Do not
    // widen it."
    renderEditor({ currency: "gbp" });
    expect(screen.queryByText(/\d+ subscribers/)).toBeNull();
  });
});
