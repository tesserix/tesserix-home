import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// `actions.ts` reaches `publish-repo.ts` (`server-only`, `pg`) through
// `setAmountAction` — mocked so this render suite exercises the CLIENT half
// only (validation, the magnitude warning, the repricing note) without
// dragging a database into a jsdom test. `AmountCell.handleBlur` is the only
// caller, and none of the five tests below blur an input, so the mock is
// never actually invoked; it exists so the module graph resolves at all.
vi.mock("./actions", () => ({
  setAmountAction: vi.fn().mockResolvedValue({ ok: true }),
}));

import { DraftEditor, type DraftEditorRow } from "./draft-editor";

/**
 * The exact five tests task-3-brief.md specifies, verbatim in intent: the
 * early magnitude warning (reusing `publish-guards.ts`'s own
 * `MAGNITUDE_THRESHOLD` rather than a second "25%" literal), the whole-number
 * refusal, the published-beside-draft display, and the two repricing-rule
 * assertions derived from `publish-plan.ts`'s real operation taxonomy — see
 * `draft-editor.tsx`'s `repricingNote` doc comment for that derivation.
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
 * absent from what Stripe currently holds, which is the non-baseline,
 * in-place (`add_currency_option`) case `repricingNote` documents.
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

  it("marks an in-place currency edit as one that reprices existing subscribers", () => {
    // The safety property is the OPPOSITE of intuition: replacements cannot
    // touch existing subscribers, in-place currency_options changes do, at
    // their next renewal. `gbp` here has no published amount on this
    // already-existing (usd-baseline) Price, so publishing it is
    // `add_currency_option` — the one in-place write `publish-plan.ts`
    // found survives.
    renderEditor({ currency: "gbp" }); // non-baseline -> in place
    expect(screen.getByText(/existing subscribers.*next renewal/i)).toBeInTheDocument();
  });

  it("does not claim to know WHICH subscribers", () => {
    // The read client performs no Subscription reads and its key must not be
    // widened for this. The rule is stated; the population is not.
    renderEditor({ currency: "gbp" });
    expect(screen.queryByText(/\d+ subscribers/)).toBeNull();
  });
});
