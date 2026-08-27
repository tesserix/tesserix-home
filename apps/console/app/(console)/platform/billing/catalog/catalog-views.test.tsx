import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import type { CatalogRow, ModeLatestRun, ParityWindowStatus } from "@/lib/db/plan-catalog-repo";
import type { Difference } from "@/lib/billing/parity";
import { resolveState } from "@/components/kit/surface-state";
import {
  CatalogViews,
  dayVerdict,
  formatCatalogAmount,
  formatRanAt,
  groupCatalogRows,
  outcomeLabel,
  outcomeTone,
  summarizeDifferences,
} from "./catalog-views";

/**
 * The client half's pure functions first — same split `billing-views.tsx`'s
 * suite makes — then a handful of render smoke tests for the states the task
 * calls out by name: loaded, error, empty, and "no runs recorded yet".
 */

const catalogRow = (over: Partial<CatalogRow> = {}): CatalogRow => ({
  lookupKey: "mark8ly_pro_annual_developed_v1",
  plan: "pro",
  period: "annual",
  tier: "developed",
  source: "mark8ly",
  currency: "usd",
  unitAmountMinor: 118_800,
  taxBehavior: "unspecified",
  ...over,
});

describe("groupCatalogRows", () => {
  it("folds a developed descriptor's seven currency rows into one price", () => {
    // The exact bug the task warns against: 78 amount rows must not read as
    // 78 prices. A `developed` descriptor is ONE Stripe Price with six more
    // currencies riding in `currency_options`.
    const rows = [
      catalogRow({ currency: "usd", unitAmountMinor: 118_800 }),
      catalogRow({ currency: "aud", unitAmountMinor: 178_800, taxBehavior: "exclusive" }),
      catalogRow({ currency: "eur", unitAmountMinor: 106_800 }),
    ];

    const grouped = groupCatalogRows(rows);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].lookupKey).toBe("mark8ly_pro_annual_developed_v1");
    expect(grouped[0].amounts).toHaveLength(3);
    expect(grouped[0].amounts.map((a) => a.currency)).toEqual(["usd", "aud", "eur"]);
  });

  it("keeps a ppp descriptor as its own single-currency price", () => {
    const rows = [
      catalogRow({
        lookupKey: "mark8ly_pro_annual_ppp_idr_v1",
        tier: "ppp",
        currency: "idr",
        unitAmountMinor: 1_198_800_000,
      }),
    ];

    const grouped = groupCatalogRows(rows);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].amounts).toHaveLength(1);
  });

  it("keeps distinct lookup keys as distinct prices", () => {
    const rows = [
      catalogRow({ lookupKey: "a" }),
      catalogRow({ lookupKey: "b" }),
    ];
    expect(groupCatalogRows(rows)).toHaveLength(2);
  });

  it("returns nothing for no rows", () => {
    expect(groupCatalogRows([])).toEqual([]);
  });
});

describe("formatCatalogAmount — never the raw stored minor units", () => {
  it("formats a non-zero-decimal currency as a human price, not the stored integer", () => {
    // 118800 stored minor units is $1,188.00 — printing the integer is the
    // whole bug this function replaces.
    const rendered = formatCatalogAmount("usd", 118_800, "mark8ly");
    expect(rendered).not.toContain("118800");
    expect(rendered).toMatch(/1,188(\.00)?/);
  });

  it("divides a zero-decimal currency by 100 rather than printing mark8ly's x100-scaled storage value", () => {
    // The defect the coordinator's report named directly: mark8ly stores
    // zero-decimal currencies (VND here) multiplied by 100 for internal
    // consistency, and that is a storage convention, not a Stripe fact. The
    // catalog's real VND annual amount is 197,880,000 stored minor units,
    // which Stripe actually holds as 1,978,800 — printing the stored value
    // verbatim is 100x the real price, the exact bug this codebase already
    // fixed twice elsewhere (the comparator and the write path).
    const rendered = formatCatalogAmount("vnd", 197_880_000, "mark8ly");
    expect(rendered).not.toContain("197,880,000");
    expect(rendered).not.toContain("197880000");
    expect(rendered).toMatch(/1,978,800/);
  });

  it("does not touch a currency source-policy says is not scaled", () => {
    // `toStripeUnitAmount` only divides zero-decimal currencies, and only
    // under mark8ly's `amountsAreScaledBy100` policy — a currency with a real
    // minor unit (AUD) must pass through unchanged before formatting.
    const rendered = formatCatalogAmount("aud", 178_800, "mark8ly");
    expect(rendered).toMatch(/1,788(\.00)?/);
  });
});

describe("summarizeDifferences", () => {
  const amountMismatch = (lookupKey: string): Difference => ({
    kind: "amount_mismatch",
    lookupKey,
    currency: "vnd",
    catalogUnitAmountMinor: 1,
    stripeUnitAmountMinor: 2,
    zeroDecimalSuspect: false,
  });

  it("groups by kind and carries the affected lookup keys", () => {
    const summary = summarizeDifferences([
      amountMismatch("mark8ly_pro_annual_ppp_vnd_v1"),
      amountMismatch("mark8ly_starter_annual_ppp_vnd_v1"),
    ]);

    expect(summary).toEqual([
      {
        kind: "amount_mismatch",
        label: "Amount mismatch",
        count: 2,
        lookupKeys: ["mark8ly_pro_annual_ppp_vnd_v1", "mark8ly_starter_annual_ppp_vnd_v1"],
      },
    ]);
  });

  it("returns nothing for a clean run", () => {
    expect(summarizeDifferences([])).toEqual([]);
  });

  it("orders kinds deterministically rather than by report order", () => {
    const shapeMismatch: Difference = {
      kind: "price_shape_mismatch",
      lookupKey: "k",
      field: "interval",
      catalogValue: "month",
      stripeValue: "year",
    };
    const summary = summarizeDifferences([shapeMismatch, amountMismatch("k2")]);
    expect(summary.map((s) => s.kind)).toEqual(["amount_mismatch", "price_shape_mismatch"]);
  });
});

describe("outcomeTone / outcomeLabel", () => {
  it("gives clean a positive tone and everything else a distinct one", () => {
    expect(outcomeTone("clean")).toBe("success");
    expect(outcomeTone("differences")).toBe("warning");
    expect(outcomeTone("failed")).toBe("error");
    expect(outcomeTone("not_bootstrapped")).toBe("neutral");
  });

  it("labels every outcome in words, not the raw enum value", () => {
    expect(outcomeLabel("clean")).toBe("Clean");
    expect(outcomeLabel("not_bootstrapped")).toBe("Not bootstrapped");
  });
});

describe("formatRanAt", () => {
  it("renders a UTC timestamp, unambiguously", () => {
    expect(formatRanAt("2026-08-27T03:15:00.000Z")).toBe("2026-08-27 03:15 UTC");
  });
});

describe("dayVerdict — a day with no run must never read as a dirty one", () => {
  it("is clean when the day ran and was clean", () => {
    expect(dayVerdict({ day: "2026-08-20", clean: true, ran: true })).toBe("clean");
  });

  it("is dirty when the day ran and was not clean", () => {
    expect(dayVerdict({ day: "2026-08-20", clean: false, ran: true })).toBe("dirty");
  });

  it("is a gap when nothing ran that day — regardless of `clean`", () => {
    // This is the production bug: `clean: false` alone cannot distinguish a
    // day the check ran and failed from a day the check never ran, and both
    // used to render the same red. `ran` settles it directly rather than by
    // inference.
    expect(dayVerdict({ day: "2026-08-20", clean: false, ran: false })).toBe("gap");
  });

  it("trusts `ran` over any inference from position in the window", () => {
    // No date comparison, no "latest run" lookup — a gap is a gap wherever it
    // falls in the strip, including the very last (most recent) day.
    expect(dayVerdict({ day: "2026-08-27", clean: false, ran: false })).toBe("gap");
    expect(dayVerdict({ day: "2026-08-21", clean: false, ran: false })).toBe("gap");
  });
});

const readyWindow: ParityWindowStatus = {
  days: 7,
  satisfied: true,
  modes: [
    {
      mode: "test",
      satisfied: true,
      days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-08-2${i}`, clean: true, ran: true })),
    },
    {
      mode: "live",
      satisfied: false,
      days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-08-2${i}`, clean: false, ran: true })),
    },
  ],
};

const noRuns: ModeLatestRun[] = [
  { mode: "test", run: null },
  { mode: "live", run: null },
];

function renderViews(over: Partial<Parameters<typeof CatalogViews>[0]> = {}) {
  return render(
    <CatalogViews
      mode="live"
      windowDays={7}
      windowStatus={readyWindow}
      windowState={resolveState({ isLoading: false, error: null, rows: readyWindow.modes, filtered: false })}
      catalog={[]}
      catalogState={resolveState({ isLoading: false, error: null, rows: [], filtered: false })}
      runs={noRuns}
      runsState={resolveState({ isLoading: false, error: null, rows: noRuns, filtered: false })}
      {...over}
    />,
  );
}

describe("CatalogViews", () => {
  it("renders the catalog table when rows are ready", () => {
    const rows = [catalogRow()];
    renderViews({ catalog: rows, catalogState: resolveState({ isLoading: false, error: null, rows, filtered: false }) });
    expect(screen.getByText("mark8ly_pro_annual_developed_v1")).toBeInTheDocument();
  });

  it("says so, calmly, when no runs have ever been recorded", () => {
    renderViews();
    expect(screen.getAllByText(/no parity check has run yet/i).length).toBeGreaterThan(0);
  });

  it("renders an error without crashing", () => {
    renderViews({
      catalogState: resolveState({
        isLoading: false,
        error: { message: "boom" },
        rows: [],
        filtered: false,
      }),
    });
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("renders the empty catalog state distinctly from an error", () => {
    renderViews({ catalog: [], catalogState: resolveState({ isLoading: false, error: null, rows: [], filtered: false }) });
    expect(screen.queryByText(/went wrong/i)).not.toBeInTheDocument();
  });
});
