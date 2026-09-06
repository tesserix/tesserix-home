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
  stripeCatalogWriter: { createCoupon: vi.fn(), deleteCoupon: vi.fn() },
}));
vi.mock("@/lib/db/tenant-pricing-overrides-repo", () => ({
  readLiveTenantOverrideCoupon: vi.fn(),
  recordTenantOverrideCoupon: vi.fn(),
  retireTenantOverrideCoupon: vi.fn(),
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
/**
 * The federated call, mocked at its own module. It is a `server-only` seam
 * over `platformRequestWithMeta`, and what it sends is asserted against the
 * contract in `tenant-discount-write.test.ts`; what belongs HERE is when this
 * seam calls it, with what, and what a failure of it does to the result.
 */
vi.mock("./tenant-discount-write", () => ({
  applyTenantDiscount: vi.fn(),
  removeTenantDiscount: vi.fn(),
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
  retireTenantOverrideCoupon,
} from "@/lib/db/tenant-pricing-overrides-repo";
import type { PromoCodeDiscount } from "@/lib/db/promo-codes-repo";
import {
  applyTenantDiscount,
  removeTenantDiscount,
  type TenantDiscountResult,
} from "./tenant-discount-write";
import {
  grantTenantPricingOverride,
  revokeTenantPricingOverride,
  type TenantPricingOverrideInput,
  type TenantPricingOverrideRevokeInput,
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

/** mark8ly's report for a tenant with one store that took the coupon. */
const APPLIED: TenantDiscountResult = {
  ok: true,
  status: "ok",
  requiresReconciliation: false,
  stores: [{ storeId: "store-1", outcome: "applied" }],
};

/** The same store, with the coupon taken back off. */
const DETACHED: TenantDiscountResult = {
  ok: true,
  status: "ok",
  requiresReconciliation: false,
  stores: [{ storeId: "store-1", outcome: "removed" }],
};

/** A tenant with nothing minted, and a Stripe call that succeeds. */
function mintable(couponId = "co_live_1") {
  signedIn();
  vi.mocked(applyTenantDiscount).mockResolvedValue(APPLIED);
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
  it("mints a coupon, records it, and returns the id it hands to mark8ly", async () => {
    mintable("co_live_abc");

    const result = await grantTenantPricingOverride(GRANT);

    expect(result).toEqual({ ok: true, couponId: "co_live_abc", attach: APPLIED });
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

  it("keeps the reason OUT of the key, so a reworded justification is not a second coupon", async () => {
    mintable();
    await grantTenantPricingOverride(GRANT);
    // Same Stripe request, different reason. The reason goes to mark8ly, never
    // to Stripe, so it must not move the key — a new key here would mint a
    // second live coupon for a tenant who should have exactly one.
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

describe("the grant asks mark8ly to apply the coupon", () => {
  it("sends the recorded coupon, the tenant id WHOLE, the mode and the reason", async () => {
    mintable("co_live_abc");

    await grantTenantPricingOverride(GRANT);

    expect(applyTenantDiscount).toHaveBeenCalledWith({
      tenantId: TENANT,
      mode: "live",
      couponId: "co_live_abc",
      // The reason reaches mark8ly and nowhere else: it is what the product
      // writes into the audit row inside each store's transaction, which is
      // the row read later by someone asking why.
      reason: GRANT.reason,
    });
  });

  it("attaches only AFTER the row is recorded, and outside `auditedOperation`", async () => {
    mintable("co_live_abc");
    const order: string[] = [];
    vi.mocked(recordTenantOverrideCoupon).mockImplementation(async (input) => {
      order.push("record");
      return {
        id: "row-1",
        tenantId: input.tenantId,
        mode: input.mode,
        stripeCouponId: input.stripeCouponId,
        grantedBy: input.grantedBy,
        grantedAt: "2026-09-04T00:00:00.000Z",
        removedBy: null,
        removedAt: null,
      };
    });
    vi.mocked(applyTenantDiscount).mockImplementation(async () => {
      order.push("attach");
      return APPLIED;
    });

    await grantTenantPricingOverride(GRANT);

    // mint -> record -> attach. Recording first is what makes the residue of a
    // failed attach nameable: a coupon this console can still find.
    expect(order).toEqual(["record", "attach"]);
    // And the audit row for the mint is written either way, which is what
    // keeping the attach outside `auditedOperation` buys.
    expect(auditRows()).toEqual([
      ["op-1", "billing.tenant.override.mint", `${TENANT} (live) co_live_abc`],
    ]);
  });

  it("carries the whole report back, so a partial fan-out is not rounded to success", async () => {
    mintable("co_live_abc");
    const partial: TenantDiscountResult = {
      ok: true,
      status: "partial",
      requiresReconciliation: true,
      stores: [
        { storeId: "store-1", outcome: "applied" },
        { storeId: "store-2", outcome: "failed", failureReason: "the stripe call failed" },
      ],
    };
    vi.mocked(applyTenantDiscount).mockResolvedValue(partial);

    const result = await grantTenantPricingOverride(GRANT);

    // Verbatim. Summarising it here would decide, in the seam, which of the
    // three facts in it the operator is allowed to see.
    expect(result).toEqual({ ok: true, couponId: "co_live_abc", attach: partial });
  });

  it("is still a successful grant when the attach fails, and says which half did not happen", async () => {
    mintable("co_live_abc");
    const refused: TenantDiscountResult = {
      ok: false,
      message: "The product could not be reached to put this coupon on this tenant's subscriptions.",
    };
    vi.mocked(applyTenantDiscount).mockResolvedValue(refused);

    const result = await grantTenantPricingOverride(GRANT);

    // A failed attach is NOT a failed grant: the coupon exists in a real
    // Stripe account and this console has recorded it. Reporting `ok: false`
    // would deny both, and invite a retry that can only ever refuse on 0047's
    // partial unique index.
    expect(result).toEqual({ ok: true, couponId: "co_live_abc", attach: refused });
  });

  it("does not turn a recorded mint into a failed grant when the attach THROWS", async () => {
    mintable("co_live_abc");
    // The call seam catches everything it can name. This is the case it
    // cannot: a bug in it, or a rejection from the module boundary itself.
    vi.mocked(applyTenantDiscount).mockRejectedValue(new TypeError("headers is not iterable"));

    const result = await grantTenantPricingOverride(GRANT);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.couponId).toBe("co_live_abc");
    expect(result.attach.ok).toBe(false);
    if (result.attach.ok) throw new Error("unreachable");
    // The thrown text is written for a run log and names internals.
    expect(result.attach.message).not.toContain("headers is not iterable");
  });

  it("never asks mark8ly to apply a coupon that was not minted", async () => {
    mintable();
    vi.mocked(stripeCatalogWriter.createCoupon).mockRejectedValue(new Error("connection reset"));

    await grantTenantPricingOverride(GRANT);

    expect(applyTenantDiscount).not.toHaveBeenCalled();
  });

  it("never asks mark8ly to apply a coupon for a refused grant", async () => {
    mintable();

    await grantTenantPricingOverride({ ...GRANT, reason: "   " });

    expect(applyTenantDiscount).not.toHaveBeenCalled();
  });
});

const REVOKE: TenantPricingOverrideRevokeInput = {
  tenantId: TENANT,
  mode: "live",
  reason: "Contract ended; the negotiated rate no longer applies.",
};

/** One live recorded mint, as the repo hands it back. */
function liveRow(couponId: string) {
  return {
    id: "row-1",
    tenantId: TENANT,
    mode: "live" as const,
    stripeCouponId: couponId,
    grantedBy: "op-0",
    grantedAt: "2026-09-04T00:00:00.000Z",
    removedBy: null,
    removedAt: null,
  };
}

/** A tenant with a live override, a retirement that wins, and a Stripe delete
 *  that succeeds. */
function revocable(couponId = "co_live_1") {
  signedIn();
  vi.mocked(readLiveTenantOverrideCoupon).mockResolvedValue(liveRow(couponId));
  vi.mocked(retireTenantOverrideCoupon).mockResolvedValue({
    ...liveRow(couponId),
    removedBy: "op-1",
    removedAt: "2026-09-06T00:00:00.000Z",
  });
  vi.mocked(stripeCatalogWriter.deleteCoupon).mockResolvedValue({ id: couponId });
  vi.mocked(removeTenantDiscount).mockResolvedValue(DETACHED);
}

describe("revoking a tenant pricing override", () => {
  it("retires the row, deletes the coupon, and names it in both halves", async () => {
    revocable("co_live_abc");

    const result = await revokeTenantPricingOverride(REVOKE);

    expect(result).toEqual({
      ok: true,
      couponId: "co_live_abc",
      couponDeleted: true,
      detach: DETACHED,
    });
    expect(retireTenantOverrideCoupon).toHaveBeenCalledWith({
      tenantId: TENANT,
      mode: "live",
      removedBy: "op-1",
    });
    expect(stripeCatalogWriter.deleteCoupon).toHaveBeenCalledWith("live", "co_live_abc");
  });

  it("records the retirement in the console's own audit log, not a removal", async () => {
    revocable("co_live_abc");

    await revokeTenantPricingOverride(REVOKE);

    // `.retire`, not `.revoke`: what this service did is retire its record and
    // delete its object. The discount's actual removal is mark8ly's row.
    expect(auditRows()).toEqual([
      ["op-1", "billing.tenant.override.retire", `${TENANT} (live) co_live_abc`],
    ]);
  });

  it("retires the row BEFORE reaching Stripe, so a Stripe failure cannot block the correction", async () => {
    revocable("co_live_abc");
    const order: string[] = [];
    vi.mocked(retireTenantOverrideCoupon).mockImplementation(async () => {
      order.push("retire");
      return { ...liveRow("co_live_abc"), removedBy: "op-1", removedAt: "2026-09-06T00:00:00.000Z" };
    });
    vi.mocked(stripeCatalogWriter.deleteCoupon).mockImplementation(async () => {
      order.push("delete");
      return { id: "co_live_abc" };
    });

    await revokeTenantPricingOverride(REVOKE);

    expect(order).toEqual(["retire", "delete"]);
  });

  it("reports a retirement whose coupon is still in Stripe as a success that says so", async () => {
    revocable("co_live_abc");
    vi.mocked(stripeCatalogWriter.deleteCoupon).mockRejectedValue(new Error("connection reset"));

    const result = await revokeTenantPricingOverride(REVOKE);

    // The retirement HAPPENED. Reporting total failure here would deny a state
    // change this console made and audited, and would invite a retry that can
    // only ever refuse — there is no live row left to retire.
    expect(result).toEqual({
      ok: true,
      couponId: "co_live_abc",
      couponDeleted: false,
      detach: DETACHED,
    });
  });

  it("still writes the audit row when the Stripe delete fails, because the retirement is what it accounts for", async () => {
    revocable("co_live_abc");
    vi.mocked(stripeCatalogWriter.deleteCoupon).mockRejectedValue(new Error("connection reset"));

    await revokeTenantPricingOverride(REVOKE);

    // This is what the delete being OUTSIDE `auditedOperation` buys: that
    // function writes nothing when its operation throws a non-refusal, so a
    // delete inside it would lose the record of a retirement that happened.
    expect(auditRows()).toEqual([
      ["op-1", "billing.tenant.override.retire", `${TENANT} (live) co_live_abc`],
    ]);
  });

  it("is not defeated by a mode with no Stripe write credential — the row is already retired", async () => {
    revocable("co_live_abc");
    vi.mocked(stripeCatalogWriter.deleteCoupon).mockRejectedValue(
      new StripeWriteUnavailableError("STRIPE_WRITE_KEY_LIVE is unset"),
    );

    const result = await revokeTenantPricingOverride(REVOKE);

    // Fatal on the mint path, where nothing had happened yet. Not fatal here:
    // by the time it is raised the retirement is committed and audited.
    expect(result).toEqual({
      ok: true,
      couponId: "co_live_abc",
      couponDeleted: false,
      detach: DETACHED,
    });
  });

  it("treats an already-deleted coupon as a plain success, adding no handling of its own", async () => {
    revocable("co_live_abc");
    // What `deleteCoupon` does with Stripe's `resource_missing`: it resolves
    // with the id it was given. This seam must not second-guess that — a
    // `couponDeleted: false` here would report a reached goal state as residue.
    vi.mocked(stripeCatalogWriter.deleteCoupon).mockResolvedValue({ id: "co_live_abc" });

    const result = await revokeTenantPricingOverride(REVOKE);

    expect(result).toEqual({
      ok: true,
      couponId: "co_live_abc",
      couponDeleted: true,
      detach: DETACHED,
    });
  });

  it("refuses a tenant with no live override, and touches nothing", async () => {
    signedIn();
    vi.mocked(readLiveTenantOverrideCoupon).mockResolvedValue(null);

    const result = await revokeTenantPricingOverride(REVOKE);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/no live pricing override/i);
    expect(retireTenantOverrideCoupon).not.toHaveBeenCalled();
    expect(stripeCatalogWriter.deleteCoupon).not.toHaveBeenCalled();
  });

  it("refuses when a concurrent revoke won the row, rather than deleting its coupon twice", async () => {
    revocable("co_live_abc");
    // The read saw a live row; the UPDATE's `removed_at IS NULL` did not. The
    // other operator's retirement stands, and this call is not entitled to act
    // on a coupon it did not retire.
    vi.mocked(retireTenantOverrideCoupon).mockResolvedValue(null);

    const result = await revokeTenantPricingOverride(REVOKE);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(stripeCatalogWriter.deleteCoupon).not.toHaveBeenCalled();
  });

  it("demands a reason before anything is read or written", async () => {
    revocable();

    const result = await revokeTenantPricingOverride({ ...REVOKE, reason: "   " });

    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(/why this tenant/i),
      field: "reason",
    });
    expect(readLiveTenantOverrideCoupon).not.toHaveBeenCalled();
    expect(retireTenantOverrideCoupon).not.toHaveBeenCalled();
    expect(stripeCatalogWriter.deleteCoupon).not.toHaveBeenCalled();
  });

  it("never sends the reason to Stripe or stores it — its destination is mark8ly's detach", async () => {
    revocable("co_live_abc");

    await revokeTenantPricingOverride(REVOKE);

    const [retired] = vi.mocked(retireTenantOverrideCoupon).mock.calls[0];
    expect(JSON.stringify(retired)).not.toContain("Contract ended");
    expect(vi.mocked(stripeCatalogWriter.deleteCoupon).mock.calls[0]).toEqual([
      "live",
      "co_live_abc",
    ]);
  });

  it("refuses when `billing` alone is refused", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue({
      sub: "op-3",
      roles: ["publish-catalog"],
    } as never);
    // ONLY `billing`, for the reason the grant's pair of tests states: two
    // checks refused at once pass just as happily with one of them deleted.
    vi.mocked(checkOperatorCapabilityLive).mockImplementation(async (_session, required) => {
      if (required === "billing") throw new CapabilityError("billing");
    });

    const result = await revokeTenantPricingOverride(REVOKE);

    expect(result).toEqual({ ok: false, message: expect.stringMatching(/permission/i) });
    expect(retireTenantOverrideCoupon).not.toHaveBeenCalled();
    expect(stripeCatalogWriter.deleteCoupon).not.toHaveBeenCalled();
  });

  it("refuses when `publish-catalog` alone is refused, and writes capability.refused", async () => {
    vi.mocked(getCurrentSession).mockResolvedValue({ sub: "op-2", roles: ["billing"] } as never);
    vi.mocked(checkOperatorCapabilityLive).mockImplementation(async (_session, required) => {
      if (required === "publish-catalog") throw new CapabilityError("publish-catalog");
    });

    const result = await revokeTenantPricingOverride(REVOKE);

    expect(result).toEqual({ ok: false, message: expect.stringMatching(/permission/i) });
    expect(retireTenantOverrideCoupon).not.toHaveBeenCalled();
    // Inside `auditedOperation`, so the refusal is a row rather than nothing.
    expect(auditRows()).toEqual([["op-2", "capability.refused", `${TENANT} (live)`]]);
  });

  it("never claims nothing happened when the retirement itself failed", async () => {
    revocable("co_live_abc");
    vi.mocked(retireTenantOverrideCoupon).mockRejectedValue(new Error("connection terminated"));

    const result = await revokeTenantPricingOverride(REVOKE);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).not.toMatch(/nothing (was|happened)/i);
    expect(stripeCatalogWriter.deleteCoupon).not.toHaveBeenCalled();
  });
});

describe("the revoke asks mark8ly to take the coupon off", () => {
  it("sends the retired row's coupon, the tenant id WHOLE, the mode and the reason", async () => {
    revocable("co_live_abc");

    await revokeTenantPricingOverride(REVOKE);

    expect(removeTenantDiscount).toHaveBeenCalledWith({
      tenantId: TENANT,
      mode: "live",
      couponId: "co_live_abc",
      reason: REVOKE.reason,
    });
  });

  it("retires, then detaches, then deletes", async () => {
    revocable("co_live_abc");
    const order: string[] = [];
    vi.mocked(retireTenantOverrideCoupon).mockImplementation(async () => {
      order.push("retire");
      return { ...liveRow("co_live_abc"), removedBy: "op-1", removedAt: "2026-09-06T00:00:00.000Z" };
    });
    vi.mocked(removeTenantDiscount).mockImplementation(async () => {
      order.push("detach");
      return DETACHED;
    });
    vi.mocked(stripeCatalogWriter.deleteCoupon).mockImplementation(async () => {
      order.push("delete");
      return { id: "co_live_abc" };
    });

    await revokeTenantPricingOverride(REVOKE);

    // Decision 1 of the plan, and the file's own residue rule: a failed detach
    // leaves an applied discount named by a retired row and by the result,
    // which is recoverable and nameable. Deleting first would leave a live
    // discount whose coupon object no longer exists.
    expect(order).toEqual(["retire", "detach", "delete"]);
  });

  it("reports a failed detach as a success whose detach half did not happen", async () => {
    revocable("co_live_abc");
    const refused: TenantDiscountResult = {
      ok: false,
      message: "The product could not be reached to take this coupon off this tenant's subscriptions.",
    };
    vi.mocked(removeTenantDiscount).mockResolvedValue(refused);

    const result = await revokeTenantPricingOverride(REVOKE);

    // The retirement happened and is audited; the discount may still be on the
    // subscription. Both are true at once, and the result has to carry both.
    expect(result).toEqual({
      ok: true,
      couponId: "co_live_abc",
      couponDeleted: true,
      detach: refused,
    });
  });

  it("still writes the retire audit row when the detach fails", async () => {
    revocable("co_live_abc");
    vi.mocked(removeTenantDiscount).mockResolvedValue({ ok: false, message: "unreachable" });

    await revokeTenantPricingOverride(REVOKE);

    // What keeping the detach outside `auditedOperation` buys, exactly as for
    // the delete beside it: the row for a retirement that genuinely happened
    // is written whatever the two federated steps do.
    expect(auditRows()).toEqual([
      ["op-1", "billing.tenant.override.retire", `${TENANT} (live) co_live_abc`],
    ]);
  });

  it("does not turn a committed retirement into a failure when the detach THROWS", async () => {
    revocable("co_live_abc");
    vi.mocked(removeTenantDiscount).mockRejectedValue(new TypeError("headers is not iterable"));

    const result = await revokeTenantPricingOverride(REVOKE);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.detach.ok).toBe(false);
    if (result.detach.ok) throw new Error("unreachable");
    expect(result.detach.message).not.toContain("headers is not iterable");
    // And the delete still ran: the retirement is committed either way.
    expect(stripeCatalogWriter.deleteCoupon).toHaveBeenCalled();
  });

  it("never asks mark8ly to detach for a tenant it did not retire", async () => {
    signedIn();
    vi.mocked(readLiveTenantOverrideCoupon).mockResolvedValue(null);

    await revokeTenantPricingOverride(REVOKE);

    expect(removeTenantDiscount).not.toHaveBeenCalled();
  });

  it("never asks mark8ly to detach when a concurrent revoke won the row", async () => {
    revocable("co_live_abc");
    vi.mocked(retireTenantOverrideCoupon).mockResolvedValue(null);

    await revokeTenantPricingOverride(REVOKE);

    // The winner's retirement is the one on record, and this call has neither
    // a coupon of its own to delete nor a detach of its own to ask for.
    expect(removeTenantDiscount).not.toHaveBeenCalled();
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
  return `tenant-override:v2:${input.tenantId}:${input.mode}:${terms}:${d.duration}::${input.label}`;
}
