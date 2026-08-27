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
import { stripePriceReader, StripeReadUnavailableError } from "@/lib/billing/stripe-read";
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
 * The runner.
 *
 * The property this suite exists for is stated once, because it is the single
 * worst failure this design can have: EVERY FAILURE PATH WRITES A `failed` ROW.
 * A check that silently does nothing when Stripe is unreachable leaves a gap in
 * the 7-day window that is indistinguishable from a clean day — and a clean day
 * is what P2 revokes mark8ly's Stripe write key on.
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
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(readCatalogAmounts).mockResolvedValue(catalog);
  vi.mocked(recordParityRun).mockResolvedValue(undefined);
  vi.mocked(stripePriceReader.listPrices).mockResolvedValue(matching);
  signIn(["billing"]);
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
    // Middleware already gates /api/*, but a surface leaning on routing for
    // authorization stops being safe the moment the matcher changes. The
    // handler fails closed on its own, exactly as /api/notifications does.
    vi.mocked(getCurrentSession).mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(403);
    expect(recordParityRun).not.toHaveBeenCalled();
  });

  it("does NOT write a failed row when it refuses", async () => {
    // A refusal is not a check that failed — it is a check that never started,
    // by someone not entitled to start it. Recording it would let an
    // unauthorized caller pollute the window's evidence.
    signIn([]);
    await POST();
    expect(recordParityRun).not.toHaveBeenCalled();
  });
});

describe("a clean run", () => {
  it("writes exactly one clean row and returns the outcome", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: "clean",
      differenceCount: 0,
      differences: [],
    });
    expect(recordParityRun).toHaveBeenCalledTimes(1);
    expect(recordParityRun).toHaveBeenCalledWith({
      outcome: "clean",
      differences: [],
      error: null,
    });
  });
});

describe("a run with differences", () => {
  it("writes a differences row carrying the full report", async () => {
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([
      { ...matching[0], unit_amount: 329_000 },
    ]);

    const res = await POST();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe("differences");
    expect(body.differenceCount).toBe(1);
    // The VND question, arriving as a named finding rather than an
    // unexplained number.
    expect(body.differences[0]).toEqual({
      kind: "amount_mismatch",
      lookupKey: KEY,
      currency: "vnd",
      catalogUnitAmountMinor: 32_900_000,
      stripeUnitAmountMinor: 329_000,
      zeroDecimalSuspect: true,
    });
    expect(recordParityRun).toHaveBeenCalledWith({
      outcome: "differences",
      differences: body.differences,
      error: null,
    });
  });

  it("answers 200, because a difference is a finding and not an error", async () => {
    // If drift answered non-2xx, the CronJob's own alerting could not tell
    // "the catalog has drifted" from "the check could not run" — which is the
    // exact conflation the three-state outcome exists to prevent.
    vi.mocked(stripePriceReader.listPrices).mockResolvedValue([]);
    const res = await POST();
    expect(res.status).toBe(200);
  });
});

describe("every failure path writes a failed row", () => {
  it("records a failed row when the credential is absent, rather than throwing", async () => {
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(
      new StripeReadUnavailableError(
        "STRIPE_RESTRICTED_READ_KEY is not set; the plan catalog parity check cannot read Stripe Prices",
      ),
    );

    const res = await POST();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      outcome: "failed",
      error: expect.stringContaining("STRIPE_RESTRICTED_READ_KEY"),
    });
    expect(recordParityRun).toHaveBeenCalledWith({
      outcome: "failed",
      differences: [],
      error: expect.stringContaining("STRIPE_RESTRICTED_READ_KEY"),
    });
  });

  it("records a failed row when Stripe is unreachable", async () => {
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(
      new Error("connect ETIMEDOUT api.stripe.com:443"),
    );

    const res = await POST();

    expect(res.status).toBe(502);
    expect(recordParityRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", differences: [] }),
    );
  });

  it("records a failed row when the catalog itself cannot be read", async () => {
    vi.mocked(readCatalogAmounts).mockRejectedValue(new Error("relation does not exist"));

    const res = await POST();

    expect(res.status).toBe(502);
    expect(recordParityRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
    );
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
  });

  it("never puts a credential into the stored reason", async () => {
    // Stripe echoes request context into some error messages. The `error`
    // column is read by an operator and lives as long as the row does.
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(
      new Error(`Invalid API Key provided: ${LIVE_KEY_FIXTURE}`),
    );

    await POST();

    const recorded = vi.mocked(recordParityRun).mock.calls[0][0];
    expect(recorded.error).not.toContain("SECRETvalue");
    expect(recorded.error).toContain("[redacted]");
  });

  it("bounds the stored reason so one huge error cannot dominate the table", async () => {
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(new Error("x".repeat(5000)));
    await POST();
    const recorded = vi.mocked(recordParityRun).mock.calls[0][0];
    expect(recorded.error!.length).toBeLessThanOrEqual(512);
  });

  it("answers 500 when even the failed row cannot be written", async () => {
    // The one failure this design cannot record, stated honestly: with the
    // database unreachable there is nowhere to put the evidence. It must be a
    // loud non-2xx so the CronJob's own alerting is what covers the gap.
    vi.mocked(stripePriceReader.listPrices).mockRejectedValue(new Error("stripe down"));
    vi.mocked(recordParityRun).mockRejectedValue(new Error("no database"));

    const res = await POST();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("answers 500 without leaking the driver error when the clean write fails", async () => {
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
    // 501 is this estate's "data plane parked" signal, distinct from a real
    // failure — and a run whose result cannot be stored is not a run, because
    // the stored row IS the deliverable.
    vi.mocked(isDatabaseConfigured).mockReturnValue(false);
    const res = await POST();
    expect(res.status).toBe(501);
    expect(stripePriceReader.listPrices).not.toHaveBeenCalled();
    expect(recordParityRun).not.toHaveBeenCalled();
  });
});
