import { describe, expect, it, vi } from "vitest";

/**
 * The per-tenant pricing override write seam (tesserix-home#331, T1).
 *
 * Mocked at the same seams `tools-write.test.ts` mocks: the session, the live
 * capability gate, and everything that leaves the process. `auditedOperation`
 * is NOT mocked away wholesale — it is the ordering guarantee this module
 * relies on, so it is given a real database mock and the rows it writes are
 * asserted.
 */

vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/auth/operator", () => ({ checkOperatorCapabilityLive: vi.fn() }));
vi.mock("@/lib/billing/mark8ly/stripe-write", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stripeCatalogWriter: { createCoupon: vi.fn() },
}));
vi.mock("@/lib/db/tenant-pricing-overrides-repo", () => ({
  readLiveTenantOverrideCoupon: vi.fn(),
  recordTenantOverrideCoupon: vi.fn(),
}));
/**
 * `audit-repo` is NOT mocked. `auditedOperation` calls `writeAuditEntry`
 * through its own module-local binding, so a module mock would replace what
 * this file imports and leave the real path untouched — the assertion would
 * pass against a function nothing calls. Mocking the DRIVER instead means the
 * real `auditedOperation`, the real `writeAuditEntry` and the real refusal
 * recognition all run, and what is asserted is the row that reaches Postgres.
 */
vi.mock("@/lib/db/tesserix", () => ({
  isDatabaseConfigured: () => true,
  tesserixQuery: vi.fn(async () => []),
}));

import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import {
  StripeCouponTermsError,
  StripeWriteUnavailableError,
  stripeCatalogWriter,
} from "@/lib/billing/mark8ly/stripe-write";
import { tesserixQuery } from "@/lib/db/tesserix";
import {
  readLiveTenantOverrideCoupon,
  recordTenantOverrideCoupon,
} from "@/lib/db/tenant-pricing-overrides-repo";
import type { PromoCodeDiscount } from "@/lib/db/promo-codes-repo";
import {
  grantTenantPricingOverride,
  type TenantPricingOverrideInput,
} from "./tenant-pricing-override-write";

const TENANT = "mark8ly:2b0f5f9e-1f2a-4c31-9c66-6f3d2b8e5a10";

const TEN_PERCENT: PromoCodeDiscount = {
  kind: "percent_off",
  percentOff: 10,
  duration: "forever",
  durationInMonths: null,
};

const GRANT: TenantPricingOverrideInput = {
  tenantId: TENANT,
  mode: "live",
  discount: TEN_PERCENT,
  label: "Negotiated rate",
  reason: "Churn risk escalated by the founder at renewal.",
};

function signedIn() {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "op-1",
    email: "op@t.test",
    roles: ["billing", "publish-catalog"],
  } as never);
  vi.mocked(checkOperatorCapabilityLive).mockResolvedValue(undefined as never);
}

/** A tenant with nothing minted, and a Stripe call that succeeds. */
function mintable(couponId = "co_live_1") {
  signedIn();
  vi.mocked(readLiveTenantOverrideCoupon).mockResolvedValue(null);
  vi.mocked(stripeCatalogWriter.createCoupon).mockResolvedValue({ id: couponId });
  vi.mocked(recordTenantOverrideCoupon).mockImplementation(async (input) => ({
    id: "row-1",
    tenantId: input.tenantId,
    mode: input.mode,
    stripeCouponId: input.stripeCouponId,
    grantedBy: input.grantedBy,
    grantedAt: "2026-09-04T00:00:00.000Z",
    removedBy: null,
    removedAt: null,
  }));
}

describe("granting a tenant a pricing override", () => {
  it("mints a coupon, records it, and returns the id T3 attaches", async () => {
    mintable("co_live_abc");

    const result = await grantTenantPricingOverride(GRANT);

    expect(result).toEqual({ ok: true, couponId: "co_live_abc" });
    expect(recordTenantOverrideCoupon).toHaveBeenCalledWith({
      tenantId: TENANT,
      mode: "live",
      stripeCouponId: "co_live_abc",
      grantedBy: "op-1",
    });
  });

  it("records the mint in the console's own audit log", async () => {
    mintable("co_live_abc");

    await grantTenantPricingOverride(GRANT);

    expect(auditRows()).toEqual([
      ["op-1", "billing.tenant.override.mint", `${TENANT} (live) co_live_abc`],
    ]);
  });

  it("never sends the reason to Stripe or stores it — mark8ly audits the grant", async () => {
    mintable();

    await grantTenantPricingOverride(GRANT);

    // The reason and the label are deliberately different sentences here: the
    // label IS sent to Stripe, so a shared word would make this assertion pass
    // or fail for the wrong reason.
    const [, spec] = vi.mocked(stripeCatalogWriter.createCoupon).mock.calls[0];
    expect(JSON.stringify(spec)).not.toContain("Churn risk");
    const [recorded] = vi.mocked(recordTenantOverrideCoupon).mock.calls[0];
    expect(JSON.stringify(recorded)).not.toContain("Churn risk");
  });

  it("does not forward a redemption cap to Stripe", async () => {
    mintable();

    await grantTenantPricingOverride(GRANT);

    const [, spec] = vi.mocked(stripeCatalogWriter.createCoupon).mock.calls[0];
    expect(spec).not.toHaveProperty("maxRedemptions");
  });

  it("names the coupon with the operator's label and never with the tenant id", async () => {
    mintable();

    await grantTenantPricingOverride(GRANT);

    const [, spec] = vi.mocked(stripeCatalogWriter.createCoupon).mock.calls[0];
    expect(spec.name).toBe("Negotiated rate");
    // `Coupon.name` is customer-visible. A namespaced internal id there is both
    // meaningless to the tenant reading their invoice and long enough to risk
    // Stripe refusing the create — which this module could not tell from a lost
    // response, so every grant would report "a coupon may already exist".
    expect(spec.name).not.toContain(TENANT);
    expect(spec.name).not.toContain("mark8ly:");
  });

  it("trims the label rather than sending an operator's stray whitespace to an invoice", async () => {
    mintable();

    await grantTenantPricingOverride({ ...GRANT, label: "  Negotiated rate \n" });

    const [, spec] = vi.mocked(stripeCatalogWriter.createCoupon).mock.calls[0];
    expect(spec.name).toBe("Negotiated rate");
  });

  it("demands a label before anything is minted", async () => {
    mintable();

    const result = await grantTenantPricingOverride({ ...GRANT, label: "   " });

    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(/invoice/i),
      field: "label",
    });
    expect(stripeCatalogWriter.createCoupon).not.toHaveBeenCalled();
  });

  it("refuses an over-long label HERE, so it is a field error and not a mint of unknown outcome", async () => {
    mintable();

    const result = await grantTenantPricingOverride({ ...GRANT, label: "x".repeat(61) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.field).toBe("label");
    // The point of refusing before the call: a name Stripe rejects comes back
    // as an exception this module cannot distinguish from a lost response, and
    // would be reported as "a coupon may already exist there".
    expect(result.message).not.toMatch(/may already exist/i);
    expect(stripeCatalogWriter.createCoupon).not.toHaveBeenCalled();
  });

  it("accepts a label at the limit", async () => {
    mintable();

    const result = await grantTenantPricingOverride({ ...GRANT, label: "x".repeat(60) });

    expect(result.ok).toBe(true);
  });

  it("keys the mint on the terms, so a re-grant at a different rate is a different key", async () => {
    mintable();
    await grantTenantPricingOverride(GRANT);
    await grantTenantPricingOverride({
      ...GRANT,
      discount: { ...TEN_PERCENT, percentOff: 20 },
    });

    const keys = vi
      .mocked(stripeCatalogWriter.createCoupon)
      .mock.calls.map((call) => call[2]);
    expect(keys[0]).not.toBe(keys[1]);
    // Deterministic, not random: the same grant replayed after a lost response
    // has to reach Stripe with the key that already minted it.
    expect(keys[0]).toBe(mintKeyOf(GRANT));
  });

  it("replays one key for the same grant, so a lost response cannot mint twice", async () => {
    mintable();
    await grantTenantPricingOverride(GRANT);
    await grantTenantPricingOverride({ ...GRANT, reason: "Different wording entirely." });

    const keys = vi
      .mocked(stripeCatalogWriter.createCoupon)
      .mock.calls.map((call) => call[2]);
    expect(keys[0]).toBe(keys[1]);
  });

  it("refuses a tenant that already has one BEFORE calling Stripe, naming the coupon", async () => {
    signedIn();
    vi.mocked(readLiveTenantOverrideCoupon).mockResolvedValue({
      id: "row-0",
      tenantId: TENANT,
      mode: "live",
      stripeCouponId: "co_live_first",
      grantedBy: "op-0",
      grantedAt: "2026-08-01T00:00:00.000Z",
      removedBy: null,
      removedAt: null,
    });

    const result = await grantTenantPricingOverride(GRANT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("co_live_first");
    // The whole point of refusing on a read: a second real coupon is not
    // created in a real billing account and only then rejected.
    expect(stripeCatalogWriter.createCoupon).not.toHaveBeenCalled();
  });

  it("refuses when `billing` alone is refused", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue({
      sub: "op-3",
      roles: ["publish-catalog"],
    } as never);
    vi.mocked(readLiveTenantOverrideCoupon).mockResolvedValue(null);
    // ONLY `billing`. The two checks are independent gates and each has to be
    // load-bearing on its own — a suite that refuses both at once passes just
    // as happily with one of them deleted.
    vi.mocked(checkOperatorCapabilityLive).mockImplementation(async (_session, required) => {
      if (required === "billing") throw new CapabilityError("billing");
    });

    const result = await grantTenantPricingOverride(GRANT);

    expect(result).toEqual({ ok: false, message: expect.stringMatching(/permission/i) });
    expect(stripeCatalogWriter.createCoupon).not.toHaveBeenCalled();
    expect(recordTenantOverrideCoupon).not.toHaveBeenCalled();
  });

  it("refuses when `publish-catalog` alone is refused, and never calls Stripe", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue({ sub: "op-2", roles: ["billing"] } as never);
    vi.mocked(checkOperatorCapabilityLive).mockImplementation(async (_session, required) => {
      if (required === "publish-catalog") throw new CapabilityError("publish-catalog");
    });

    const result = await grantTenantPricingOverride(GRANT);

    expect(result).toEqual({ ok: false, message: expect.stringMatching(/permission/i) });
    expect(stripeCatalogWriter.createCoupon).not.toHaveBeenCalled();
    expect(recordTenantOverrideCoupon).not.toHaveBeenCalled();
  });

  it("writes the refusal to the audit log as capability.refused", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue({ sub: "op-2", roles: ["billing"] } as never);
    vi.mocked(checkOperatorCapabilityLive).mockRejectedValue(
      new CapabilityError("publish-catalog"),
    );

    await grantTenantPricingOverride(GRANT);

    // The reason this seam does not call `recordDeniedAttempt`: the check is
    // inside `auditedOperation`, which already accounts for the refusal.
    expect(auditRows()).toEqual([["op-2", "capability.refused", `${TENANT} (live)`]]);
  });

  it("demands a reason before anything is minted", async () => {
    mintable();

    const result = await grantTenantPricingOverride({ ...GRANT, reason: "   " });

    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(/why this tenant/i),
      field: "reason",
    });
    expect(stripeCatalogWriter.createCoupon).not.toHaveBeenCalled();
  });

  it("refuses a repeating discount with no month count", async () => {
    mintable();

    const result = await grantTenantPricingOverride({
      ...GRANT,
      discount: { ...TEN_PERCENT, duration: "repeating", durationInMonths: null },
    });

    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(/months/i),
      field: "durationInMonths",
    });
    expect(stripeCatalogWriter.createCoupon).not.toHaveBeenCalled();
  });

  it("refuses a non-repeating discount that carries a month count", async () => {
    mintable();

    const result = await grantTenantPricingOverride({
      ...GRANT,
      discount: { ...TEN_PERCENT, duration: "forever", durationInMonths: 3 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.field).toBe("durationInMonths");
    // The dangerous half, and the reason this is checked here rather than left
    // to Stripe: "3 months at 10% off" authored against `forever` is a
    // permanent discount that Stripe would create without complaint.
    expect(stripeCatalogWriter.createCoupon).not.toHaveBeenCalled();
  });

  it("refuses a duration that is not one of Stripe's three", async () => {
    mintable();

    const result = await grantTenantPricingOverride({
      ...GRANT,
      discount: { ...TEN_PERCENT, duration: "monthly" as never },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.field).toBe("duration");
    expect(stripeCatalogWriter.createCoupon).not.toHaveBeenCalled();
  });

  it("names the mode and says nothing was minted when that mode has no write key", async () => {
    signedIn();
    vi.mocked(readLiveTenantOverrideCoupon).mockResolvedValue(null);
    vi.mocked(stripeCatalogWriter.createCoupon).mockRejectedValue(
      new StripeWriteUnavailableError("STRIPE_WRITE_KEY_LIVE is unset"),
    );

    const result = await grantTenantPricingOverride(GRANT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("STRIPE_WRITE_KEY_LIVE");
    expect(result.message).toMatch(/nothing was minted/i);
  });

  it("never claims nothing happened when the mint may have succeeded", async () => {
    signedIn();
    vi.mocked(readLiveTenantOverrideCoupon).mockResolvedValue(null);
    vi.mocked(stripeCatalogWriter.createCoupon).mockResolvedValue({ id: "co_live_orphan" });
    // The gap #521 already answered: the coupon exists and recording it failed.
    vi.mocked(recordTenantOverrideCoupon).mockRejectedValue(new Error("connection terminated"));

    const result = await grantTenantPricingOverride(GRANT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/may already exist/i);
    expect(result.message).not.toMatch(/nothing (was|happened)/i);
  });

  it("says the terms are unmintable without sending anyone looking for a coupon", async () => {
    signedIn();
    vi.mocked(readLiveTenantOverrideCoupon).mockResolvedValue(null);
    vi.mocked(stripeCatalogWriter.createCoupon).mockRejectedValue(
      new StripeCouponTermsError("createCoupon was given no discount terms"),
    );

    const result = await grantTenantPricingOverride(GRANT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).not.toMatch(/may already exist/i);
    // The internal sentence is written for a run log and must not be shown.
    expect(result.message).not.toContain("createCoupon");
  });
});

/** Every audit row that reached the driver, as (actor, action, target). */
function auditRows(): (string | null)[][] {
  return vi
    .mocked(tesserixQuery)
    .mock.calls.filter(([sql]) => sql.includes("INSERT INTO console_audit_log"))
    .map(([, params]) => [params![0], params![1], params![2]] as (string | null)[]);
}

/** The key the module is expected to build, spelled independently here so the
 *  assertion above pins the shape rather than echoing whatever was produced. */
function mintKeyOf(input: TenantPricingOverrideInput): string {
  const d = input.discount;
  const terms = d.kind === "percent_off" ? `percent_off:${d.percentOff}` : "unused";
  return `tenant-override:v1:${input.tenantId}:${input.mode}:${terms}:${d.duration}::${input.label}`;
}
