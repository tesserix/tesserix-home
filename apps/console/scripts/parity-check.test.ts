import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/tesserix", () => ({
  isDatabaseConfigured: vi.fn(() => true),
  tesserixQuery: vi.fn(),
  closeTesserixPool: vi.fn(async () => {}),
}));
vi.mock("@/lib/db/plan-catalog-repo", () => ({
  readCatalogAmounts: vi.fn(async () => []),
  readLivePublication: vi.fn(async () => null),
  recordParityRun: vi.fn(async () => {}),
}));
vi.mock("@/lib/billing/stripe-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/stripe-read")>()),
  stripePriceReader: { listPrices: vi.fn(async () => []) },
}));
// Spied, not replaced. The guard test below asserts the script REACHES this
// function rather than carrying a comparator of its own, and it can only do
// that if the real implementation is still what runs — a stub would make every
// other test in this file assert against a fiction.
vi.mock("@/lib/billing/parity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/parity")>();
  return { ...actual, compareCatalogToStripe: vi.fn(actual.compareCatalogToStripe) };
});

import { compareCatalogToStripe } from "@/lib/billing/parity";
import { CATALOG_SOURCES, SINGLE_SOURCE } from "@/lib/billing/source-policy";
import {
  STRIPE_MODES,
  stripePriceReader,
  StripeReadUnavailableError,
  type StripeMode,
} from "@/lib/billing/stripe-read";
import { closeTesserixPool, isDatabaseConfigured } from "@/lib/db/tesserix";
import { readCatalogAmounts, recordParityRun } from "@/lib/db/plan-catalog-repo";
import type { CatalogAmount, StripePriceLike } from "@/lib/billing/parity";
import {
  EXIT_CHECK_FAILED,
  EXIT_OK,
  EXIT_UNRECORDABLE,
  runParityCheckJob,
} from "./parity-check";

// A key-shaped fixture, assembled at runtime rather than written as a
// literal. `sanitizeReason` must be proved against a string that really
// matches STRIPE_KEY_PATTERN, but the CI secret scan runs `gitleaks git .` —
// it reads COMMITS, not the working tree — so a literal here is a permanent
// finding in this branch's history that no later edit can clear. Joining the
// parts keeps the assertion honest and the scan strict, with no allowlist and
// no baseline entry.
const LIVE_KEY_FIXTURE = ["rk", "live", "9aZbQ2mmSECRETvalue"].join("_");

/**
 * The scheduled runner, which now runs BOTH modes.
 *
 * Three properties this suite exists for, all of them about what a human reads
 * a week later:
 *
 *  1. EXACTLY ONE ROW PER MODE — never zero, never two. A run that dies
 *     silently leaves a day-shaped hole in #326's window, and a hole is
 *     indistinguishable from a clean day. P2 revokes mark8ly's Stripe write
 *     key on that window.
 *  2. THE MODES ARE INDEPENDENT. A failure in one must not cost the other its
 *     row. Live has no restricted key provisioned yet; if that took test's
 *     row down with it, one missing secret would forfeit every clean day test
 *     has accumulated.
 *  3. `differences` AND `not_bootstrapped` EXIT 0. Both are the check's
 *     output, not a crash. A non-zero exit makes Kubernetes retry the job, and
 *     the retry writes a SECOND row for the same finding — so a single day
 *     would be counted twice in the window.
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

/** The catalog's x100 number stored in Stripe un-converted — a Price written
 *  without dividing at the boundary, charging VND customers a hundred times
 *  d329,000. */
const drifted: StripePriceLike[] = [{ ...matching[0], unit_amount: 32_900_000 }];

/** Answer `listPrices` differently per mode, which is the only way to test
 *  that the two are actually independent. */
function pricesPerMode(per: Partial<Record<StripeMode, StripePriceLike[]>>) {
  vi.mocked(stripePriceReader.listPrices).mockImplementation(async (mode) => {
    const prices = per[mode];
    if (prices === undefined) throw new Error(`no fixture for ${mode}`);
    return prices;
  });
}

/** Fail `listPrices` for one mode only, leaving the other working. */
function failMode(failing: StripeMode, cause: Error) {
  vi.mocked(stripePriceReader.listPrices).mockImplementation(async (mode) => {
    if (mode === failing) throw cause;
    return matching;
  });
}

/** Every structured line the job emitted, parsed back. */
function loggedLines(): Record<string, unknown>[] {
  const calls = [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ];
  return calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

/** The run recorded for one mode, or undefined if none was. */
/** How many rows one invocation must write, and how many log lines it must
 *  emit. Derived from the two constants, never the literal 2: tesserix-home#392
 *  is exactly the case where a runner covering only the modes still looks
 *  correct, and a hardcoded count would keep agreeing with it. */
const PAIR_COUNT = STRIPE_MODES.length * CATALOG_SOURCES.length;

/** Every pair, in the order the job walks them — mode-major. */
const PAIR_KEYS = STRIPE_MODES.flatMap((mode) =>
  CATALOG_SOURCES.map((source) => `${mode}/${source}`),
);

const recordedFor = (mode: StripeMode) =>
  vi.mocked(recordParityRun).mock.calls.map((c) => c[0]).find((run) => run.mode === mode);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(readCatalogAmounts).mockResolvedValue(catalog);
  vi.mocked(recordParityRun).mockResolvedValue(undefined);
  vi.mocked(stripePriceReader.listPrices).mockResolvedValue(matching);
  vi.mocked(closeTesserixPool).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("one run covers every (mode, source) pair", () => {
  it("writes exactly one row per pair and exits 0", async () => {
    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_OK);
    expect(recordParityRun).toHaveBeenCalledTimes(PAIR_COUNT);
    expect(vi.mocked(recordParityRun).mock.calls.map((c) => `${c[0].mode}/${c[0].source}`)).toEqual(
      PAIR_KEYS,
    );
  });

  it("covers the whole cross product, not just the modes — tesserix-home#392", async () => {
    // A job that still looped over modes alone would write one row per mode
    // and leave a second source's catalog compared against nothing — while
    // the rows it DID write still came back clean, so nothing looks wrong.
    // Asserted as the SET of pairs, derived from the constants.
    await runParityCheckJob();

    expect(vi.mocked(recordParityRun).mock.calls.map((c) => c[0].source)).toEqual(
      STRIPE_MODES.flatMap(() => [...CATALOG_SOURCES]),
    );
  });

  it("reads each mode's Stripe account separately", async () => {
    await runParityCheckJob();

    expect(stripePriceReader.listPrices).toHaveBeenCalledTimes(PAIR_COUNT);
    expect(stripePriceReader.listPrices).toHaveBeenCalledWith("test");
    expect(stripePriceReader.listPrices).toHaveBeenCalledWith("live");
  });

  it("logs one structured line per pair, each naming its mode AND source", async () => {
    // The CronJob's stdout is the cluster's log sink and, for most of the
    // week, the only thing anyone actually reads. A line that did not name its
    // mode would be unattributable the moment there are two accounts; a line
    // that names only the mode is unattributable the moment there are two
    // catalogs, which is the same defect one axis over (tesserix-home#392).
    await runParityCheckJob();

    const lines = loggedLines();
    expect(lines).toHaveLength(PAIR_COUNT);
    expect(lines.map((l) => `${l.mode}/${l.source}`)).toEqual(PAIR_KEYS);
    for (const line of lines) {
      expect(line).toMatchObject({ outcome: "clean", differenceCount: 0 });
    }
  });
});

describe("the pairs are independent", () => {
  it("still writes the other pairs' rows when one pair fails", async () => {
    // The property the whole split turns on. Live has no restricted
    // key provisioned yet; if that cost test its row, one absent secret would
    // put a hole in every day of the window rather than in live's half of it.
    failMode("live", new Error("connect ETIMEDOUT api.stripe.com:443"));

    await runParityCheckJob();

    expect(recordParityRun).toHaveBeenCalledTimes(PAIR_COUNT);
    expect(recordedFor("test")).toMatchObject({ outcome: "clean" });
    expect(recordedFor("live")).toMatchObject({ outcome: "failed" });
  });

  it("still writes the other pairs' rows when one pair's row cannot be written", async () => {
    // A per-pair write failure, not a dead database. Returning early here
    // would let a transient error on the first pair silently cost the rest
    // their evidence.
    vi.mocked(recordParityRun).mockImplementation(async (run) => {
      if (run.mode === "test") throw new Error("write failed");
    });

    await runParityCheckJob();

    expect(vi.mocked(recordParityRun).mock.calls.map((c) => `${c[0].mode}/${c[0].source}`)).toEqual(
      PAIR_KEYS,
    );
  });

  it("reports a pair that could not be recorded, distinguishably", async () => {
    vi.mocked(recordParityRun).mockImplementation(async (run) => {
      if (run.mode === "live") throw Object.assign(new Error("nope"), { code: "28P01" });
    });

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_UNRECORDABLE);
    const line = loggedLines().find((l) => l.outcome === "unrecordable");
    // Both axes on the unrecordable line too: an operator reading it has to
    // know which catalog's evidence is missing, not just which account's.
    expect(line).toMatchObject({
      mode: "live",
      source: SINGLE_SOURCE,
      errorName: "Error",
      errorCode: "28P01",
    });
  });

  it("records each mode's own outcome rather than one answer for both", async () => {
    // The estate as it stands: test clean, live never bootstrapped.
    pricesPerMode({ test: matching, live: [] });

    await runParityCheckJob();

    expect(recordedFor("test")).toMatchObject({ outcome: "clean" });
    expect(recordedFor("live")).toMatchObject({ outcome: "not_bootstrapped" });
  });
});

describe("a mode that has never been bootstrapped", () => {
  it("records not_bootstrapped rather than 42 differences", async () => {
    // Reporting a full catalog's worth of findings nightly for an account
    // nobody has launched is noise that trains people to ignore the report —
    // and the report is the only evidence the window is made of.
    pricesPerMode({ test: matching, live: [] });

    await runParityCheckJob();

    expect(recordedFor("live")).toEqual({
      mode: "live",
      source: SINGLE_SOURCE,
      outcome: "not_bootstrapped",
      differences: [],
      error: null,
      publicationId: null,
    });
  });

  it("exits 0, because it is a finding and not a crash", async () => {
    // Nothing is broken and nobody needs paging. A non-zero exit here would
    // make the CronJob fail every night until live is bootstrapped, which has
    // no date — and an alert that fires nightly for months is an alert that
    // gets muted, taking the real failures with it.
    pricesPerMode({ test: matching, live: [] });

    expect(await runParityCheckJob()).toBe(EXIT_OK);
  });

  it("logs it as its own outcome, not as clean", async () => {
    pricesPerMode({ test: matching, live: [] });

    await runParityCheckJob();

    const live = loggedLines().find((l) => l.mode === "live");
    expect(live).toMatchObject({ outcome: "not_bootstrapped", differenceCount: 0 });
  });

  it("does not touch the other mode's outcome", async () => {
    pricesPerMode({ test: [], live: matching });

    await runParityCheckJob();

    expect(recordedFor("test")).toMatchObject({ outcome: "not_bootstrapped" });
    expect(recordedFor("live")).toMatchObject({ outcome: "clean" });
  });
});

describe("a run with differences", () => {
  it("exits 0, because drift is the check's output and not a crash", async () => {
    // A non-zero exit here makes Kubernetes retry the job, and the retry
    // writes a second row for the same finding. The 7-day window then counts
    // one drifted day twice.
    pricesPerMode({ test: drifted, live: matching });

    expect(await runParityCheckJob()).toBe(EXIT_OK);
  });

  it("writes one differences row carrying the full report", async () => {
    pricesPerMode({ test: drifted, live: matching });

    await runParityCheckJob();

    expect(recordedFor("test")).toEqual({
      mode: "test",
      source: SINGLE_SOURCE,
      outcome: "differences",
      // A missing conversion, arriving as a named finding rather than an
      // unexplained number.
      differences: [
        {
          kind: "amount_mismatch",
          lookupKey: KEY,
          currency: "vnd",
          catalogUnitAmountMinor: 32_900_000,
          stripeUnitAmountMinor: 32_900_000,
          zeroDecimalSuspect: true,
        },
      ],
      error: null,
      publicationId: null,
    });
  });

  it("logs the difference count so the CronJob's log is readable without psql", async () => {
    pricesPerMode({ test: drifted, live: matching });

    await runParityCheckJob();

    expect(loggedLines().find((l) => l.mode === "test")).toMatchObject({
      outcome: "differences",
      differenceCount: 1,
    });
  });

  it("is a partial bootstrap's answer too, not not_bootstrapped", async () => {
    // ONLY ZERO COUNTS. Someone ran the tool and it half-worked, which is far
    // more dangerous than not having run it at all.
    vi.mocked(readCatalogAmounts).mockResolvedValue([
      catalog[0],
      { lookupKey: "mark8ly_pro_annual_v1", currency: "usd", unitAmountMinor: 9900,
        taxBehavior: "unspecified" },
    ]);
    pricesPerMode({ test: matching, live: matching });

    await runParityCheckJob();

    expect(recordedFor("live")).toMatchObject({ outcome: "differences" });
  });
});

describe("every failure path writes a failed row", () => {
  it("records a failed row carrying the reason when a credential is absent", async () => {
    failMode(
      "live",
      new StripeReadUnavailableError(
        "STRIPE_RESTRICTED_READ_KEY_LIVE is not set; the plan catalog parity check cannot read live mode Stripe Prices",
      ),
    );

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_CHECK_FAILED);
    expect(recordedFor("live")).toMatchObject({
      outcome: "failed",
      differences: [],
      error: expect.stringContaining("STRIPE_RESTRICTED_READ_KEY_LIVE"),
    });
  });

  it("records a failed row when a key's prefix contradicts its slot", async () => {
    // Rather than comparing the catalog against the wrong account, which is a
    // wrong answer delivered confidently — strictly worse than no answer.
    failMode(
      "test",
      new StripeReadUnavailableError(
        "STRIPE_RESTRICTED_READ_KEY_TEST holds a live mode key but is read as the test mode credential",
      ),
    );

    await runParityCheckJob();

    expect(recordedFor("test")).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("holds a live mode key"),
    });
  });

  it("records a failed row when Stripe is unreachable, and exits non-zero", async () => {
    // An upstream problem is categorically different from "the catalog has
    // drifted", and the two must be distinguishable without opening `psql`.
    failMode("test", new Error("connect ETIMEDOUT api.stripe.com:443"));

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_CHECK_FAILED);
    expect(recordedFor("test")).toMatchObject({ outcome: "failed", differences: [] });
  });

  it("records a failed row for EVERY pair when the catalog itself cannot be read", async () => {
    // `readCatalogAmounts` is mocked to reject for any (mode, source), so this
    // breaks every pair — and every row must exist, or the window has a hole
    // on whichever side was never written.
    vi.mocked(readCatalogAmounts).mockRejectedValue(new Error("relation does not exist"));

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_CHECK_FAILED);
    expect(recordParityRun).toHaveBeenCalledTimes(PAIR_COUNT);
    expect(recordedFor("test")).toMatchObject({ outcome: "failed" });
    expect(recordedFor("live")).toMatchObject({ outcome: "failed" });
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
  });

  it("never puts a credential into the stored reason", async () => {
    failMode("test", new Error(`Invalid API Key provided: ${LIVE_KEY_FIXTURE}`));

    await runParityCheckJob();

    expect(recordedFor("test")!.error).not.toContain("SECRETvalue");
    expect(recordedFor("test")!.error).toContain("[redacted]");
  });

  it("never puts a credential into the log line either", async () => {
    // The CronJob's stdout goes to the cluster's log sink, which is a longer
    // retention than the row and a wider audience.
    failMode("test", new Error(`Invalid API Key provided: ${LIVE_KEY_FIXTURE}`));

    await runParityCheckJob();

    expect(JSON.stringify(loggedLines())).not.toContain("SECRETvalue");
  });
});

describe("when a row cannot be written at all", () => {
  it("exits distinguishably, so the CronJob's own failure is the signal", async () => {
    // The one failure this design cannot record: with the database unreachable
    // there is nowhere to put the evidence. Silence here would be the
    // day-shaped hole everything else exists to prevent.
    vi.mocked(recordParityRun).mockRejectedValue(new Error("no database"));

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_UNRECORDABLE);
    expect(code).not.toBe(EXIT_CHECK_FAILED);
  });

  it("outranks a failed check, because no row is worse than a failed row", async () => {
    // A `failed` row is evidence. A missing row is a gap that reads as a clean
    // day to whoever looks next week, so it must be the code that surfaces.
    failMode("test", new Error("stripe down"));
    vi.mocked(recordParityRun).mockImplementation(async (run) => {
      if (run.mode === "live") throw new Error("no database");
    });

    expect(await runParityCheckJob()).toBe(EXIT_UNRECORDABLE);
  });

  it("does not leak the driver's message, which names the role and the host", async () => {
    // `sanitizeReason` would NOT save this: it redacts Stripe keys, and this
    // is a `pg` error. The job's log line goes to the cluster's log sink, at a
    // longer retention and a wider audience than the row.
    const failure = Object.assign(
      new Error("password authentication failed for user tesserix_admin"),
      { code: "28P01" },
    );
    vi.mocked(recordParityRun).mockRejectedValue(failure);

    await runParityCheckJob();

    const logged = JSON.stringify(loggedLines());
    expect(logged).not.toContain("password authentication");
    expect(logged).not.toContain("tesserix_admin");
  });

  it("still says enough to diagnose it, via the error's class and SQLSTATE", async () => {
    // Silence would be safe and useless. `28P01` is "bad password" and
    // `ECONNREFUSED` is "dead host" — the diagnostic half of the message with
    // none of the credential half.
    const failure = Object.assign(new Error("nope"), { code: "28P01" });
    vi.mocked(recordParityRun).mockRejectedValue(failure);

    await runParityCheckJob();

    expect(loggedLines()[0]).toMatchObject({
      outcome: "unrecordable",
      errorName: "Error",
      errorCode: "28P01",
    });
  });

  it("reports a null code rather than inventing one when the error carries none", async () => {
    vi.mocked(recordParityRun).mockRejectedValue(new TypeError("no code here"));

    await runParityCheckJob();

    expect(loggedLines()[0]).toMatchObject({ errorName: "TypeError", errorCode: null });
  });

  it("refuses to run either mode when the database is not configured", async () => {
    // A run whose result cannot be stored is not a run: the stored row IS the
    // deliverable. Failing before any Stripe call also keeps a misconfigured
    // job from spending both restricted keys' rate limits every hour.
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_UNRECORDABLE);
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
    expect(recordParityRun).not.toHaveBeenCalled();
    // One line, not one per mode: nothing mode-specific happened.
    expect(loggedLines()).toHaveLength(1);
  });
});

describe("it lets the process end", () => {
  // A `pg.Pool` with an idle client holds the event loop open. A CronJob whose
  // process never exits does not fail — it sits until `activeDeadlineSeconds`
  // kills it, which reports as a job failure for a run that actually succeeded
  // and wrote its rows. The pool is closed by the job, not by the entry point,
  // so it is closed on every path a test can reach.
  it("closes the pool once, after both modes", async () => {
    await runParityCheckJob();
    expect(closeTesserixPool).toHaveBeenCalledTimes(1);
  });

  it("closes the pool after a failed run", async () => {
    failMode("test", new Error("stripe down"));
    await runParityCheckJob();
    expect(closeTesserixPool).toHaveBeenCalledTimes(1);
  });

  it("closes the pool even when a row could not be written", async () => {
    vi.mocked(recordParityRun).mockRejectedValue(new Error("no database"));
    await runParityCheckJob();
    expect(closeTesserixPool).toHaveBeenCalledTimes(1);
  });

  it("still reports the outcome when closing the pool itself throws", async () => {
    // The rows are already written by this point. Letting a teardown error
    // overwrite a successful run's exit code would report a clean check as a
    // failed job.
    vi.mocked(closeTesserixPool).mockRejectedValue(new Error("pool already ended"));
    expect(await runParityCheckJob()).toBe(EXIT_OK);
  });
});

describe("it is a caller, not a second implementation", () => {
  it("reaches lib/billing/parity's comparator rather than one of its own", async () => {
    // A second copy of the comparator is the exact duplication #326 exists to
    // remove, and it would be invisible: the copy would pass every behavioural
    // test in this file while drifting from the one the operator-triggered
    // route uses, so the 7-day window would hold rows decided two ways.
    await runParityCheckJob();

    expect(compareCatalogToStripe).toHaveBeenCalledTimes(PAIR_COUNT);
    // The full 4-argument call `performParityCheck` (`parity-run.ts`) makes as
    // of tesserix-home#381 — mark8ly's own prefix and policy, threaded
    // through explicitly rather than left to the comparator's defaults.
    expect(compareCatalogToStripe).toHaveBeenCalledWith(catalog, matching, "mark8ly_", {
      amountsAreScaledBy100: true,
      lookupKeyPrefix: "mark8ly_",
      productBrand: "Mark8ly",
    });
  });

  it("takes the catalog from the repo and the prices from the read-only reader", async () => {
    await runParityCheckJob();

    // The catalog is read once PER PAIR. Both modes compare against the same
    // intended prices for a given source — there is one catalog per source —
    // but re-reading keeps `performParityCheck` a single self-contained
    // definition rather than a function whose correctness depends on its
    // caller having cached something.
    expect(readCatalogAmounts).toHaveBeenCalledTimes(PAIR_COUNT);
    expect(stripePriceReader.listPrices).toHaveBeenCalledTimes(PAIR_COUNT);
  });

  it("exposes no way to write to Stripe", async () => {
    // Enforced in `lib/billing/stripe-read.ts`, restated here because this is
    // the module a future edit would reach for when it wants to "just fix the
    // price it found" — and #326's definition of done is no write path.
    const reader: Record<string, unknown> = stripePriceReader as never;
    for (const forbidden of ["create", "update", "del", "archive"]) {
      expect(reader[forbidden]).toBeUndefined();
    }
  });
});
