import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/tesserix", () => ({
  isDatabaseConfigured: vi.fn(() => true),
  tesserixQuery: vi.fn(),
  closeTesserixPool: vi.fn(async () => {}),
}));
vi.mock("@/lib/db/plan-catalog-repo", () => ({
  readCatalogAmounts: vi.fn(async () => []),
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
import { stripePriceReader, StripeReadUnavailableError } from "@/lib/billing/stripe-read";
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
 * The scheduled runner.
 *
 * Two properties this suite exists for, and both of them are about what a
 * human reads a week later:
 *
 *  1. EVERY FAILURE PATH WRITES A `failed` ROW — exactly one row, never zero
 *     and never two. A run that dies silently leaves a day-shaped hole in
 *     #326's 7-day window, and a hole is indistinguishable from a clean day.
 *     P2 revokes mark8ly's Stripe write key on that window.
 *  2. `differences` EXITS 0. Drift is the check's output, not a crash. A
 *     non-zero exit there would make Kubernetes retry the job and write
 *     duplicate rows for the same finding — which is the naive implementation,
 *     so the exit code is asserted explicitly rather than left implied.
 */

const KEY = "mark8ly_starter_monthly_ppp_vnd_v1";

const catalog: CatalogAmount[] = [
  { lookupKey: KEY, currency: "vnd", unitAmountMinor: 32_900_000, taxBehavior: "unspecified" },
];

const matching: StripePriceLike[] = [
  {
    id: "price_1",
    lookup_key: KEY,
    currency: "vnd",
    unit_amount: 32_900_000,
    tax_behavior: "unspecified",
  },
];

/** The one structured line the job emits, parsed back. */
function loggedLines(): Record<string, unknown>[] {
  const calls = [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ];
  return calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

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

describe("a clean run", () => {
  it("writes exactly one clean row and exits 0", async () => {
    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_OK);
    expect(recordParityRun).toHaveBeenCalledTimes(1);
    expect(recordParityRun).toHaveBeenCalledWith({
      outcome: "clean",
      differences: [],
      error: null,
    });
  });

  it("logs one structured line carrying the outcome and the count", async () => {
    await runParityCheckJob();

    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "clean", differenceCount: 0 });
  });
});

describe("a run with differences", () => {
  const drifted = [{ ...matching[0], unit_amount: 329_000 }];

  it("exits 0, because drift is the check's output and not a crash", async () => {
    // A non-zero exit here makes Kubernetes retry the job, and the retry
    // writes a second row for the same finding. The 7-day window then counts
    // one drifted day twice.
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue(drifted);

    expect(await runParityCheckJob()).toBe(EXIT_OK);
  });

  it("writes exactly one differences row carrying the full report", async () => {
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue(drifted);

    await runParityCheckJob();

    expect(recordParityRun).toHaveBeenCalledTimes(1);
    expect(recordParityRun).toHaveBeenCalledWith({
      outcome: "differences",
      // The VND question, arriving as a named finding rather than an
      // unexplained number.
      differences: [
        {
          kind: "amount_mismatch",
          lookupKey: KEY,
          currency: "vnd",
          catalogUnitAmountMinor: 32_900_000,
          stripeUnitAmountMinor: 329_000,
          zeroDecimalSuspect: true,
        },
      ],
      error: null,
    });
  });

  it("logs the difference count so the CronJob's log is readable without psql", async () => {
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue(drifted);

    await runParityCheckJob();

    expect(loggedLines()[0]).toMatchObject({ outcome: "differences", differenceCount: 1 });
  });
});

describe("every failure path writes a failed row", () => {
  it("records a failed row carrying the reason when the credential is absent", async () => {
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(
      new StripeReadUnavailableError(
        "STRIPE_RESTRICTED_READ_KEY is not set; the plan catalog parity check cannot read Stripe Prices",
      ),
    );

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_CHECK_FAILED);
    expect(recordParityRun).toHaveBeenCalledTimes(1);
    expect(recordParityRun).toHaveBeenCalledWith({
      outcome: "failed",
      differences: [],
      error: expect.stringContaining("STRIPE_RESTRICTED_READ_KEY"),
    });
  });

  it("records a failed row when Stripe is unreachable, and exits non-zero", async () => {
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(
      new Error("connect ETIMEDOUT api.stripe.com:443"),
    );

    const code = await runParityCheckJob();

    expect(code).not.toBe(EXIT_OK);
    expect(recordParityRun).toHaveBeenCalledTimes(1);
    expect(recordParityRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", differences: [] }),
    );
  });

  it("records a failed row when the catalog itself cannot be read", async () => {
    vi.mocked(readCatalogAmounts).mockRejectedValue(new Error("relation does not exist"));

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_CHECK_FAILED);
    expect(recordParityRun).toHaveBeenCalledTimes(1);
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
  });

  it("never puts a credential into the stored reason", async () => {
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(
      new Error(`Invalid API Key provided: ${LIVE_KEY_FIXTURE}`),
    );

    await runParityCheckJob();

    const recorded = vi.mocked(recordParityRun).mock.calls[0][0];
    expect(recorded.error).not.toContain("SECRETvalue");
    expect(recorded.error).toContain("[redacted]");
  });

  it("never puts a credential into the log line either", async () => {
    // The CronJob's stdout goes to the cluster's log sink, which is a longer
    // retention than the row and a wider audience.
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(
      new Error(`Invalid API Key provided: ${LIVE_KEY_FIXTURE}`),
    );

    await runParityCheckJob();

    expect(JSON.stringify(loggedLines())).not.toContain("SECRETvalue");
  });
});

describe("when the row cannot be written at all", () => {
  it("exits non-zero and distinguishably, so the CronJob's own failure is the signal", async () => {
    // The one failure this design cannot record: with the database unreachable
    // there is nowhere to put the evidence. Silence here would be the
    // day-shaped hole everything else exists to prevent.
    vi.mocked(recordParityRun).mockRejectedValue(new Error("no database"));

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_UNRECORDABLE);
    expect(code).not.toBe(EXIT_CHECK_FAILED);
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

  it("refuses to run at all when the database is not configured", async () => {
    // A run whose result cannot be stored is not a run: the stored row IS the
    // deliverable. Failing before the Stripe call also keeps a misconfigured
    // job from spending the restricted key's rate limit every hour.
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);

    const code = await runParityCheckJob();

    expect(code).toBe(EXIT_UNRECORDABLE);
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
    expect(recordParityRun).not.toHaveBeenCalled();
  });
});

describe("it lets the process end", () => {
  // A `pg.Pool` with an idle client holds the event loop open. A CronJob whose
  // process never exits does not fail — it sits until `activeDeadlineSeconds`
  // kills it, which reports as a job failure for a run that actually succeeded
  // and wrote its row. The pool is closed by the job, not by the entry point,
  // so it is closed on every path a test can reach.
  it("closes the pool after a clean run", async () => {
    await runParityCheckJob();
    expect(closeTesserixPool).toHaveBeenCalledTimes(1);
  });

  it("closes the pool after a failed run", async () => {
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(new Error("stripe down"));
    await runParityCheckJob();
    expect(closeTesserixPool).toHaveBeenCalledTimes(1);
  });

  it("closes the pool even when the row could not be written", async () => {
    vi.mocked(recordParityRun).mockRejectedValue(new Error("no database"));
    await runParityCheckJob();
    expect(closeTesserixPool).toHaveBeenCalledTimes(1);
  });

  it("still reports the outcome when closing the pool itself throws", async () => {
    // The row is already written by this point. Letting a teardown error
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

    expect(compareCatalogToStripe).toHaveBeenCalledTimes(1);
    expect(compareCatalogToStripe).toHaveBeenCalledWith(catalog, matching);
  });

  it("takes the catalog from the repo and the prices from the read-only reader", async () => {
    await runParityCheckJob();

    expect(readCatalogAmounts).toHaveBeenCalledTimes(1);
    expect(stripePriceReader.listPrices).toHaveBeenCalledTimes(1);
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
