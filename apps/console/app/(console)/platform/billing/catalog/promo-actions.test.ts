import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/promo-codes-repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/promo-codes-repo")>()),
  createPromoCode: vi.fn(),
  updatePromoCode: vi.fn(),
  deactivatePromoCode: vi.fn(),
  readPromoCodeByCode: vi.fn(),
  readStripeCoupons: vi.fn(),
  recordStripeCoupon: vi.fn(),
}));
// `stripeCatalogWriter` alone. `StripeWriteUnavailableError`,
// `StripeCouponTermsError` and `WRITE_KEY_ENV` are the REAL ones — the action
// matches on those classes with `instanceof`, and a hand-rolled stand-in
// would let a renamed class pass a green test while the operator got the
// generic failure message in production.
vi.mock("@/lib/billing/mark8ly/stripe-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/mark8ly/stripe-write")>()),
  stripeCatalogWriter: { createCoupon: vi.fn() },
}));
// Same discipline `actions.test.ts` applies (Ruling 15): `auditedOperation`
// itself is NOT mocked — only its two leaf dependencies — so a passing test
// here is evidence about the real audit control, not about a stand-in.
vi.mock("@/lib/db/tesserix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/tesserix")>()),
  tesserixQuery: vi.fn(),
  isDatabaseConfigured: vi.fn(),
}));

import { getCurrentSession } from "@tesserix/platform-auth";
import { revalidatePath } from "next/cache";
import {
  createPromoCode,
  deactivatePromoCode,
  readPromoCodeByCode,
  readStripeCoupons,
  recordStripeCoupon,
  updatePromoCode,
  type PromoCodeRow,
} from "@/lib/db/promo-codes-repo";
import {
  StripeCouponTermsError,
  StripeWriteUnavailableError,
  stripeCatalogWriter,
  type CreateCouponSpec,
} from "@/lib/billing/mark8ly/stripe-write";
import { isDatabaseConfigured, tesserixQuery } from "@/lib/db/tesserix";
import {
  createPromoCodeAction,
  deactivatePromoCodeAction,
  mintCouponAction,
  updatePromoCodeAction,
} from "./promo-actions";

/**
 * #521 T4's server half.
 *
 * THE MINTING TESTS ASSERT THE REQUEST, not the outcome — the discipline T2's
 * `makeRecordingWriter` establishes and the reason this milestone shipped an
 * 18-day price freeze behind a green suite: a writer stub that returns success
 * unconditionally makes "did it call Stripe correctly?" unaskable. Every test
 * below that reaches Stripe reads the spec the writer was HANDED.
 */

function signIn(roles: readonly string[] | undefined) {
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "operator-1",
    email: "ava@tesserix.app",
    roles,
    iat: 0,
    exp: 0,
  } as never);
}

/** The one write `writeAuditEntry` issues — `[actor, action, target,
 *  occurredAt, metadata]`, per `audit-repo.ts`. */
function lastAuditInsert(): { action: string; target: string | null; summary: unknown } {
  const call = vi.mocked(tesserixQuery).mock.calls.at(-1);
  if (!call) throw new Error("tesserixQuery was never called");
  const [, params] = call;
  const [, action, target, , metadata] = params as [
    string,
    string,
    string | null,
    string,
    string | null,
  ];
  return { action, target, summary: metadata ? JSON.parse(metadata) : null };
}

/** The spec `createCoupon` was handed, or a failure if it was never called. */
function mintedSpec(): { mode: string; spec: CreateCouponSpec; idempotencyKey: string } {
  const call = vi.mocked(stripeCatalogWriter.createCoupon).mock.calls.at(-1);
  if (!call) throw new Error("createCoupon was never called");
  const [mode, spec, idempotencyKey] = call;
  return { mode, spec, idempotencyKey };
}

const DEFINITION: PromoCodeRow = {
  id: "promo-1",
  source: "mark8ly",
  code: "LAUNCH50",
  trialExtensionDays: 30,
  discount: { kind: "percent_off", percentOff: 50, duration: "repeating", durationInMonths: 3 },
  validFrom: "2026-09-01T00:00:00.000Z",
  validUntil: null,
  maxRedemptions: 100,
  isActive: true,
  createdBy: "operator-1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

/** A Postgres constraint violation, in the shape `pg` actually raises: the
 *  constraint's name on the error AND in the message. */
function constraintViolation(constraint: string): Error {
  const error = new Error(
    `error: new row for relation "promo_codes" violates check constraint "${constraint}"`,
  );
  return Object.assign(error, { constraint });
}

const NO_PERMISSION = "You don't have permission to edit promo codes.";
const NO_MINT_PERMISSION = "You don't have permission to mint Stripe coupons.";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_PROVIDER", "zitadel");
  vi.mocked(isDatabaseConfigured).mockReturnValue(true);
  vi.mocked(tesserixQuery).mockResolvedValue([]);
  vi.mocked(readPromoCodeByCode).mockResolvedValue(DEFINITION);
  vi.mocked(readStripeCoupons).mockResolvedValue([]);
  vi.mocked(recordStripeCoupon).mockResolvedValue({
    promoCodeId: "promo-1",
    mode: "test",
    stripeCouponId: "co_123",
    createdBy: "operator-1",
    createdAt: "2026-09-04T00:00:00.000Z",
  });
  vi.mocked(stripeCatalogWriter.createCoupon).mockResolvedValue({ id: "co_123" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------------ *
 * The definition half
 * ------------------------------------------------------------------------ */

describe("createPromoCodeAction", () => {
  it("normalises the code, records both effects, and audits the creation", async () => {
    signIn(["billing"]);
    vi.mocked(createPromoCode).mockResolvedValue(DEFINITION);

    const result = await createPromoCodeAction({
      code: "  launch50 ",
      trialExtensionDays: 30,
      discount: {
        kind: "percent_off",
        percentOff: 50,
        duration: "repeating",
        durationInMonths: 3,
      },
      validFrom: null,
      validUntil: null,
      maxRedemptions: 100,
    });

    expect(result).toEqual({ ok: true });
    expect(createPromoCode).toHaveBeenCalledWith({
      code: "LAUNCH50",
      trialExtensionDays: 30,
      discount: {
        kind: "percent_off",
        percentOff: 50,
        duration: "repeating",
        durationInMonths: 3,
      },
      validFrom: null,
      validUntil: null,
      maxRedemptions: 100,
      createdBy: "operator-1",
    });
    expect(lastAuditInsert()).toEqual({
      action: "billing.promo.create",
      target: "LAUNCH50",
      summary: { created: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/billing/catalog");
  });

  it("refuses without billing, before the repo is touched, and audits the refusal", async () => {
    signIn(undefined);

    const result = await createPromoCodeAction({
      code: "LAUNCH50",
      trialExtensionDays: 30,
      discount: null,
      validFrom: null,
      validUntil: null,
      maxRedemptions: null,
    });

    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(createPromoCode).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(lastAuditInsert()).toEqual({
      action: "capability.refused",
      target: "LAUNCH50",
      summary: { billing: 1 },
    });
  });

  it.each([
    ["promo_codes_code_unique", /That code already exists/],
    ["promo_codes_has_at_least_one_effect", /has to do something/],
    ["promo_codes_discount_months_iff_repeating", /repeating discount needs a month count/],
    ["promo_codes_validity_window_is_ordered", /after its start/],
  ])("answers %s with a sentence written for an operator", async (constraint, expected) => {
    signIn(["billing"]);
    vi.mocked(createPromoCode).mockRejectedValue(constraintViolation(constraint));

    const result = await createPromoCodeAction({
      code: "LAUNCH50",
      trialExtensionDays: null,
      discount: null,
      validFrom: null,
      validUntil: null,
      maxRedemptions: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(expected);
    // The driver's own text — table names, the constraint body — never
    // reaches the operator.
    expect(result.message).not.toMatch(/relation|constraint|promo_codes_/);
  });

  it("degrades an unrecognised failure to the conservative default", async () => {
    signIn(["billing"]);
    vi.mocked(createPromoCode).mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:5432"));

    const result = await createPromoCodeAction({
      code: "LAUNCH50",
      trialExtensionDays: 1,
      discount: null,
      validFrom: null,
      validUntil: null,
      maxRedemptions: null,
    });

    expect(result).toEqual({ ok: false, message: "That change was not saved." });
  });
});

describe("updatePromoCodeAction", () => {
  it("amends only the amendable fields", async () => {
    signIn(["billing"]);
    vi.mocked(updatePromoCode).mockResolvedValue(DEFINITION);

    const result = await updatePromoCodeAction("promo-1", "LAUNCH50", {
      trialExtensionDays: 14,
      maxRedemptions: null,
    });

    expect(result).toEqual({ ok: true });
    expect(updatePromoCode).toHaveBeenCalledWith("promo-1", {
      trialExtensionDays: 14,
      maxRedemptions: null,
    });
    expect(lastAuditInsert()).toEqual({
      action: "billing.promo.update",
      target: "LAUNCH50",
      summary: { updated: 1 },
    });
  });

  it("audits 0 when the update matched nothing, rather than claiming an amendment", async () => {
    signIn(["billing"]);
    vi.mocked(updatePromoCode).mockResolvedValue(null);

    await updatePromoCodeAction("promo-gone", "GONE", { maxRedemptions: 5 });

    expect(lastAuditInsert().summary).toEqual({ updated: 0 });
  });

  it("refuses without billing", async () => {
    signIn(undefined);
    const result = await updatePromoCodeAction("promo-1", "LAUNCH50", { maxRedemptions: 5 });
    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(updatePromoCode).not.toHaveBeenCalled();
  });
});

describe("deactivatePromoCodeAction", () => {
  it("audits the rows the UPDATE actually reported", async () => {
    signIn(["billing"]);
    vi.mocked(deactivatePromoCode).mockResolvedValue([DEFINITION]);

    const result = await deactivatePromoCodeAction("promo-1", "LAUNCH50");

    expect(result).toEqual({ ok: true });
    expect(lastAuditInsert()).toEqual({
      action: "billing.promo.deactivate",
      target: "LAUNCH50",
      summary: { deactivated: 1 },
    });
  });

  it("audits 0 for a second deactivation, which matches nothing", async () => {
    signIn(["billing"]);
    vi.mocked(deactivatePromoCode).mockResolvedValue([]);

    await deactivatePromoCodeAction("promo-1", "LAUNCH50");

    expect(lastAuditInsert().summary).toEqual({ deactivated: 0 });
  });

  it("refuses without billing", async () => {
    signIn(undefined);
    const result = await deactivatePromoCodeAction("promo-1", "LAUNCH50");
    expect(result).toEqual({ ok: false, message: NO_PERMISSION });
    expect(deactivatePromoCode).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------ *
 * Minting — every test here reads the REQUEST
 * ------------------------------------------------------------------------ */

describe("mintCouponAction sends the authored terms to Stripe", () => {
  it("sends the definition's OWN terms, read back server-side, with the code as the name", async () => {
    signIn(["billing", "publish-catalog"]);

    const result = await mintCouponAction("launch50", "test");

    expect(result).toEqual({ ok: true });
    const { mode, spec, idempotencyKey } = mintedSpec();
    expect(mode).toBe("test");
    expect(spec.discount).toEqual({
      kind: "percent_off",
      percentOff: 50,
      duration: "repeating",
      durationInMonths: 3,
    });
    // Without a name the coupon shows in Stripe's dashboard as a bare `co_…`,
    // and there is no later call that could add one.
    expect(spec.name).toBe("LAUNCH50");
    expect(idempotencyKey).toBe("promo-coupon:v1:promo-1:test");
    // The code the operator typed is normalised before the read, so a
    // lower-case one resolves to the same definition.
    expect(readPromoCodeByCode).toHaveBeenCalledWith("LAUNCH50");
  });

  it("does NOT forward the definition's redemption cap — that number is mark8ly's", async () => {
    // `promo_codes.max_redemptions` is the cap mark8ly counts on the CODE,
    // transactionally at signup. Stripe's `max_redemptions` counts a different
    // event in a different system; sending it would create two numbers that
    // must agree with no way to make them. `DEFINITION` carries 100, so a
    // regression that wired them together fails here.
    signIn(["billing", "publish-catalog"]);

    await mintCouponAction("LAUNCH50", "test");

    expect(mintedSpec().spec).not.toHaveProperty("maxRedemptions");
    expect(mintedSpec().spec.maxRedemptions).toBeUndefined();
  });

  it("sends an amount-off with its currency, and no percent-off", async () => {
    signIn(["billing", "publish-catalog"]);
    vi.mocked(readPromoCodeByCode).mockResolvedValue({
      ...DEFINITION,
      discount: {
        kind: "amount_off",
        amountOffMinor: 1500,
        currency: "usd",
        duration: "once",
        durationInMonths: null,
      },
    });

    await mintCouponAction("LAUNCH50", "test");

    expect(mintedSpec().spec.discount).toEqual({
      kind: "amount_off",
      amountOffMinor: 1500,
      currency: "usd",
      duration: "once",
      durationInMonths: null,
    });
  });

  it("mints into the mode it was asked for, and only that one", async () => {
    signIn(["billing", "publish-catalog"]);

    await mintCouponAction("LAUNCH50", "live");

    expect(mintedSpec().mode).toBe("live");
    expect(mintedSpec().idempotencyKey).toBe("promo-coupon:v1:promo-1:live");
    expect(recordStripeCoupon).toHaveBeenCalledWith({
      promoCodeId: "promo-1",
      mode: "live",
      stripeCouponId: "co_123",
      createdBy: "operator-1",
    });
  });

  it("audits the mint with the coupon id and the mode", async () => {
    signIn(["billing", "publish-catalog"]);

    await mintCouponAction("LAUNCH50", "test");

    expect(lastAuditInsert()).toEqual({
      action: "billing.promo.coupon.mint",
      target: "LAUNCH50 (test) co_123",
      summary: { minted: 1, mode_test: 1 },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/platform/billing/catalog");
  });
});

describe("mintCouponAction refuses", () => {
  it("without publish-catalog, even holding billing — and reaches Stripe not at all", async () => {
    signIn(["billing"]);

    const result = await mintCouponAction("LAUNCH50", "test");

    expect(result).toEqual({ ok: false, message: NO_MINT_PERMISSION });
    expect(stripeCatalogWriter.createCoupon).not.toHaveBeenCalled();
    expect(lastAuditInsert()).toEqual({
      action: "capability.refused",
      target: "LAUNCH50 (test)",
      summary: { publish_catalog: 1 },
    });
  });

  it("without billing, which is checked first", async () => {
    signIn(["publish-catalog"]);

    const result = await mintCouponAction("LAUNCH50", "test");

    expect(result).toEqual({ ok: false, message: NO_MINT_PERMISSION });
    expect(lastAuditInsert().summary).toEqual({ billing: 1 });
  });

  it("a second mint in the same mode, WITHOUT creating a second real coupon", async () => {
    // The whole reason `recordStripeCoupon` has no `ON CONFLICT`: the first
    // coupon is live and still redeemable in a real Stripe account, and a
    // second row would orphan it. Reaching Stripe first would create that
    // orphan and only then fail — so the refusal happens on a read.
    signIn(["billing", "publish-catalog"]);
    vi.mocked(readStripeCoupons).mockResolvedValue([
      {
        promoCodeId: "promo-1",
        mode: "test",
        stripeCouponId: "co_existing",
        createdBy: "operator-1",
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ]);

    const result = await mintCouponAction("LAUNCH50", "test");

    expect(stripeCatalogWriter.createCoupon).not.toHaveBeenCalled();
    expect(recordStripeCoupon).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/already has a coupon in that mode/);
    expect(result.message).toMatch(/still redeemable/);
    expect(result.message).not.toMatch(/pkey|duplicate key|Error/);
  });

  it("mints into the OTHER mode while one mode is already minted", async () => {
    signIn(["billing", "publish-catalog"]);
    vi.mocked(readStripeCoupons).mockResolvedValue([
      {
        promoCodeId: "promo-1",
        mode: "test",
        stripeCouponId: "co_existing",
        createdBy: "operator-1",
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ]);

    const result = await mintCouponAction("LAUNCH50", "live");

    expect(result).toEqual({ ok: true });
    expect(mintedSpec().mode).toBe("live");
  });

  it("answers the primary key with the same sentence, for the race the read cannot close", async () => {
    signIn(["billing", "publish-catalog"]);
    vi.mocked(recordStripeCoupon).mockRejectedValue(
      Object.assign(
        new Error(
          'duplicate key value violates unique constraint "promo_code_stripe_coupons_pkey"',
        ),
        { constraint: "promo_code_stripe_coupons_pkey" },
      ),
    );

    const result = await mintCouponAction("LAUNCH50", "test");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/already has a coupon in that mode/);
  });

  it("a definition that extends the trial only — there is nothing to mint", async () => {
    signIn(["billing", "publish-catalog"]);
    vi.mocked(readPromoCodeByCode).mockResolvedValue({ ...DEFINITION, discount: null });

    const result = await mintCouponAction("EXTRA30", "test");

    expect(stripeCatalogWriter.createCoupon).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/extends the trial only/);
  });

  it("a code that no longer exists", async () => {
    signIn(["billing", "publish-catalog"]);
    vi.mocked(readPromoCodeByCode).mockResolvedValue(null);

    const result = await mintCouponAction("GONE", "test");

    expect(stripeCatalogWriter.createCoupon).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, message: "That code no longer exists." });
  });
});

describe("mintCouponAction and the missing test-mode write key (#540)", () => {
  it("names WHICH mode has no credential, and which variable holds it", async () => {
    // `STRIPE_WRITE_KEY_TEST` is not set in this estate, so a test-mode mint
    // fails at the credential every time. An operator told only "that did not
    // work" has no way to learn that live would have succeeded.
    signIn(["billing", "publish-catalog"]);
    vi.mocked(stripeCatalogWriter.createCoupon).mockRejectedValue(
      new StripeWriteUnavailableError(
        "STRIPE_WRITE_KEY_TEST is not set; the catalog bootstrap cannot write test mode Stripe objects",
      ),
    );

    const result = await mintCouponAction("LAUNCH50", "test");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("test mode");
    expect(result.message).toContain("STRIPE_WRITE_KEY_TEST");
    // And it says the definition survived, so nobody re-authors it.
    expect(result.message).toMatch(/definition is saved/);
    expect(recordStripeCoupon).not.toHaveBeenCalled();
  });

  it("names the LIVE variable when live is the mode that cannot be written", async () => {
    signIn(["billing", "publish-catalog"]);
    vi.mocked(stripeCatalogWriter.createCoupon).mockRejectedValue(
      new StripeWriteUnavailableError("STRIPE_WRITE_KEY_LIVE is not set"),
    );

    const result = await mintCouponAction("LAUNCH50", "live");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("STRIPE_WRITE_KEY_LIVE");
    expect(result.message).not.toContain("STRIPE_WRITE_KEY_TEST");
  });

  it("says something DIFFERENT for terms Stripe cannot mint — a misconfigured console is not a bad definition", async () => {
    signIn(["billing", "publish-catalog"]);
    vi.mocked(stripeCatalogWriter.createCoupon).mockRejectedValue(
      new StripeCouponTermsError("createCoupon was given duration 'forever' with durationInMonths 3"),
    );

    const result = await mintCouponAction("LAUNCH50", "test");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/not something Stripe can mint/);
    expect(result.message).not.toContain("STRIPE_WRITE_KEY");
  });

  it("never claims nothing happened when the failure is ambiguous", async () => {
    // A failure between `createCoupon` and `recordStripeCoupon` leaves a live
    // coupon this database does not name. The message sends the operator to
    // the place that knows.
    signIn(["billing", "publish-catalog"]);
    vi.mocked(recordStripeCoupon).mockRejectedValue(new Error("ECONNRESET"));

    const result = await mintCouponAction("LAUNCH50", "test");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/Check the Stripe dashboard/);
    expect(result.message).not.toMatch(/nothing (was )?(saved|minted)/i);
  });
});
