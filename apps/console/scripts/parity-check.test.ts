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
  // The entitlement pass's half of the repository. Named here rather than left
  // out: a factory that omits an export the module under test imports fails at
  // import time with a message about the mock, not about the job.
  readEntitlements: vi.fn(async () => []),
  recordEntitlementParityRun: vi.fn(async () => {}),
}));
// The federated read the entitlement pass makes, and the two things the job
// inspects BEFORE making it. Stubbed rather than fetch-stubbed: what this file
// asserts is which principal the job asks for and what it does with the three
// answers, not how `platform-api` builds a request — that is
// `platform-api.test.ts`'s subject.
vi.mock("@/lib/platform-api", () => ({
  fetchProductEntitlements: vi.fn(async () => ({ data: [], failures: [] })),
  platformApiOrigin: vi.fn(() => "https://api.tesserix.test"),
}));
vi.mock("@/lib/auth/machine-token", () => ({
  machineCredential: vi.fn(() => ({
    state: "configured",
    credential: {
      clientId: "console-machine",
      clientSecret: "not-a-real-secret",
      tokenUrl: "https://zitadel.test/oauth/v2/token",
      projectId: "386377618200461939",
    },
  })),
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
import { machineCredential } from "@/lib/auth/machine-token";
import { closeTesserixPool, isDatabaseConfigured } from "@/lib/db/tesserix";
import {
  readCatalogAmounts,
  readEntitlements,
  readLivePublication,
  recordEntitlementParityRun,
  recordParityRun,
} from "@/lib/db/plan-catalog-repo";
import { fetchProductEntitlements, platformApiOrigin } from "@/lib/platform-api";
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

/** The lines the ENTITLEMENT pass emitted. Tagged `check: "entitlements"` at
 *  the source, so this is a positive match and not a subtraction. */
function entitlementLines(): Record<string, unknown>[] {
  return loggedLines().filter((line) => line.check === "entitlements");
}

/**
 * The lines the PRICE pass emitted.
 *
 * Matched by the ABSENCE of `check`, because the price pass's log shape is
 * #327's gate evidence and adding a key to it would change what a week of
 * archived lines look like. The separation lives in this file instead.
 */
function priceLines(): Record<string, unknown>[] {
  return loggedLines().filter((line) => line.check === undefined);
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

/** A provisioned machine credential, as `machineCredential` reports one. */
const CONFIGURED_CREDENTIAL = {
  state: "configured",
  credential: {
    clientId: "console-machine",
    clientSecret: "not-a-real-secret",
    tokenUrl: "https://zitadel.test/oauth/v2/token",
    projectId: "386377618200461939",
  },
} as unknown as ReturnType<typeof machineCredential>;

/** The federated entitlements page, with one product answering for `source`.
 *  `catalogMode` is the PRODUCT's answer — the entitlement run's mode is taken
 *  off it and never defaulted. */
function matrixPage(catalogMode = "test", source: string = SINGLE_SOURCE) {
  return {
    data: [{ source, catalogMode, features: ["stores"], plans: { pro: { stores: 3 } } }],
    failures: [] as { source: string; message: string }[],
  } as unknown as Awaited<ReturnType<typeof fetchProductEntitlements>>;
}

/** The entitlement runs the job actually wrote. */
const entitlementRuns = () => vi.mocked(recordEntitlementParityRun).mock.calls.map((c) => c[0]);

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
  // The entitlement pass's steady state: provisioned credential, a reachable
  // platform API, one product answering with a matrix, and a mode with nothing
  // published — `not_bootstrapped`, which is a finding and exits 0. Every
  // price-path test above therefore keeps the exit code it already asserted.
  vi.mocked(platformApiOrigin).mockReturnValue("https://api.tesserix.test");
  vi.mocked(machineCredential).mockReturnValue(CONFIGURED_CREDENTIAL);
  vi.mocked(fetchProductEntitlements).mockResolvedValue(matrixPage());
  vi.mocked(readLivePublication).mockResolvedValue(null);
  vi.mocked(readEntitlements).mockResolvedValue([]);
  vi.mocked(recordEntitlementParityRun).mockResolvedValue(undefined);
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

    const lines = priceLines();
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
    const line = priceLines().find((l) => l.outcome === "unrecordable");
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

    const live = priceLines().find((l) => l.mode === "live");
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

    expect(priceLines().find((l) => l.mode === "test")).toMatchObject({
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

    expect(priceLines()[0]).toMatchObject({
      outcome: "unrecordable",
      errorName: "Error",
      errorCode: "28P01",
    });
  });

  it("reports a null code rather than inventing one when the error carries none", async () => {
    vi.mocked(recordParityRun).mockRejectedValue(new TypeError("no code here"));

    await runParityCheckJob();

    expect(priceLines()[0]).toMatchObject({ errorName: "TypeError", errorCode: null });
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

/**
 * The entitlement pass (tesserix-home#146).
 *
 * Three properties, and they are not the price pass's restated. What this
 * suite exists for:
 *
 *  1. THE TWO PASSES ARE INDEPENDENT IN BOTH DIRECTIONS. A Stripe outage must
 *     not cost the entitlement rows, and an entitlement failure must not cost
 *     a price pair its row. The second direction is the dangerous one — the
 *     entitlement pass runs last, so an implementation that let it throw would
 *     leave every price row written and still fail the job with no exit code.
 *  2. THREE OUTCOMES, KEPT APART IN THE LOG. `run === null` sends someone to
 *     look at the PRODUCT; `run !== null && notRecorded !== null` sends them
 *     to POSTGRES. A single "unrecordable" line sends both at the wrong one.
 *  3. AN UNPROVISIONED CREDENTIAL IS SURVIVABLE. Every variable the machine
 *     path needs is `optional: true`, so a deployment without them is a
 *     legitimate state — it must skip, say so, and leave the price run's exit
 *     code exactly where it found it.
 */
const SOURCE_COUNT = CATALOG_SOURCES.length;

describe("the entitlement pass", () => {
  it("records one entitlement run per source", async () => {
    await runParityCheckJob();

    expect(recordEntitlementParityRun).toHaveBeenCalledTimes(SOURCE_COUNT);
    expect(entitlementRuns().map((run) => run.source)).toEqual([...CATALOG_SOURCES]);
  });

  it("asks the product AS THE CONSOLE'S MACHINE IDENTITY, never as an operator", async () => {
    // The whole reason #618 exists. There is no operator in a CronJob and none
    // can be minted, so the operator resolver would answer "this session
    // carries no platform API access token" and every night's run would be
    // unattributable — a job that fails forever while nothing is wrong.
    await runParityCheckJob();

    for (const source of CATALOG_SOURCES) {
      expect(fetchProductEntitlements).toHaveBeenCalledWith(source, { as: "machine" });
    }
  });

  it("files the run under the mode the PRODUCT reports, not a hard-coded one", async () => {
    vi.mocked(fetchProductEntitlements).mockResolvedValue(matrixPage("live"));

    await runParityCheckJob();

    expect(readLivePublication).toHaveBeenCalledWith("live");
    expect(entitlementRuns()[0]).toMatchObject({ mode: "live" });
  });

  it("logs one line per source, tagged so it cannot be read as a price row", async () => {
    await runParityCheckJob();

    const lines = entitlementLines();
    expect(lines).toHaveLength(SOURCE_COUNT);
    expect(lines.map((l) => l.source)).toEqual([...CATALOG_SOURCES]);
    for (const line of lines) {
      expect(line).toMatchObject({ check: "entitlements", mode: "test" });
    }
  });

  it("exits 0 for a mode with nothing published, as the price pass does", async () => {
    // A finding, not a crash. A non-zero exit makes Kubernetes retry, and the
    // retry writes a SECOND row for the same finding.
    expect(await runParityCheckJob()).toBe(EXIT_OK);
    expect(entitlementRuns()[0]).toMatchObject({ outcome: "not_bootstrapped" });
  });

  it("exits 0 for entitlement drift, because drift is the check's output", async () => {
    vi.mocked(readLivePublication).mockResolvedValue({
      id: "22222222-2222-2222-2222-222222222222",
      revisionId: "33333333-3333-3333-3333-333333333333",
      publishedBy: "operator",
      publishedAt: "2026-09-01T00:00:00.000Z",
    });
    vi.mocked(readEntitlements).mockResolvedValue([{ plan: "pro", feature: "stores", value: 9 }]);

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_OK);
    expect(entitlementRuns()[0]).toMatchObject({ outcome: "differences" });
    expect(entitlementLines()[0]).toMatchObject({ outcome: "differences", differenceCount: 1 });
  });
});

describe("the price pass and the entitlement pass are independent", () => {
  it("still runs the entitlement pass when every price pair failed", async () => {
    // The first direction. A Stripe outage is not a reason to stop asking
    // products what they enforce, and stopping would put a hole in the
    // entitlement half of the window for a reason that has nothing to do with
    // it.
    vi.mocked(readCatalogAmounts).mockRejectedValue(new Error("relation does not exist"));

    await runParityCheckJob();

    expect(recordEntitlementParityRun).toHaveBeenCalledTimes(SOURCE_COUNT);
  });

  it("still runs the entitlement pass when no price row could be written", async () => {
    vi.mocked(recordParityRun).mockRejectedValue(new Error("no database"));

    await runParityCheckJob();

    expect(recordEntitlementParityRun).toHaveBeenCalledTimes(SOURCE_COUNT);
  });

  it("writes every price row even when the entitlement pass blows up", async () => {
    // THE DIRECTION THAT COSTS EVIDENCE. `runEntitlementParityCheck` promises
    // never to throw; this asserts the job does not DEPEND on that promise for
    // the price rows, and — via the resolved exit code — that a broken
    // entitlement pass cannot take the whole invocation down with it.
    vi.mocked(fetchProductEntitlements).mockImplementation(() => {
      throw new Error("entitlement pass exploded");
    });

    await expect(runParityCheckJob()).resolves.toBeTypeOf("number");

    expect(recordParityRun).toHaveBeenCalledTimes(PAIR_COUNT);
    expect(recordedFor("test")).toMatchObject({ outcome: "clean" });
    expect(recordedFor("live")).toMatchObject({ outcome: "clean" });
  });

  it("cannot turn a failed price check into a green job", async () => {
    // The entitlement pass only ever RAISES the code. An assignment rather
    // than an OR here would let a clean entitlement run overwrite a price
    // failure — the finding still in the table and nobody paged for it.
    failMode("live", new Error("connect ETIMEDOUT api.stripe.com:443"));

    expect(await runParityCheckJob()).toBe(EXIT_CHECK_FAILED);
    expect(entitlementRuns()).toHaveLength(SOURCE_COUNT);
  });

  it("cannot turn an unwritable price row into a green job", async () => {
    vi.mocked(recordParityRun).mockRejectedValue(new Error("no database"));

    expect(await runParityCheckJob()).toBe(EXIT_UNRECORDABLE);
  });

  it("does not run at all when the database is not configured", async () => {
    // The one early return that IS correct: the stored row is the deliverable,
    // so a run that cannot be recorded is not a run — and that is as true of
    // the entitlement half as of the price half.
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);

    expect(await runParityCheckJob()).toBe(EXIT_UNRECORDABLE);
    expect(fetchProductEntitlements).not.toHaveBeenCalled();
    expect(recordEntitlementParityRun).not.toHaveBeenCalled();
  });
});

describe("the entitlement pass's three outcomes", () => {
  it("raises a `failed` run to a non-zero exit, with the price rows intact", async () => {
    vi.mocked(readLivePublication).mockRejectedValue(new Error("db read blew up"));

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_CHECK_FAILED);
    expect(entitlementRuns()[0]).toMatchObject({ outcome: "failed" });
    // The row that says so exists — this is a `failed` ROW, not a hole.
    expect(recordEntitlementParityRun).toHaveBeenCalledTimes(SOURCE_COUNT);
    expect(recordParityRun).toHaveBeenCalledTimes(PAIR_COUNT);
  });

  it("reports an UNATTRIBUTABLE attempt as its own outcome, naming the product", async () => {
    // No comparison happened: the product did not answer with a matrix. There
    // is no mode to file a row under, so nothing is written — and the line has
    // to send someone at the PRODUCT, not at Postgres.
    vi.mocked(fetchProductEntitlements).mockResolvedValue({
      data: [],
      failures: [{ source: SINGLE_SOURCE, message: "upstream 503" }],
    } as unknown as Awaited<ReturnType<typeof fetchProductEntitlements>>);

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_UNRECORDABLE);
    expect(recordEntitlementParityRun).not.toHaveBeenCalled();
    const line = entitlementLines()[0];
    expect(line).toMatchObject({ outcome: "unattributable", source: SINGLE_SOURCE });
    expect(String(line.reason)).toContain("upstream 503");
    // No guessed mode. Not knowing which one was read IS this state.
    expect(line.mode).toBeUndefined();
  });

  it("reports an UNRECORDABLE row differently, carrying what the check decided", async () => {
    // The comparison WAS decided and the row would not write. Distinct from
    // the case above in the log, because the remedy is Postgres and because
    // this line is now the only place the finding exists.
    vi.mocked(recordEntitlementParityRun).mockRejectedValue(
      Object.assign(new Error("nope"), { code: "28P01" }),
    );

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_UNRECORDABLE);
    expect(entitlementLines()[0]).toMatchObject({
      outcome: "unrecordable",
      mode: "test",
      source: SINGLE_SOURCE,
      decided: "not_bootstrapped",
      errorName: "Error",
      errorCode: "28P01",
    });
  });

  it("keeps the two apart, rather than reporting one word for both", async () => {
    // Asserted as a pair so a future edit cannot collapse them into a shared
    // "unrecordable" line and stay green: the exit code is the same for both,
    // so the log is the ONLY thing that distinguishes them.
    vi.mocked(fetchProductEntitlements).mockResolvedValue({
      data: [],
      failures: [{ source: SINGLE_SOURCE, message: "upstream 503" }],
    } as unknown as Awaited<ReturnType<typeof fetchProductEntitlements>>);
    await runParityCheckJob();
    const unattributable = entitlementLines()[0].outcome;

    vi.clearAllMocks();
    vi.mocked(isDatabaseConfigured).mockReturnValue(true);
    vi.mocked(readCatalogAmounts).mockResolvedValue(catalog);
    vi.mocked(recordParityRun).mockResolvedValue(undefined);
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue(matching);
    vi.mocked(closeTesserixPool).mockResolvedValue(undefined);
    vi.mocked(platformApiOrigin).mockReturnValue("https://api.tesserix.test");
    vi.mocked(machineCredential).mockReturnValue(CONFIGURED_CREDENTIAL);
    vi.mocked(fetchProductEntitlements).mockResolvedValue(matrixPage());
    vi.mocked(readLivePublication).mockResolvedValue(null);
    vi.mocked(readEntitlements).mockResolvedValue([]);
    vi.mocked(recordEntitlementParityRun).mockRejectedValue(new Error("no database"));
    await runParityCheckJob();

    expect(entitlementLines()[0].outcome).not.toBe(unattributable);
  });

  it("does not leak the driver's message, which names the role and the host", async () => {
    // `sanitizeReason` would NOT save this — it redacts Stripe keys, and this
    // is a `pg` error that arrives through `notRecorded` already sanitised and
    // still fully readable. Same threat the price pass's
    // `describeWriteFailure` exists for, same log sink.
    vi.mocked(recordEntitlementParityRun).mockRejectedValue(
      Object.assign(new Error("password authentication failed for user tesserix_admin"), {
        code: "28P01",
      }),
    );

    await runParityCheckJob();

    const logged = JSON.stringify(loggedLines());
    expect(logged).not.toContain("password authentication");
    expect(logged).not.toContain("tesserix_admin");
  });
});

describe("an unprovisioned machine credential", () => {
  it("skips the pass and leaves the price run's exit code untouched", async () => {
    // Every variable is `optional: true` in tesserix-k8s#1054, so this is a
    // legitimate deployment state. Failing here would fire an alert nightly
    // for as long as nobody provisions the grant — the muted-alert failure
    // `not_bootstrapped` already exists to avoid.
    vi.mocked(machineCredential).mockReturnValue({ state: "absent" } as unknown as ReturnType<
      typeof machineCredential
    >);

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_OK);
    expect(fetchProductEntitlements).not.toHaveBeenCalled();
    expect(recordEntitlementParityRun).not.toHaveBeenCalled();
    // Still writes every price row: the skip is the entitlement pass's alone.
    expect(recordParityRun).toHaveBeenCalledTimes(PAIR_COUNT);
  });

  it("says so, once, rather than silently doing nothing", async () => {
    vi.mocked(machineCredential).mockReturnValue({ state: "absent" } as unknown as ReturnType<
      typeof machineCredential
    >);

    await runParityCheckJob();

    const lines = entitlementLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "skipped" });
    expect(String(lines[0].reason)).toContain("machine credential");
  });

  it("names the missing variables when the credential is only half configured", async () => {
    // A deploy that went wrong, not one that never happened — otherwise
    // indistinguishable from the state above. Names the variables and never a
    // value.
    vi.mocked(machineCredential).mockReturnValue({
      state: "incomplete",
      missing: ["ZITADEL_MACHINE_CLIENT_SECRET"],
    } as unknown as ReturnType<typeof machineCredential>);

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_OK);
    expect(String(entitlementLines()[0].reason)).toContain("ZITADEL_MACHINE_CLIENT_SECRET");
    expect(fetchProductEntitlements).not.toHaveBeenCalled();
  });

  it("skips when there is no platform API to ask", async () => {
    vi.mocked(platformApiOrigin).mockReturnValue(null);

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_OK);
    expect(entitlementLines()[0]).toMatchObject({ outcome: "skipped" });
    expect(String(entitlementLines()[0].reason)).toContain("PLATFORM_API_ORIGIN");
    expect(fetchProductEntitlements).not.toHaveBeenCalled();
  });

  it("never puts the client secret into a log line", async () => {
    // The credential is read by this file to decide whether to run. Nothing it
    // prints may carry a value out of it.
    await runParityCheckJob();

    expect(JSON.stringify(loggedLines())).not.toContain("not-a-real-secret");
  });
});
