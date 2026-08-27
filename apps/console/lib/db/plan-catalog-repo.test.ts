import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tesserix", () => ({
  tesserixQuery: vi.fn(async () => []),
}));

import { tesserixQuery } from "./tesserix";
import { readCatalogAmounts, readCatalogRows, readLatestRuns, recordParityRun } from "./plan-catalog-repo";

/**
 * The catalog read and the run write — specifically the two places where a
 * value changes shape and could change meaning with it.
 */

const row = (over: Partial<Record<string, string>> = {}) => ({
  lookup_key: "mark8ly_starter_monthly_ppp_idr_v1",
  currency: "idr",
  unit_amount_minor: "19900000",
  tax_behavior: "unspecified",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readCatalogAmounts", () => {
  it("narrows the bigint column to the number the comparator compares with", async () => {
    // `pg` hands a `bigint` back as a STRING. A comparator fed "19900000"
    // would report every single amount as a mismatch against Stripe's number
    // — 78 false positives, the check dead on arrival.
    vi.mocked(tesserixQuery).mockResolvedValue([row()] as never);

    const amounts = await readCatalogAmounts("test");

    expect(amounts).toEqual([
      {
        lookupKey: "mark8ly_starter_monthly_ppp_idr_v1",
        currency: "idr",
        unitAmountMinor: 19_900_000,
        taxBehavior: "unspecified",
      },
    ]);
    expect(typeof amounts[0].unitAmountMinor).toBe("number");
  });

  it("carries the catalog's largest real amount without losing precision", async () => {
    // IDR annual: 1,198,800,000 minor units. Part 1 chose `bigint` for the
    // column because this is "one currency devaluation away" from not fitting
    // int4; it is five orders of magnitude inside a JS safe integer today.
    vi.mocked(tesserixQuery).mockResolvedValue([
      row({ unit_amount_minor: "1198800000" }),
    ] as never);

    const [amount] = await readCatalogAmounts("test");
    expect(amount.unitAmountMinor).toBe(1_198_800_000);
  });

  it("refuses a value too large to compare, naming the row", async () => {
    // Throwing here is right and would be wrong in the comparator: this is a
    // read that cannot produce a usable value, and the route turns it into a
    // `failed` run with a reason. Rounding silently would produce a `clean`
    // run that compared the wrong number.
    vi.mocked(tesserixQuery).mockResolvedValue([
      row({ unit_amount_minor: "9007199254740993" }),
    ] as never);

    await expect(readCatalogAmounts("test")).rejects.toThrow(
      /mark8ly_starter_monthly_ppp_idr_v1\/idr/,
    );
  });
});

describe("recordParityRun", () => {
  it("writes the mode, so a row can be read a week later", async () => {
    // Without this the row is unreadable the moment there are two accounts:
    // `clean` means nothing if you cannot tell which account it was clean
    // against, and #327's gate is "both modes clean".
    await recordParityRun({ mode: "live", outcome: "clean", differences: [], error: null, publicationId: null });

    const [sql, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(String(sql)).toContain("mode");
    expect(params).toEqual(["live", "clean", 0, "[]", null, null]);
  });

  it("writes the publication a clean run was checked against", async () => {
    // A `clean` row is evidence in #327's 7-day window. Without the
    // publication travelling into the row, a row from three days ago cannot
    // say WHICH catalog it agreed with, and republishing invalidates it
    // silently while the row still reads `clean`.
    const publicationId = "33333333-3333-3333-3333-333333333333";

    await recordParityRun({
      mode: "live",
      outcome: "clean",
      differences: [],
      error: null,
      publicationId,
    });

    const [sql, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(String(sql)).toContain("publication_id");
    expect(params).toEqual(["live", "clean", 0, "[]", null, publicationId]);
  });

  it("derives difference_count from the report rather than trusting a caller", async () => {
    const differences = [
      { kind: "amount_mismatch" as const, lookupKey: "k", currency: "vnd",
        catalogUnitAmountMinor: 1, stripeUnitAmountMinor: 2, zeroDecimalSuspect: false },
    ];

    await recordParityRun({ mode: "test", outcome: "differences", differences, error: null, publicationId: null });

    const [, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(params).toEqual([
      "test",
      "differences",
      1,
      JSON.stringify(differences),
      null,
      null,
    ]);
  });

  it("writes an empty array and a null reason for a clean run", async () => {
    await recordParityRun({ mode: "test", outcome: "clean", differences: [], error: null, publicationId: null });
    const [, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(params).toEqual(["test", "clean", 0, "[]", null, null]);
  });

  it("writes no differences for a not_bootstrapped run", async () => {
    // 0034 refuses a `not_bootstrapped` row with a non-zero count. The state
    // means "nothing here yet", and a report attached to it would be the
    // incoherence the constraint exists to make unstorable.
    await recordParityRun({
      mode: "live",
      outcome: "not_bootstrapped",
      differences: [],
      error: null,
      publicationId: null,
    });
    const [, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(params).toEqual(["live", "not_bootstrapped", 0, "[]", null, null]);
  });
});

const catalogRow = (over: Partial<Record<string, string>> = {}) => ({
  lookup_key: "mark8ly_pro_annual_developed_v1",
  plan: "pro",
  period: "annual",
  tier: "developed",
  source: "mark8ly",
  currency: "usd",
  unit_amount_minor: "118800",
  tax_behavior: "unspecified",
  ...over,
});

describe("readCatalogRows", () => {
  it("projects plan, period, tier and source alongside the amount", async () => {
    // The console surface (P3) has to show which plan and cadence a lookup
    // key belongs to and which product's catalog it came from — the exact
    // columns `readCatalogAmounts` deliberately omits because the comparator
    // has no use for them.
    vi.mocked(tesserixQuery).mockResolvedValue([catalogRow()] as never);

    const rows = await readCatalogRows("live");

    expect(rows).toEqual([
      {
        lookupKey: "mark8ly_pro_annual_developed_v1",
        plan: "pro",
        period: "annual",
        tier: "developed",
        source: "mark8ly",
        currency: "usd",
        unitAmountMinor: 118_800,
        taxBehavior: "unspecified",
      },
    ]);
  });

  it("narrows the bigint amount the same way readCatalogAmounts does", async () => {
    // Same boundary, same reason: `pg` hands `unit_amount_minor` back as a
    // string, and a row this function forgot to narrow would silently pass a
    // string through to a caller expecting a number.
    vi.mocked(tesserixQuery).mockResolvedValue([
      catalogRow({ unit_amount_minor: "1198800000" }),
    ] as never);

    const [row] = await readCatalogRows("live");
    expect(row.unitAmountMinor).toBe(1_198_800_000);
    expect(typeof row.unitAmountMinor).toBe("number");
  });

  it("reads the mode passed in, not a hardcoded one", async () => {
    vi.mocked(tesserixQuery).mockResolvedValue([]);
    await readCatalogRows("test");
    const [, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(params).toEqual(["test"]);
  });
});

describe("readLatestRuns", () => {
  it("returns both modes even when only one has ever run", async () => {
    // Same discipline as `readWindowStatus`: a query that only returned the
    // modes present in the table would omit live entirely the day live has
    // never run, and a caller iterating "every mode returned" would never
    // notice the gap.
    vi.mocked(tesserixQuery).mockResolvedValue([
      {
        mode: "test",
        outcome: "clean",
        ran_at: "2026-08-27T12:00:00.000Z",
        difference_count: 0,
        differences: [],
      },
    ] as never);

    const runs = await readLatestRuns();

    expect(runs.map((r) => r.mode)).toEqual(["test", "live"]);
    expect(runs.find((r) => r.mode === "test")?.run).toEqual({
      outcome: "clean",
      ranAt: "2026-08-27T12:00:00.000Z",
      differenceCount: 0,
      differences: [],
    });
    expect(runs.find((r) => r.mode === "live")?.run).toBeNull();
  });

  it("carries the stored differences through untouched, so a red day is interrogable", async () => {
    const differences = [
      {
        kind: "amount_mismatch",
        lookupKey: "mark8ly_pro_annual_ppp_vnd_v1",
        currency: "vnd",
        catalogUnitAmountMinor: 1978800000,
        stripeUnitAmountMinor: 19788000000,
        zeroDecimalSuspect: true,
      },
    ];
    vi.mocked(tesserixQuery).mockResolvedValue([
      {
        mode: "live",
        outcome: "differences",
        ran_at: "2026-08-27T03:00:00.000Z",
        difference_count: 1,
        differences,
      },
    ] as never);

    const runs = await readLatestRuns();
    expect(runs.find((r) => r.mode === "live")?.run?.differences).toEqual(differences);
  });
});
