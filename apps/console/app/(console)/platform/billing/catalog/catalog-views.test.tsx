import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import type { CatalogRow, ModeLatestRun, ParityWindowStatus } from "@/lib/db/plan-catalog-repo";
import type { Difference } from "@/lib/billing/parity";
import { resolveState } from "@/components/kit/surface-state";
import {
  CatalogViews,
  dayVerdict,
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

describe("dayVerdict — a missing day must not read as a dirty one", () => {
  it("is clean when the day is clean", () => {
    expect(dayVerdict({ day: "2026-08-20", clean: true }, "2026-08-20")).toBe("clean");
  });

  it("is a gap when the day falls after the mode's latest recorded run", () => {
    // Mathematically certain, not a guess: no run can exist for a mode after
    // its own most recent run, so a not-clean day later than that is
    // provably a day nothing ran at all.
    expect(dayVerdict({ day: "2026-08-27", clean: false }, "2026-08-25")).toBe("gap");
  });

  it("is a gap for every day when the mode has never run at all", () => {
    expect(dayVerdict({ day: "2026-08-20", clean: false }, null)).toBe("gap");
  });

  it("is 'not clean' — not a confident 'dirty' — for a day at or before the latest run", () => {
    // Honest degradation: a day this old might have been a genuine failure or
    // an earlier gap the check recovered from, and the data available here
    // cannot tell those apart. Overstating either way is worse than the
    // neutral label.
    expect(dayVerdict({ day: "2026-08-24", clean: false }, "2026-08-25")).toBe("not-clean");
    expect(dayVerdict({ day: "2026-08-25", clean: false }, "2026-08-25")).toBe("not-clean");
  });
});

const readyWindow: ParityWindowStatus = {
  days: 7,
  satisfied: true,
  modes: [
    {
      mode: "test",
      satisfied: true,
      days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-08-2${i}`, clean: true })),
    },
    {
      mode: "live",
      satisfied: false,
      days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-08-2${i}`, clean: false })),
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
