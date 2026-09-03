import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/plan-catalog-repo", () => ({
  readCatalogAmounts: vi.fn(async () => []),
  readLivePublication: vi.fn(async () => null),
  recordParityRun: vi.fn(async () => {}),
}));
vi.mock("@/lib/billing/stripe-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/stripe-read")>()),
  stripePriceReader: { listPrices: vi.fn(async () => []) },
}));

import { stripePriceReader, StripeReadUnavailableError } from "@/lib/billing/stripe-read";
import { readCatalogAmounts, readLivePublication } from "@/lib/db/plan-catalog-repo";
import * as parityModule from "@/lib/billing/parity";
// The source axis every call below names explicitly. `performParityCheck` has
// no default for it (tesserix-home#392), so there is no shorter way to write
// these calls — which is the point: a run that does not name its catalog
// cannot be filed against one.
import { CATALOG_SOURCES, SINGLE_SOURCE } from "@/lib/billing/source-policy";
import type { CatalogAmount, StripePriceLike } from "@/lib/billing/parity";
import { MAX_ERROR_LENGTH, performParityCheck, sanitizeReason } from "./parity-run";

// A fixture id, not a real publication — `readLivePublication` is mocked, so
// nothing here has to be a valid uuid, only distinct enough to prove the id
// travels from the mock through to the returned `ParityRun` unchanged.
const KNOWN_TEST_PUBLICATION_ID = "11111111-1111-1111-1111-111111111111";

// A key-shaped fixture, assembled at runtime rather than written as a
// literal. `sanitizeReason` must be proved against a string that really
// matches STRIPE_KEY_PATTERN, but the CI secret scan runs `gitleaks git .` —
// it reads COMMITS, not the working tree — so a literal here is a permanent
// finding in this branch's history that no later edit can clear. Joining the
// parts keeps the assertion honest and the scan strict, with no allowlist and
// no baseline entry.
const LIVE_KEY_FIXTURE = ["rk", "live", "9aZbQ2mmSECRETvalue"].join("_");

/**
 * The comparison, minus the two things its callers disagree about.
 *
 * `performParityCheck` is the body BOTH runners share: the HTTP route
 * (`app/api/internal/parity-check/route.ts`) and the CronJob's script
 * (`scripts/parity-check.ts`). It deliberately stops one step short of
 * `recordParityRun`, because that write is exactly where the two part company
 * — the route turns a failed write into a 500, the script into a non-zero
 * exit — and there is nothing else left to disagree about once the outcome is
 * decided here.
 *
 * A second copy of this decision is the failure mode worth naming: if the
 * script decided `clean`/`differences`/`failed` for itself, the scheduled runs
 * and the operator-triggered ones would be writing rows to
 * `plan_catalog_parity_runs` under two definitions, and the 7-day window P2
 * revokes mark8ly's Stripe write key on would be a mixture of both.
 */

const KEY = "mark8ly_starter_monthly_ppp_vnd_v1";

const catalog: CatalogAmount[] = [
  { lookupKey: KEY, currency: "vnd", unitAmountMinor: 32_900_000, taxBehavior: "unspecified" },
];

// VND is zero-decimal in Stripe, so the live Price holds the catalog's
// 32,900,000 divided by 100 — `billing-bootstrap` converts at the boundary.
// These two rows agreeing is the real estate's steady state (verified against
// live data on 2026-08-27), so this is the fixture a `clean` outcome has to be
// proved against; the catalog's own number here would make `clean` unreachable.
const matching: StripePriceLike[] = [
  {
    id: "price_1",
    lookup_key: KEY,
    currency: "vnd",
    unit_amount: 329_000,
    tax_behavior: "unspecified",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readCatalogAmounts).mockResolvedValue(catalog);
  vi.mocked(stripePriceReader.listPrices).mockResolvedValue(matching);
  // `clearAllMocks` clears call history but NOT a mock's resolved value, so a
  // test that overrides this (via `mockResolvedValueOnce`, deliberately) does
  // not leak its publication into the next test. The suite-wide default is
  // "never published" — the same default `not_bootstrapped` describes.
  vi.mocked(readLivePublication).mockResolvedValue(null);
});

describe("performParityCheck", () => {
  it("reports clean when the two sides agree", async () => {
    expect(await performParityCheck("test", SINGLE_SOURCE)).toEqual({
      mode: "test",
      source: SINGLE_SOURCE,
      outcome: "clean",
      differences: [],
      error: null,
      publicationId: null,
    });
  });

  it("carries its own mode AND source, on every outcome", async () => {
    // The run is handed straight to `recordParityRun`, and a row that named
    // the wrong account would make #327's gate satisfiable by one mode
    // answering twice. Since tesserix-home#392 the same is true of the
    // source: a run filed under the wrong catalog lets one source answer for
    // another, which is the omission the column was added to close. Asserted
    // on `failed` as well as `clean`, because a `failed` row is a day of the
    // window too and has to name the pair it belongs to.
    const clean = await performParityCheck("live", SINGLE_SOURCE);
    expect(clean).toMatchObject({ mode: "live", source: SINGLE_SOURCE });

    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(new Error("stripe down"));
    const failed = await performParityCheck("live", SINGLE_SOURCE);
    expect(failed).toMatchObject({ mode: "live", source: SINGLE_SOURCE, outcome: "failed" });
  });

  it("reads the mode it was asked for, and no other", async () => {
    await performParityCheck("live", SINGLE_SOURCE);
    expect(stripePriceReader.listPrices).toHaveBeenCalledWith("live");
  });

  it("records which publication the run was clean against", async () => {
    // A `clean` row is evidence in a 7-day window that gates a key
    // revocation. Without this, a row from three days ago cannot say WHICH
    // catalog it agreed with, and republishing invalidates it silently.
    vi.mocked(readLivePublication).mockResolvedValueOnce({
      id: KNOWN_TEST_PUBLICATION_ID,
      revisionId: "22222222-2222-2222-2222-222222222222",
      // Widened by task 2R (`readLivePublication` now carries who published
      // and when) — irrelevant to this test's assertion, present only to
      // satisfy the type.
      publishedBy: "operator@tesserix",
      publishedAt: "2026-08-01T00:00:00.000Z",
    });

    const run = await performParityCheck("test", SINGLE_SOURCE);

    expect(run.outcome).toBe("clean");
    expect(run.publicationId).toBe(KNOWN_TEST_PUBLICATION_ID);
    // Mirrors "reads the mode it was asked for, and no other" above: asserting
    // only the resulting `publicationId` would still pass if a refactor read
    // the WRONG mode's publication and happened to get the same id back from
    // the mock. This pins down which mode `readLivePublication` was actually
    // called with.
    expect(readLivePublication).toHaveBeenCalledWith("test");
  });

  it("records a null publication when the mode has never been published", async () => {
    // `readLivePublication` defaults to `null` in this suite's mock — the
    // normal state for a mode nobody has published yet (see the
    // `not_bootstrapped` block below for why an empty Stripe namespace is a
    // finding, not a failure).
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([]);

    const run = await performParityCheck("live", SINGLE_SOURCE);

    expect(run.outcome).toBe("not_bootstrapped");
    expect(run.publicationId).toBeNull();
  });

  it("reports differences, carrying the full report", async () => {
    // The live Price holds the catalog's x100 number un-converted, which is a
    // real finding: a Price written without dividing at the Stripe boundary
    // charges VND customers a hundred times d329,000. The whole difference
    // object is asserted because it is what lands in the `differences` jsonb —
    // an outcome of `differences` with a report an operator cannot act on is
    // the same dead end as no run at all.
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([
      { ...matching[0], unit_amount: 32_900_000 },
    ]);

    const run = await performParityCheck("test", SINGLE_SOURCE);

    expect(run.outcome).toBe("differences");
    expect(run.error).toBeNull();
    expect(run.differences).toEqual([
      {
        kind: "amount_mismatch",
        lookupKey: KEY,
        currency: "vnd",
        catalogUnitAmountMinor: 32_900_000,
        stripeUnitAmountMinor: 32_900_000,
        zeroDecimalSuspect: true,
      },
    ]);
  });

  it("reads the catalog before spending a Stripe request", async () => {
    // Sequential on purpose: a catalog read that fails should not also cost a
    // Stripe call, and the ordering is what makes "which side broke" legible
    // in the stored reason.
    vi.mocked(readCatalogAmounts).mockRejectedValue(new Error("relation does not exist"));

    const run = await performParityCheck("test", SINGLE_SOURCE);

    expect(run.outcome).toBe("failed");
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
  });

  it("turns a missing credential into a failed run rather than a throw", async () => {
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(
      new StripeReadUnavailableError(
        "STRIPE_RESTRICTED_READ_KEY_LIVE is not set; the plan catalog parity check cannot read live mode Stripe Prices",
      ),
    );

    const run = await performParityCheck("live", SINGLE_SOURCE);

    expect(run.outcome).toBe("failed");
    expect(run.differences).toEqual([]);
    expect(run.error).toContain("STRIPE_RESTRICTED_READ_KEY_LIVE");
  });

  it("turns a key whose prefix contradicts its slot into a failed run", async () => {
    // Reported as `failed` rather than compared anyway. Comparing the test
    // catalog against the live account is a WRONG ANSWER DELIVERED
    // CONFIDENTLY — strictly worse than no answer, because nothing in the
    // report reveals it. That mix-up cost an hour on 2026-08-27.
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(
      new StripeReadUnavailableError(
        "STRIPE_RESTRICTED_READ_KEY_TEST holds a live mode key but is read as the test mode credential",
      ),
    );

    const run = await performParityCheck("test", SINGLE_SOURCE);

    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("holds a live mode key");
  });

  it("turns an unreachable Stripe into a failed run", async () => {
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(
      new Error("connect ETIMEDOUT api.stripe.com:443"),
    );

    const run = await performParityCheck("test", SINGLE_SOURCE);

    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("ETIMEDOUT");
  });

  it("never throws, whatever was thrown at it", async () => {
    // The broad catch is the point. Anything that escapes here is a run that
    // records nothing, and a gap in the window is indistinguishable from a
    // clean day to whoever reads the table a week later.
    vi.mocked(readCatalogAmounts).mockRejectedValue("a bare string, not an Error");

    const run = await performParityCheck("test", SINGLE_SOURCE);

    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("a bare string");
  });

  it(
    "reads and compares mark8ly's own source, not a hardcoded call missing the axis — tesserix-home#381",
    async () => {
      // `readCatalogAmounts(mode)` and `compareCatalogToStripe(catalog,
      // prices)` — the shape this call site had before #381 — both compile
      // and both run: a missing `source` filter doesn't throw, it silently
      // reads/compares every source at once. So this asserts the ARGUMENTS
      // that actually arrive, not just that the outcome comes out `clean`
      // for the one source that exists today (a wrong call that happens to
      // agree with itself would still pass an outcome-only assertion).
      await performParityCheck("test", SINGLE_SOURCE);

      expect(readCatalogAmounts).toHaveBeenCalledWith("test", "mark8ly");
    },
  );

  it(
    "reads the catalog for the source it was ASKED for, not one of its own choosing — tesserix-home#392",
    async () => {
      // The companion to "reads the mode it was asked for, and no other".
      // Before #392 this function reached for `SINGLE_SOURCE` itself, so
      // every call read mark8ly's catalog whatever the caller meant — and
      // with one source in existence the outcome was identical either way,
      // which is precisely why an outcome assertion cannot catch it. This
      // pins the argument that actually arrives at the read.
      //
      // `CATALOG_SOURCES` holds one entry today, so the value asserted is
      // still `mark8ly`; what is asserted is that it came from the PARAMETER.
      // A second source added to `CATALOG_SOURCES` without threading it
      // through would fail here rather than silently read mark8ly's rows.
      for (const source of CATALOG_SOURCES) {
        vi.mocked(readCatalogAmounts).mockClear();
        await performParityCheck("live", source);
        expect(readCatalogAmounts).toHaveBeenCalledWith("live", source);
      }
    },
  );

  it(
    "passes the source's own policy and lookup-key prefix into the comparator, not its defaults — tesserix-home#381",
    async () => {
      // `compareCatalogToStripe`'s `namespacePrefix` and `policy` parameters
      // default to mark8ly's own values (see `parity.ts`), which is exactly
      // what let this call site compile while forgetting to pass them at
      // all. A spy on the REAL function catches that: calling it with only
      // `(catalog, prices)` records a 2-argument call, and this asserts a
      // 4-argument one naming mark8ly's policy and prefix explicitly.
      const spy = vi.spyOn(parityModule, "compareCatalogToStripe");
      try {
        await performParityCheck("test", SINGLE_SOURCE);

        expect(spy).toHaveBeenCalledWith(
          catalog,
          matching,
          "mark8ly_",
          { amountsAreScaledBy100: true, lookupKeyPrefix: "mark8ly_" },
        );
      } finally {
        spy.mockRestore();
      }
    },
  );
});

describe("a mode that has never been bootstrapped", () => {
  /**
   * The state that must not be collapsed.
   *
   * Live Stripe as of 2026-08-27 holds ZERO `mark8ly_*` prices — zero
   * products, zero subscriptions. Comparing a 42-key catalog against it
   * produces 42 `price_missing_in_stripe` findings, and reporting those
   * nightly for a mode nobody has launched is noise that trains people to
   * ignore the report. The report is the only evidence the window is made of.
   *
   * `not_bootstrapped` says "nothing here yet". `differences` says "something
   * here is wrong". They are different facts and must look different.
   */

  it("is not_bootstrapped when the namespace holds exactly zero prices", async () => {
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([]);

    expect(await performParityCheck("live", SINGLE_SOURCE)).toEqual({
      mode: "live",
      source: SINGLE_SOURCE,
      outcome: "not_bootstrapped",
      differences: [],
      error: null,
      publicationId: null,
    });
  });

  it("discards the comparator's report rather than storing it", async () => {
    // The comparator DOES produce 42 findings here and they are deliberately
    // thrown away: 0034 refuses a `not_bootstrapped` row with a non-zero
    // count, because a row claiming both "nothing here yet" and "42 findings"
    // is incoherent and unreadable a week later.
    vi.mocked(readCatalogAmounts).mockResolvedValue([
      catalog[0],
      { lookupKey: "mark8ly_pro_annual_v1", currency: "usd", unitAmountMinor: 9900, taxBehavior: "unspecified" },
    ]);
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([]);

    const run = await performParityCheck("live", SINGLE_SOURCE);

    expect(run.outcome).toBe("not_bootstrapped");
    expect(run.differences).toEqual([]);
  });

  it("counts only OUR namespace, not the shared account's other prices", async () => {
    // The account is shared. A live account full of somebody else's Prices and
    // none of ours has still never been bootstrapped, and a raw length check
    // on the Stripe response would call that `differences` instead.
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([
      { id: "price_x", lookup_key: "someone_elses_thing", currency: "usd",
        unit_amount: 100, tax_behavior: "unspecified" },
      { id: "price_y", lookup_key: null, currency: "usd",
        unit_amount: 100, tax_behavior: "unspecified" },
    ]);

    expect((await performParityCheck("live", SINGLE_SOURCE)).outcome).toBe("not_bootstrapped");
  });

  it("is NOT not_bootstrapped for a partial bootstrap", async () => {
    // ONLY ZERO COUNTS. Someone ran the tool and it half-worked — far more
    // dangerous than not having run it at all, and the one case that must
    // never hide behind "nothing here yet".
    vi.mocked(readCatalogAmounts).mockResolvedValue([
      catalog[0],
      { lookupKey: "mark8ly_pro_annual_v1", currency: "usd", unitAmountMinor: 9900, taxBehavior: "unspecified" },
    ]);
    // One of the two keys exists in Stripe. The other does not.
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue(matching);

    const run = await performParityCheck("live", SINGLE_SOURCE);

    expect(run.outcome).toBe("differences");
    expect(run.outcome).not.toBe("not_bootstrapped");
    expect(run.differences).toEqual([
      expect.objectContaining({
        kind: "price_missing_in_stripe",
        lookupKey: "mark8ly_pro_annual_v1",
      }),
    ]);
  });

  it("is not clean, which is what parks #327 behind a live bootstrap", async () => {
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([]);
    expect((await performParityCheck("live", SINGLE_SOURCE)).outcome).not.toBe("clean");
  });

  it("is not_bootstrapped rather than failed — the check ran and answered", async () => {
    // An empty account is a FINDING, not an outage. Recording it as `failed`
    // would put it in the same bucket as an unreachable Stripe and make a
    // CronJob's alerting fire nightly for a state nobody intends to change
    // this month.
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([]);
    const run = await performParityCheck("live", SINGLE_SOURCE);
    expect(run.outcome).not.toBe("failed");
    expect(run.error).toBeNull();
  });
});

describe("sanitizeReason", () => {
  it("names the error and its message", () => {
    expect(sanitizeReason(new TypeError("boom"))).toBe("TypeError: boom");
  });

  it("redacts anything shaped like a Stripe key", () => {
    // Stripe echoes request context into some error messages, and the `error`
    // column is read by an operator and lives as long as the row does.
    const reason = sanitizeReason(new Error(`Invalid API Key provided: ${LIVE_KEY_FIXTURE}`));
    expect(reason).not.toContain("SECRET");
    expect(reason).toContain("[redacted]");
  });

  it("redacts live, test and restricted prefixes alike", () => {
    for (const key of ["sk_live_abc123", "pk_test_abc123", "rk_test_abc123"]) {
      expect(sanitizeReason(new Error(`leaked ${key} here`))).not.toContain("abc123");
    }
  });

  it("bounds the reason so one pathological message cannot dominate the table", () => {
    const reason = sanitizeReason(new Error("x".repeat(5000)));
    expect(reason.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
    expect(reason.endsWith("…")).toBe(true);
  });

  it("describes a thrown non-Error rather than losing it", () => {
    expect(sanitizeReason({ nope: true })).toContain("Unknown error");
  });
});
