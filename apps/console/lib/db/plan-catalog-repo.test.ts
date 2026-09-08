import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tesserix", () => ({
  tesserixQuery: vi.fn(async () => []),
}));

// Iterated rather than written out as ["test/mark8ly", ...]: the assertions
// below are about the reads covering the WHOLE cross product, so hardcoding
// today's one-source list would make them pass unchanged the day a second
// source is added and not covered — the tesserix-home#392 failure, in the test
// meant to prevent it.
import { CATALOG_SOURCES } from "@/lib/billing/source-policy";
import { STRIPE_MODES } from "@/lib/billing/stripe-read";
import { tesserixQuery } from "./tesserix";
import {
  readCatalogAmounts,
  readCatalogRows,
  readLastCleanEntitlementRun,
  readLastCleanRuns,
  readLatestRuns,
  readWindowStatus,
  recordEntitlementParityRun,
  recordParityRun,
} from "./plan-catalog-repo";

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

    const amounts = await readCatalogAmounts("test", "mark8ly");

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

    const [amount] = await readCatalogAmounts("test", "mark8ly");
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

    await expect(readCatalogAmounts("test", "mark8ly")).rejects.toThrow(
      /mark8ly_starter_monthly_ppp_idr_v1\/idr/,
    );
  });

  it("reads the mode and source passed in, not a hardcoded one — tesserix-home#381", async () => {
    // `source` used to have no parameter at all: this pins down that it is
    // now threaded through to the query as a second bind param, alongside
    // `mode`, rather than silently dropped. The behavioural half of #381's
    // fix — that a second source's rows don't leak in — is proved against a
    // real database in `plan-catalog-revisions.integration.test.ts`.
    vi.mocked(tesserixQuery).mockResolvedValue([]);
    await readCatalogAmounts("test", "mark8ly");
    const [, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(params).toEqual(["test", "mark8ly"]);
  });
});

describe("recordParityRun", () => {
  it("writes the mode AND the source, so a row can be read a week later", async () => {
    // Without the mode the row is unreadable the moment there are two
    // accounts: `clean` means nothing if you cannot tell which account it was
    // clean against. Without the source it is unreadable the moment there are
    // two catalogs, for the identical reason one axis over — 0044, and
    // tesserix-home#392. #327's gate is "every (mode, source) pair clean", and
    // a row that names only one of the two cannot count towards it.
    await recordParityRun({
      mode: "live",
      source: "mark8ly",
      outcome: "clean",
      differences: [],
      error: null,
      publicationId: null,
    });

    const [sql, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(String(sql)).toContain("mode");
    // Asserted on the SQL as well as the params, because 0045 drops the
    // column's database default: an INSERT that omitted `source` compiled and
    // ran against the 0044 schema and would start failing outright once 0045
    // is applied — in the nightly CronJob, at 02:15 UTC, as a day-shaped hole.
    expect(String(sql)).toContain("source");
    expect(params).toEqual(["live", "mark8ly", "clean", 0, "[]", null, null]);
  });

  it("writes the publication a clean run was checked against", async () => {
    // A `clean` row is evidence in #327's 7-day window. Without the
    // publication travelling into the row, a row from three days ago cannot
    // say WHICH catalog it agreed with, and republishing invalidates it
    // silently while the row still reads `clean`.
    const publicationId = "33333333-3333-3333-3333-333333333333";

    await recordParityRun({
      mode: "live",
      source: "mark8ly",
      outcome: "clean",
      differences: [],
      error: null,
      publicationId,
    });

    const [sql, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(String(sql)).toContain("publication_id");
    expect(params).toEqual(["live", "mark8ly", "clean", 0, "[]", null, publicationId]);
  });

  it("derives difference_count from the report rather than trusting a caller", async () => {
    const differences = [
      { kind: "amount_mismatch" as const, lookupKey: "k", currency: "vnd",
        catalogUnitAmountMinor: 1, stripeUnitAmountMinor: 2, zeroDecimalSuspect: false },
    ];

    await recordParityRun({
      mode: "test",
      source: "mark8ly",
      outcome: "differences",
      differences,
      error: null,
      publicationId: null,
    });

    const [, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(params).toEqual([
      "test",
      "mark8ly",
      "differences",
      1,
      JSON.stringify(differences),
      null,
      null,
    ]);
  });

  it("writes an empty array and a null reason for a clean run", async () => {
    await recordParityRun({
      mode: "test",
      source: "mark8ly",
      outcome: "clean",
      differences: [],
      error: null,
      publicationId: null,
    });
    const [, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(params).toEqual(["test", "mark8ly", "clean", 0, "[]", null, null]);
  });

  it("writes no differences for a not_bootstrapped run", async () => {
    // 0034 refuses a `not_bootstrapped` row with a non-zero count. The state
    // means "nothing here yet", and a report attached to it would be the
    // incoherence the constraint exists to make unstorable.
    await recordParityRun({
      mode: "live",
      source: "mark8ly",
      outcome: "not_bootstrapped",
      differences: [],
      error: null,
      publicationId: null,
    });
    const [, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(params).toEqual(["live", "mark8ly", "not_bootstrapped", 0, "[]", null, null]);
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

    const rows = await readCatalogRows("live", "mark8ly");

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

    const [row] = await readCatalogRows("live", "mark8ly");
    expect(row.unitAmountMinor).toBe(1_198_800_000);
    expect(typeof row.unitAmountMinor).toBe("number");
  });

  it("reads the mode and source passed in, not a hardcoded one", async () => {
    vi.mocked(tesserixQuery).mockResolvedValue([]);
    await readCatalogRows("test", "mark8ly");
    const [, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(params).toEqual(["test", "mark8ly"]);
  });
});

describe("readLatestRuns", () => {
  it("returns every (mode, source) pair even when only one has ever run", async () => {
    // Same discipline as `readWindowStatus`: a query that only returned the
    // pairs present in the table would omit live entirely the day live has
    // never run, and a caller iterating "every pair returned" would never
    // notice the gap. Since tesserix-home#392 that discipline covers the
    // source axis too — an unchecked catalog must be reported as never having
    // run, not left out of the answer.
    vi.mocked(tesserixQuery).mockResolvedValue([
      {
        mode: "test",
        source: "mark8ly",
        outcome: "clean",
        ran_at: "2026-08-27T12:00:00.000Z",
        difference_count: 0,
        differences: [],
      },
    ] as never);

    const runs = await readLatestRuns();

    expect(runs.map((r) => `${r.mode}/${r.source}`)).toEqual(
      STRIPE_MODES.flatMap((mode) => CATALOG_SOURCES.map((source) => `${mode}/${source}`)),
    );
    expect(runs.find((r) => r.mode === "test" && r.source === "mark8ly")?.run).toEqual({
      outcome: "clean",
      ranAt: "2026-08-27T12:00:00.000Z",
      differenceCount: 0,
      differences: [],
    });
    expect(runs.find((r) => r.mode === "live" && r.source === "mark8ly")?.run).toBeNull();
  });

  it("keys the top-1-per-group on BOTH axes — tesserix-home#392", async () => {
    // The query is `DISTINCT ON (mode, source) ... ORDER BY mode, source,
    // ran_at DESC`. Keyed on `mode` alone it returns whichever source ran
    // last for that mode, and the console then shows one catalog's verdict
    // under a card that claims to speak for the mode. Asserted on the SQL
    // because with one source in `CATALOG_SOURCES` the two queries return
    // identical rows, so no fixture can tell them apart.
    vi.mocked(tesserixQuery).mockResolvedValue([] as never);
    await readLatestRuns();
    const [sql] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(String(sql)).toContain("DISTINCT ON (mode, source)");
    expect(String(sql)).toContain("ORDER BY mode, source, ran_at DESC");
  });

  it("reports a pair that has never run rather than omitting it — tesserix-home#392", async () => {
    // The whole shape of the omission this issue closes: a source nothing has
    // ever written a row for must come back as `run: null`, an ANSWER, and
    // never be absent from the list. Absent, a caller reducing over the
    // result finds every pair it can see agreeing and calls the gate
    // satisfied.
    vi.mocked(tesserixQuery).mockResolvedValue([] as never);

    const runs = await readLatestRuns();

    expect(runs).toHaveLength(STRIPE_MODES.length * CATALOG_SOURCES.length);
    expect(runs.every((r) => r.run === null)).toBe(true);
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
        source: "mark8ly",
        outcome: "differences",
        ran_at: "2026-08-27T03:00:00.000Z",
        difference_count: 1,
        differences,
      },
    ] as never);

    const runs = await readLatestRuns();
    expect(
      runs.find((r) => r.mode === "live" && r.source === "mark8ly")?.run?.differences,
    ).toEqual(differences);
  });
});

describe("readLastCleanRuns", () => {
  it("returns every (mode, source) pair, with null for one that has never run clean", async () => {
    // Same "every pair, always" discipline as `readLatestRuns`. The metrics
    // endpoint turns `null` into an epoch timestamp so a staleness alert
    // fires; a pair OMITTED here would instead vanish from the exposition,
    // which reads as a scrape failure rather than as a pair nothing has ever
    // checked.
    vi.mocked(tesserixQuery).mockResolvedValue([
      { mode: "test", source: "mark8ly", ran_at: "2026-09-06T02:15:00.000Z" },
    ] as never);

    const runs = await readLastCleanRuns();

    expect(runs.map((r) => `${r.mode}/${r.source}`)).toEqual(
      STRIPE_MODES.flatMap((mode) => CATALOG_SOURCES.map((source) => `${mode}/${source}`)),
    );
    expect(runs.find((r) => r.mode === "test" && r.source === "mark8ly")?.ranAt).toBe(
      "2026-09-06T02:15:00.000Z",
    );
    expect(runs.find((r) => r.mode === "live" && r.source === "mark8ly")?.ranAt).toBeNull();
  });

  it("asks only for clean runs, keyed on both axes", async () => {
    // Asserted on the SQL, for the same reason `readLatestRuns`'s twin
    // assertion is: with one source in `CATALOG_SOURCES` no fixture can tell
    // a mode-keyed query from a pair-keyed one, and a query that forgot the
    // `clean` filter would report the last run of ANY outcome as the last
    // clean one — the staleness alert would then never fire while the check
    // failed nightly.
    vi.mocked(tesserixQuery).mockResolvedValue([] as never);

    await readLastCleanRuns();

    const [sql] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(String(sql)).toContain("DISTINCT ON (mode, source)");
    expect(String(sql)).toContain("outcome = 'clean'");
    expect(String(sql)).toContain("ORDER BY mode, source, ran_at DESC");
  });

  it("normalises whatever the driver hands back to ISO 8601 UTC", async () => {
    vi.mocked(tesserixQuery).mockResolvedValue([
      { mode: "test", source: "mark8ly", ran_at: new Date("2026-09-06T02:15:00.000Z") },
    ] as never);

    const runs = await readLastCleanRuns();

    expect(runs.find((r) => r.mode === "test")?.ranAt).toBe("2026-09-06T02:15:00.000Z");
  });
});

describe("readLastCleanEntitlementRun", () => {
  it("returns when the source last agreed with the product's gate", async () => {
    vi.mocked(tesserixQuery).mockResolvedValue([
      { ran_at: "2026-09-09T02:15:00.000Z" },
    ] as never);

    expect(await readLastCleanEntitlementRun("mark8ly")).toBe("2026-09-09T02:15:00.000Z");
  });

  it("answers null for a source that has never run clean, rather than throwing", async () => {
    // The metrics endpoint turns this into the epoch, which is a staleness
    // alert firing. Throwing would instead fail the whole scrape and take the
    // PRICE series down with it — a source nothing has checked must cost its
    // own series and nothing else.
    vi.mocked(tesserixQuery).mockResolvedValue([] as never);

    expect(await readLastCleanEntitlementRun("mark8ly")).toBeNull();
  });

  it("asks for entitlement runs only, and only clean ones", async () => {
    // Asserted on the SQL for the reason its price sibling's twin assertion
    // is: with one source in `CATALOG_SOURCES`, no set of rows a mock returns
    // can tell a filtered query from an unfiltered one. Dropping `clean` would
    // report the last run of ANY outcome as the last clean one, so the
    // staleness gauge would stay fresh while the check failed nightly —
    // exactly the failure `readLastCleanRuns` exists to prevent on the price
    // axis.
    vi.mocked(tesserixQuery).mockResolvedValue([] as never);

    await readLastCleanEntitlementRun("mark8ly");

    const [sql, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(String(sql)).toContain("check_kind = 'entitlement'");
    expect(String(sql)).toContain("outcome = 'clean'");
    expect(String(sql)).toContain("ORDER BY ran_at DESC");
    expect(params).toEqual(["mark8ly"]);
  });

  it("does not key on mode, because the mode is the product's and it moves", async () => {
    // `CONSOLE_CATALOG_MODE` moves at mark8ly's live-key swap (mark8ly#371).
    // A read narrowed by mode would answer "never clean" from the moment of
    // the swap, for a source that had been clean nightly.
    vi.mocked(tesserixQuery).mockResolvedValue([] as never);

    await readLastCleanEntitlementRun("mark8ly");

    expect(String(vi.mocked(tesserixQuery).mock.calls[0][0])).not.toContain("mode =");
  });

  it("normalises whatever the driver hands back to ISO 8601 UTC", async () => {
    vi.mocked(tesserixQuery).mockResolvedValue([
      { ran_at: new Date("2026-09-09T02:15:00.000Z") },
    ] as never);

    expect(await readLastCleanEntitlementRun("mark8ly")).toBe("2026-09-09T02:15:00.000Z");
  });
});

/**
 * 0053's discriminator, asserted on the SQL of all five statements that touch
 * `plan_catalog_parity_runs`.
 *
 * It has to be the SQL rather than a fixture: `CATALOG_SOURCES` holds one
 * source and both kinds of run carry the same (mode, source), so no set of
 * rows a mock returns can tell a filtered query from an unfiltered one. What
 * makes the filter load-bearing is what it EXCLUDES, and the exclusion is
 * exercised for real against pglite in `parity-window.integration.test.ts`.
 */
describe("check_kind — the two kinds of evidence in one table", () => {
  const sqlOfFirstCall = () => String(vi.mocked(tesserixQuery).mock.calls[0][0]);

  it("writes a price run as a price run, by literal and not by column default", async () => {
    // 0053 keeps the column default so the previously-deployed image's insert
    // still lands during a rollout. This writer must not rely on it: a default
    // is what a writer that forgot falls into, and the value of the column is
    // that the two kinds cannot be mistaken for each other.
    await recordParityRun({
      mode: "test",
      source: "mark8ly",
      outcome: "not_bootstrapped",
      differences: [],
      error: null,
      publicationId: null,
    });

    expect(sqlOfFirstCall()).toContain("check_kind");
    expect(sqlOfFirstCall()).toContain("'price'");
  });

  it("writes an entitlement run as an entitlement run, and derives its count", async () => {
    await recordEntitlementParityRun({
      mode: "live",
      source: "mark8ly",
      outcome: "differences",
      differences: [
        { plan: "pro", feature: "sso", consoleValue: null, productValue: 1 },
        { plan: "pro", feature: "stores", consoleValue: 3, productValue: -1 },
      ],
      error: null,
      publicationId: "44444444-4444-4444-4444-444444444444",
    });

    const [sql, params] = vi.mocked(tesserixQuery).mock.calls[0];
    expect(String(sql)).toContain("'entitlement'");
    // The count is derived here and never taken from a caller, so 0033's
    // "count matches the report" CHECK cannot be reached by a caller that
    // counted for itself.
    expect(params?.[3]).toBe(2);
  });

  it("asks readLatestRuns for price runs only", async () => {
    // `summarizeDifferences` (`catalog-views.tsx`) labels a finding by its
    // `kind`; an entitlement finding has none, so this row would render on the
    // price card as a report with no labels.
    vi.mocked(tesserixQuery).mockResolvedValue([] as never);
    await readLatestRuns();
    expect(sqlOfFirstCall()).toContain("check_kind = 'price'");
  });

  it("asks readLastCleanRuns for price runs only", async () => {
    // This read backs `..._parity_last_clean_timestamp_seconds`, whose whole
    // job is to alert when the PRICE check goes silent. A nightly entitlement
    // run would keep the timestamp fresh with the price check dead.
    vi.mocked(tesserixQuery).mockResolvedValue([] as never);
    await readLastCleanRuns();
    expect(sqlOfFirstCall()).toContain("check_kind = 'price'");
  });

  it("asks readWindowStatus for price runs only, in every subquery", async () => {
    // Three correlated subqueries — clean, not-clean, and ran. A filter added
    // to two of the three would still let an entitlement run decide a day.
    vi.mocked(tesserixQuery).mockResolvedValue([] as never);
    await readWindowStatus(7);
    expect(sqlOfFirstCall().match(/check_kind = 'price'/g)).toHaveLength(3);
  });
});
