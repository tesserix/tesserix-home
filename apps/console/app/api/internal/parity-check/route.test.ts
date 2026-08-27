import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/tesserix", () => ({
  isDatabaseConfigured: vi.fn(() => true),
  tesserixQuery: vi.fn(),
}));
vi.mock("@/lib/db/plan-catalog-repo", () => ({
  readCatalogAmounts: vi.fn(async () => []),
  recordParityRun: vi.fn(async () => {}),
}));
vi.mock("@/lib/billing/stripe-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/stripe-read")>()),
  stripePriceReader: { listPrices: vi.fn(async () => []) },
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import {
  stripePriceReader,
  StripeReadUnavailableError,
  type StripeMode,
} from "@/lib/billing/stripe-read";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import { readCatalogAmounts, recordParityRun } from "@/lib/db/plan-catalog-repo";
import type { CatalogAmount, StripePriceLike } from "@/lib/billing/parity";
import { POST } from "./route";

// A key-shaped fixture, assembled at runtime rather than written as a
// literal. `sanitizeReason` must be proved against a string that really
// matches STRIPE_KEY_PATTERN, but the CI secret scan runs `gitleaks git .` —
// it reads COMMITS, not the working tree — so a literal here is a permanent
// finding in this branch's history that no later edit can clear. Joining the
// parts keeps the assertion honest and the scan strict, with no allowlist and
// no baseline entry.
const LIVE_KEY_FIXTURE = ["rk", "live", "9aZbQ2mmSECRETvalue"].join("_");

/**
 * The operator-triggered runner, which now runs BOTH modes.
 *
 * The property this suite exists for is stated once, because it is the single
 * worst failure this design can have: EVERY FAILURE PATH WRITES A `failed` ROW,
 * FOR EVERY MODE. A check that silently does nothing when Stripe is unreachable
 * leaves a gap in the 7-day window that is indistinguishable from a clean day —
 * and a clean day is what P2 revokes mark8ly's Stripe write key on.
 *
 * The second property, new here: one mode's failure must not cost the other its
 * row. A route that gave up on the first error would make an absent live
 * credential — which is today's state — silently stop test's window too.
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

const drifted: StripePriceLike[] = [{ ...matching[0], unit_amount: 32_900_000 }];

function pricesPerMode(per: Partial<Record<StripeMode, StripePriceLike[]>>) {
  vi.mocked(stripePriceReader.listPrices).mockImplementation(async (mode) => {
    const prices = per[mode];
    if (prices === undefined) throw new Error(`no fixture for ${mode}`);
    return prices;
  });
}

function failMode(failing: StripeMode, cause: Error) {
  vi.mocked(stripePriceReader.listPrices).mockImplementation(async (mode) => {
    if (mode === failing) throw cause;
    return matching;
  });
}

const recordedFor = (mode: StripeMode) =>
  vi.mocked(recordParityRun).mock.calls.map((c) => c[0]).find((run) => run.mode === mode);

interface RunBody {
  mode: StripeMode;
  outcome: string;
  differenceCount: number;
  differences: unknown[];
  error: string | null;
}

const runsOf = async (res: Response): Promise<RunBody[]> =>
  ((await res.json()) as { runs: RunBody[] }).runs;

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1",
    email: "op@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  signIn(["billing"]);
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(readCatalogAmounts).mockResolvedValue(catalog);
  vi.mocked(recordParityRun).mockResolvedValue(undefined);
  vi.mocked(stripePriceReader.listPrices).mockResolvedValue(matching);
});

describe("the guard", () => {
  it("refuses a session without the billing capability, and runs nothing", async () => {
    signIn([]);

    const res = await POST();

    expect(res.status).toBe(403);
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
    expect(recordParityRun).not.toHaveBeenCalled();
  });

  it("refuses a null session", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue(null as never);

    const res = await POST();

    expect(res.status).toBe(403);
    expect(recordParityRun).not.toHaveBeenCalled();
  });

  it("does NOT write a failed row when it refuses", async () => {
    // A refusal is not a check that failed — it is a check that never started,
    // by someone not entitled to start it. Recording it would let an
    // unauthorized caller write into the window's own evidence.
    signIn([]);

    await POST();

    expect(recordParityRun).not.toHaveBeenCalled();
  });
});

describe("one request covers both modes", () => {
  it("writes exactly one row per mode and reports each", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(recordParityRun).toHaveBeenCalledTimes(2);
    expect(await runsOf(res)).toEqual([
      { mode: "test", outcome: "clean", differenceCount: 0, differences: [], error: null },
      { mode: "live", outcome: "clean", differenceCount: 0, differences: [], error: null },
    ]);
  });

  it("reads each mode's Stripe account separately", async () => {
    await POST();

    expect(stripePriceReader.listPrices).toHaveBeenCalledWith("test");
    expect(stripePriceReader.listPrices).toHaveBeenCalledWith("live");
  });

  it("answers per mode rather than collapsing to one outcome", async () => {
    // The estate as it stands: test clean, live never bootstrapped. A single
    // top-level `outcome` would have to pick one of these and be wrong about
    // the other.
    pricesPerMode({ test: matching, live: [] });

    const runs = await runsOf(await POST());

    expect(runs.map((r) => [r.mode, r.outcome])).toEqual([
      ["test", "clean"],
      ["live", "not_bootstrapped"],
    ]);
  });
});

describe("a run with differences", () => {
  it("writes a differences row carrying the full report", async () => {
    pricesPerMode({ test: drifted, live: matching });

    const res = await POST();
    const runs = await runsOf(res);
    const test = runs.find((r) => r.mode === "test")!;

    expect(test.outcome).toBe("differences");
    expect(test.differenceCount).toBe(1);
    expect(test.differences[0]).toEqual({
      kind: "amount_mismatch",
      lookupKey: KEY,
      currency: "vnd",
      catalogUnitAmountMinor: 32_900_000,
      stripeUnitAmountMinor: 32_900_000,
      zeroDecimalSuspect: true,
    });
    expect(recordedFor("test")).toMatchObject({ outcome: "differences" });
  });

  it("answers 200, because a difference is a finding and not an error", async () => {
    pricesPerMode({ test: drifted, live: matching });

    expect((await POST()).status).toBe(200);
  });
});

describe("a mode that has never been bootstrapped", () => {
  it("answers 200 and records not_bootstrapped, not 42 differences", async () => {
    // Reporting a full catalog's worth of findings for an account nobody has
    // launched is noise that trains people to ignore the report — and the
    // report is the only evidence the window is made of.
    pricesPerMode({ test: matching, live: [] });

    const res = await POST();

    expect(res.status).toBe(200);
    expect(recordedFor("live")).toEqual({
      mode: "live",
      outcome: "not_bootstrapped",
      differences: [],
      error: null,
      publicationId: null,
    });
  });

  it("is reported as its own state, distinct from clean", async () => {
    // The distinction is what parks #327 behind a live bootstrap: the gate is
    // "both modes clean", and this is not clean.
    pricesPerMode({ test: matching, live: [] });

    const live = (await runsOf(await POST())).find((r) => r.mode === "live")!;

    expect(live.outcome).toBe("not_bootstrapped");
    expect(live.outcome).not.toBe("clean");
    expect(live.differences).toEqual([]);
  });

  it("is not_bootstrapped only at exactly zero, never at a partial bootstrap", async () => {
    // ONLY ZERO COUNTS. Someone ran the tool and it half-worked, which is far
    // more dangerous than not having run it at all.
    vi.mocked(readCatalogAmounts).mockResolvedValue([
      catalog[0],
      { lookupKey: "mark8ly_pro_annual_v1", currency: "usd", unitAmountMinor: 9900,
        taxBehavior: "unspecified" },
    ]);

    const live = (await runsOf(await POST())).find((r) => r.mode === "live")!;

    expect(live.outcome).toBe("differences");
  });
});

describe("every failure path writes a failed row", () => {
  it("records a failed row when a credential is absent, rather than throwing", async () => {
    failMode(
      "live",
      new StripeReadUnavailableError(
        "STRIPE_RESTRICTED_READ_KEY_LIVE is not set; the plan catalog parity check cannot read live mode Stripe Prices",
      ),
    );

    const res = await POST();

    // 502, because a mode could not run — an upstream problem, not a finding.
    expect(res.status).toBe(502);
    expect(recordedFor("live")).toMatchObject({
      outcome: "failed",
      differences: [],
      error: expect.stringContaining("STRIPE_RESTRICTED_READ_KEY_LIVE"),
    });
  });

  it("still writes the other mode's row when one mode fails", async () => {
    // Today's state, near enough: live has no restricted key. If that cost
    // test its row, one absent secret would put a hole in every day of the
    // window rather than in live's half of it.
    failMode("live", new Error("connect ETIMEDOUT api.stripe.com:443"));

    await POST();

    expect(recordParityRun).toHaveBeenCalledTimes(2);
    expect(recordedFor("test")).toMatchObject({ outcome: "clean" });
    expect(recordedFor("live")).toMatchObject({ outcome: "failed" });
  });

  it("reports the clean mode alongside the failed one", async () => {
    // A 502 that hid test's clean result would send an operator looking for a
    // fault in a mode that had just answered correctly.
    failMode("live", new Error("connect ETIMEDOUT api.stripe.com:443"));

    const runs = await runsOf(await POST());

    expect(runs.find((r) => r.mode === "test")!.outcome).toBe("clean");
    expect(runs.find((r) => r.mode === "live")!.outcome).toBe("failed");
  });

  it("records a failed row when a key's prefix contradicts its slot", async () => {
    failMode(
      "test",
      new StripeReadUnavailableError(
        "STRIPE_RESTRICTED_READ_KEY_TEST holds a live mode key but is read as the test mode credential",
      ),
    );

    const res = await POST();

    expect(res.status).toBe(502);
    expect(recordedFor("test")).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("holds a live mode key"),
    });
  });

  it("records a failed row for both modes when the catalog cannot be read", async () => {
    vi.mocked(readCatalogAmounts).mockRejectedValue(new Error("relation does not exist"));

    const res = await POST();

    expect(res.status).toBe(502);
    expect(recordParityRun).toHaveBeenCalledTimes(2);
    expect(recordedFor("test")).toMatchObject({ outcome: "failed" });
    expect(recordedFor("live")).toMatchObject({ outcome: "failed" });
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
  });

  it("never puts a credential into the stored reason", async () => {
    failMode("test", new Error(`Invalid API Key provided: ${LIVE_KEY_FIXTURE}`));

    await POST();

    expect(recordedFor("test")!.error).not.toContain("SECRETvalue");
    expect(recordedFor("test")!.error).toContain("[redacted]");
  });

  it("never puts a credential into the response body either", async () => {
    failMode("test", new Error(`Invalid API Key provided: ${LIVE_KEY_FIXTURE}`));

    const res = await POST();

    expect(JSON.stringify(await res.json())).not.toContain("SECRETvalue");
  });

  it("bounds the stored reason so one huge error cannot dominate the table", async () => {
    failMode("test", new Error("x".repeat(5000)));

    await POST();

    expect(recordedFor("test")!.error!.length).toBeLessThanOrEqual(512);
  });

  it("answers 500 when a row cannot be written at all", async () => {
    // The one failure this design cannot record: with the database unreachable
    // there is nowhere to put the evidence. Loud and non-2xx, so the CronJob's
    // own alerting is what covers the gap — silence here would be the
    // day-shaped hole the module header exists to prevent.
    vi.mocked(recordParityRun).mockRejectedValue(new Error("no database"));

    const res = await POST();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("answers 500 even when only one mode's row could not be written", async () => {
    // A gap in one mode's day is still a gap, and it outranks the other mode's
    // clean answer: a `failed` row is evidence, a missing row reads as
    // agreement.
    vi.mocked(recordParityRun).mockImplementation(async (run) => {
      if (run.mode === "live") throw new Error("no database");
    });

    expect((await POST()).status).toBe(500);
  });

  it("still attempts the second mode's row after the first cannot be written", async () => {
    vi.mocked(recordParityRun).mockImplementation(async (run) => {
      if (run.mode === "test") throw new Error("write failed");
    });

    await POST();

    expect(vi.mocked(recordParityRun).mock.calls.map((c) => c[0].mode)).toEqual([
      "test",
      "live",
    ]);
  });

  it("answers 500 without leaking the driver error", async () => {
    vi.mocked(recordParityRun).mockRejectedValue(
      new Error("password authentication failed for user tesserix_admin"),
    );

    const res = await POST();

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("password");
  });
});

describe("the data plane not being wired up yet", () => {
  it("answers 501 rather than running a check it could not record", async () => {
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);

    const res = await POST();

    expect(res.status).toBe(501);
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
    expect(recordParityRun).not.toHaveBeenCalled();
  });
});
