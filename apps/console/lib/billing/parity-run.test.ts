import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/plan-catalog-repo", () => ({
  readCatalogAmounts: vi.fn(async () => []),
  recordParityRun: vi.fn(async () => {}),
}));
vi.mock("@/lib/billing/stripe-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/stripe-read")>()),
  stripePriceReader: { listPrices: vi.fn(async () => []) },
}));

import { stripePriceReader, StripeReadUnavailableError } from "@/lib/billing/stripe-read";
import { readCatalogAmounts } from "@/lib/db/plan-catalog-repo";
import type { CatalogAmount, StripePriceLike } from "@/lib/billing/parity";
import { MAX_ERROR_LENGTH, performParityCheck, sanitizeReason } from "./parity-run";

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
});

describe("performParityCheck", () => {
  it("reports clean when the two sides agree", async () => {
    expect(await performParityCheck("test")).toEqual({
      mode: "test",
      outcome: "clean",
      differences: [],
      error: null,
      publicationId: null,
    });
  });

  it("carries its own mode, on every outcome", async () => {
    // The run is handed straight to `recordParityRun`, and a row that named
    // the wrong account would make "both modes clean" satisfiable by one mode
    // answering twice.
    expect((await performParityCheck("live")).mode).toBe("live");

    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(new Error("stripe down"));
    const failed = await performParityCheck("live");
    expect(failed).toMatchObject({ mode: "live", outcome: "failed" });
  });

  it("reads the mode it was asked for, and no other", async () => {
    await performParityCheck("live");
    expect(stripePriceReader.listPrices).toHaveBeenCalledWith("live");
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

    const run = await performParityCheck("test");

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

    const run = await performParityCheck("test");

    expect(run.outcome).toBe("failed");
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
  });

  it("turns a missing credential into a failed run rather than a throw", async () => {
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(
      new StripeReadUnavailableError(
        "STRIPE_RESTRICTED_READ_KEY_LIVE is not set; the plan catalog parity check cannot read live mode Stripe Prices",
      ),
    );

    const run = await performParityCheck("live");

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

    const run = await performParityCheck("test");

    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("holds a live mode key");
  });

  it("turns an unreachable Stripe into a failed run", async () => {
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(
      new Error("connect ETIMEDOUT api.stripe.com:443"),
    );

    const run = await performParityCheck("test");

    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("ETIMEDOUT");
  });

  it("never throws, whatever was thrown at it", async () => {
    // The broad catch is the point. Anything that escapes here is a run that
    // records nothing, and a gap in the window is indistinguishable from a
    // clean day to whoever reads the table a week later.
    vi.mocked(readCatalogAmounts).mockRejectedValue("a bare string, not an Error");

    const run = await performParityCheck("test");

    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("a bare string");
  });
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

    expect(await performParityCheck("live")).toEqual({
      mode: "live",
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

    const run = await performParityCheck("live");

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

    expect((await performParityCheck("live")).outcome).toBe("not_bootstrapped");
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

    const run = await performParityCheck("live");

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
    expect((await performParityCheck("live")).outcome).not.toBe("clean");
  });

  it("is not_bootstrapped rather than failed — the check ran and answered", async () => {
    // An empty account is a FINDING, not an outage. Recording it as `failed`
    // would put it in the same bucket as an unreachable Stripe and make a
    // CronJob's alerting fire nightly for a state nobody intends to change
    // this month.
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([]);
    const run = await performParityCheck("live");
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
