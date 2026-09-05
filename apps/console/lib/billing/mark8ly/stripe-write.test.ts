import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The write-side twin of `../stripe-read.ts`: the console's ONLY way to
 * CREATE Products and Prices, in either Stripe mode.
 *
 * # Why this exists, and why it stays this small
 *
 * Task B (the bootstrap runner) needs somewhere to call `createProduct` and
 * `createPrice` from — this module IS that somewhere, and nothing more. The
 * same four guarantees `stripe-read.ts` carries apply here, doubled: a write
 * client that leaks its `Stripe` instance, or accepts a key for the wrong
 * mode, does not read the wrong account — it WRITES to it.
 *
 *  - Exactly eight methods, named individually, so a ninth cannot arrive
 *    quietly. (This sentence read "four" until 2026-09-06, four methods after
 *    that stopped being true. The count that matters is the one the first
 *    test below asserts — it is the only copy that goes stale loudly.)
 *  - The `Stripe` instances are module-private and never returned.
 *  - A key whose prefix contradicts its mode is refused before any request —
 *    the read-side version of this mistake cost an hour on 2026-08-27 and
 *    produced a report claiming all 42 prices were missing; the write-side
 *    version creates 42 prices in the wrong account.
 *  - Idempotency keys are the CALLER's job. This module never mints one — it
 *    only forwards what it is given as a Stripe request option.
 */

const stripeMock = vi.hoisted(() => {
  const pricesCreate = vi.fn();
  const pricesUpdate = vi.fn();
  const productsList = vi.fn();
  const productsCreate = vi.fn();
  const couponsCreate = vi.fn();
  const couponsDel = vi.fn();
  const constructedWith: Array<{ key: string; config: unknown }> = [];
  return {
    pricesCreate,
    pricesUpdate,
    productsList,
    productsCreate,
    couponsCreate,
    couponsDel,
    constructedWith,
  };
});

vi.mock("stripe", () => ({
  default: class FakeStripe {
    readonly prices = { create: stripeMock.pricesCreate, update: stripeMock.pricesUpdate };
    readonly products = { list: stripeMock.productsList, create: stripeMock.productsCreate };
    readonly coupons = { create: stripeMock.couponsCreate, del: stripeMock.couponsDel };
    constructor(key: string, config: unknown) {
      stripeMock.constructedWith.push({ key, config });
    }
  },
}));

import {
  stripeCatalogWriter,
  StripeCouponTermsError,
  StripeWriteUnavailableError,
  WRITE_KEY_ENV,
} from "./stripe-write";
import type { CreateCouponSpec, CreatePriceSpec } from "./stripe-write";
import type { PromoCodeDiscount } from "@/lib/db/promo-codes-repo";

/** Every page the fake `products.list` hands back, as `autoPagingToArray`
 *  would return them. */
function productPagesOf(...products: unknown[]) {
  return { autoPagingToArray: vi.fn(async () => products) };
}

const baseSpec: CreatePriceSpec = {
  productId: "prod_x",
  lookupKey: "mark8ly_pro_monthly_developed_v1",
  currency: "usd",
  unitAmount: 100,
  period: "monthly",
  taxBehavior: "unspecified",
  currencyOptions: {
    usd: { unitAmount: 100, taxBehavior: "unspecified" },
    gbp: { unitAmount: 90, taxBehavior: "unspecified" },
  },
  idempotencyKey: "k1",
};

beforeEach(() => {
  vi.clearAllMocks();
  stripeMock.constructedWith.length = 0;
  vi.stubEnv("STRIPE_WRITE_KEY_TEST", "sk_test_writekey");
  vi.stubEnv("STRIPE_WRITE_KEY_LIVE", "sk_live_writekey");
  stripeMock.productsCreate.mockResolvedValue({ id: "prod_new" });
  stripeMock.pricesCreate.mockResolvedValue({ id: "price_new", currency_options: {} });
  stripeMock.pricesUpdate.mockResolvedValue({ id: "price_updated" });
  stripeMock.productsList.mockReturnValue(productPagesOf());
  stripeMock.couponsCreate.mockResolvedValue({ id: "co_new" });
  // What `coupons.del` actually resolves to: Stripe's `DeletedCoupon`, which
  // is the id, the object type and `deleted: true` — not the Coupon.
  stripeMock.couponsDel.mockResolvedValue({ id: "co_new", object: "coupon", deleted: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("exposes exactly eight methods, named individually so this fails on the next change", () => {
  // Named individually, not counted, so this fails on the NEXT method added
  // rather than merely on a count changing — see the module header.
  // `updatePriceCurrencyOptions` is deliberately absent: §1.6a proved an
  // existing currency's amount is immutable, so no such method can exist.
  expect(Object.keys(stripeCatalogWriter).sort()).toEqual([
    "addCurrencyOption",
    "archivePrice",
    "createCoupon",
    "createPrice",
    "createProduct",
    "deleteCoupon",
    "findProductByPlan",
    "updatePriceTaxBehavior",
  ]);
});

it("never returns the underlying Stripe instance", () => {
  for (const v of Object.values(stripeCatalogWriter)) expect(typeof v).toBe("function");
});

it("fails clearly when the mode's key is absent", async () => {
  vi.stubEnv("STRIPE_WRITE_KEY_TEST", "");
  await expect(stripeCatalogWriter.findProductByPlan("test", "pro", "mark8ly")).rejects.toThrow(
    /STRIPE_WRITE_KEY_TEST/,
  );
});

it("fails with StripeWriteUnavailableError, not a bare Error", async () => {
  vi.stubEnv("STRIPE_WRITE_KEY_TEST", "");
  await expect(stripeCatalogWriter.findProductByPlan("test", "pro", "mark8ly")).rejects.toThrow(
    StripeWriteUnavailableError,
  );
});

it("refuses a key whose prefix contradicts its mode", async () => {
  // The read-side version of this mistake cost an hour on 2026-08-27 and
  // produced a report claiming all 42 prices were missing. The WRITE-side
  // version creates 42 prices in the wrong account.
  vi.stubEnv("STRIPE_WRITE_KEY_TEST", ["sk", "live", "abc123"].join("_"));
  await expect(stripeCatalogWriter.findProductByPlan("test", "pro", "mark8ly")).rejects.toThrow(/mode/i);
});

it("reads a separate environment variable per mode", () => {
  expect(WRITE_KEY_ENV).toEqual({
    test: "STRIPE_WRITE_KEY_TEST",
    live: "STRIPE_WRITE_KEY_LIVE",
  });
});

describe("findProductByPlan", () => {
  it("finds an existing product by metadata.plan rather than a stored id", async () => {
    // mark8ly's own design: CreateProduct sets metadata[plan] "so subsequent
    // FindProductByMetadata lookups succeed without storing the Stripe ID
    // locally". The catalog holds `plan`; it holds no product id.
    stripeMock.productsList.mockReturnValue(
      productPagesOf(
        { id: "prod_other", metadata: { plan: "starter" } },
        { id: "prod_pro", metadata: { plan: "pro" } },
      ),
    );

    const found = await stripeCatalogWriter.findProductByPlan("test", "pro", "mark8ly");

    expect(found).toEqual({ id: "prod_pro" });
    expect(stripeMock.productsList).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, limit: 100 }),
    );
  });

  it("returns null, not a thrown error, when no product matches", async () => {
    // The console has no `ErrNotFound` idiom; `null` is the local one.
    stripeMock.productsList.mockReturnValue(
      productPagesOf({ id: "prod_other", metadata: { plan: "starter" } }),
    );

    const found = await stripeCatalogWriter.findProductByPlan("test", "pro", "mark8ly");

    expect(found).toBeNull();
  });
});

describe("findProductByPlan is scoped by source", () => {
  /**
   * THE BUG THIS FIXES. `plan` alone was the match key, which is unique
   * only while there is exactly one source. With two, a second source's
   * "pro" resolved to MARK8LY's Pro Product and its Prices would have been
   * attached there. Stripe has no product-merge.
   */
  it("does not hand one source's Product to another source", async () => {
    stripeMock.productsList.mockReturnValue(
      productPagesOf({ id: "prod_mark8ly_pro", metadata: { plan: "pro", source: "mark8ly" } }),
    );

    // Cast past the union: `kora` is not a CatalogSource yet, and the whole
    // point is that this must already be safe BEFORE one exists — by then
    // the damage would be Prices on the wrong Product.
    const found = await stripeCatalogWriter.findProductByPlan(
      "test",
      "pro",
      "kora" as never,
    );

    expect(found).toBeNull();
  });

  it("matches when plan and source both agree", async () => {
    stripeMock.productsList.mockReturnValue(
      productPagesOf(
        { id: "prod_other_pro", metadata: { plan: "pro", source: "kora" } },
        { id: "prod_mark8ly_pro", metadata: { plan: "pro", source: "mark8ly" } },
      ),
    );

    expect(await stripeCatalogWriter.findProductByPlan("test", "pro", "mark8ly")).toEqual({
      id: "prod_mark8ly_pro",
    });
  });

  /**
   * Every Product that exists today predates `metadata.source` — the three
   * in the live account were created by hand on 2026-08-28. Refusing them
   * would not fail safe: the next publish would create DUPLICATE Products
   * beside the ones already carrying live Prices.
   */
  it("still resolves an untagged Product for the single source that could have created it", async () => {
    stripeMock.productsList.mockReturnValue(
      productPagesOf({ id: "prod_legacy_pro", metadata: { plan: "pro" } }),
    );

    expect(await stripeCatalogWriter.findProductByPlan("test", "pro", "mark8ly")).toEqual({
      id: "prod_legacy_pro",
    });
  });

  /**
   * ...and the compatibility branch must not become the hole the fix was
   * closing. An untagged Product is claimable ONLY by the source that could
   * have made it; a newcomer inherits nothing.
   */
  it("refuses to let a second source claim an untagged Product", async () => {
    stripeMock.productsList.mockReturnValue(
      productPagesOf({ id: "prod_legacy_pro", metadata: { plan: "pro" } }),
    );

    expect(
      await stripeCatalogWriter.findProductByPlan("test", "pro", "kora" as never),
    ).toBeNull();
  });

  it("prefers an exactly-tagged Product over an untagged one with the same plan", async () => {
    stripeMock.productsList.mockReturnValue(
      productPagesOf(
        { id: "prod_legacy_pro", metadata: { plan: "pro" } },
        { id: "prod_tagged_pro", metadata: { plan: "pro", source: "mark8ly" } },
      ),
    );

    expect(await stripeCatalogWriter.findProductByPlan("test", "pro", "mark8ly")).toEqual({
      id: "prod_tagged_pro",
    });
  });
});

describe("createProduct", () => {
  it("names the product from the SOURCE's brand and tags both plan and source", async () => {
    await stripeCatalogWriter.createProduct("test", "pro", "mark8ly", "product:v1:pro");

    // `metadata.source` is the half that was missing. Without it
    // `findProductByPlan` cannot tell two sources' "pro" apart, and the
    // brand came from a hardcoded template rather than the source.
    expect(stripeMock.productsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Mark8ly pro",
        metadata: { plan: "pro", source: "mark8ly" },
      }),
      { idempotencyKey: "product:v1:pro" },
    );
  });

  it("returns only the id, not the raw SDK object", async () => {
    stripeMock.productsCreate.mockResolvedValue({
      id: "prod_new",
      name: "Mark8ly pro",
      metadata: { plan: "pro" },
    });

    const created = await stripeCatalogWriter.createProduct("test", "pro", "mark8ly", "product:v1:pro");

    expect(created).toEqual({ id: "prod_new" });
  });
});

describe("createPrice", () => {
  it("never puts the baseline currency inside currency_options", async () => {
    // Stripe REJECTS the call outright. This exact rejection stuck a mark8ly
    // bootstrap run and is why its idempotency key is at v3.
    await stripeCatalogWriter.createPrice("test", baseSpec);

    const params = stripeMock.pricesCreate.mock.calls[0][0];
    expect(Object.keys(params.currency_options)).toEqual(["gbp"]);
  });

  it("derives the interval from the period, not from a stored field", async () => {
    // `annual` -> `year`, else `month`. Mirrors mark8ly's price.go:53-55.
    await stripeCatalogWriter.createPrice("test", { ...baseSpec, period: "annual" });

    const params = stripeMock.pricesCreate.mock.calls[0][0];
    expect(params.recurring.interval).toBe("year");
  });

  it("derives a monthly interval for anything that isn't annual", async () => {
    await stripeCatalogWriter.createPrice("test", { ...baseSpec, period: "monthly" });

    const params = stripeMock.pricesCreate.mock.calls[0][0];
    expect(params.recurring.interval).toBe("month");
  });

  it("sends tax_behavior on create, from the spec", async () => {
    // The catalog is the authority.
    await stripeCatalogWriter.createPrice("test", { ...baseSpec, taxBehavior: "exclusive" });

    const params = stripeMock.pricesCreate.mock.calls[0][0];
    expect(params.tax_behavior).toBe("exclusive");
  });

  it("sends each currency option's own tax_behavior, not just the Price's", async () => {
    // The catalog's `aud` rows are all `exclusive` while every other one of
    // the 78 rows is `unspecified` — a Price-level tax_behavior cannot
    // express this. `../parity.ts`'s `coverageOf` reads
    // `currency_options[cur].tax_behavior` per currency, so a missing value
    // here reports as a permanent `tax_behavior_mismatch` against `aud`.
    await stripeCatalogWriter.createPrice("test", {
      ...baseSpec,
      currencyOptions: {
        aud: { unitAmount: 150, taxBehavior: "exclusive" },
        gbp: { unitAmount: 90, taxBehavior: "unspecified" },
      },
    });

    const params = stripeMock.pricesCreate.mock.calls[0][0];
    expect(params.currency_options).toEqual({
      aud: { unit_amount: 150, tax_behavior: "exclusive" },
      gbp: { unit_amount: 90, tax_behavior: "unspecified" },
    });
  });

  it("passes the idempotency key through as a request option, never minting one", async () => {
    await stripeCatalogWriter.createPrice("test", { ...baseSpec, idempotencyKey: "caller:k9" });

    const options = stripeMock.pricesCreate.mock.calls[0][1];
    expect(options).toEqual({ idempotencyKey: "caller:k9" });
  });

  it("returns only the created price's id", async () => {
    stripeMock.pricesCreate.mockResolvedValue({ id: "price_abc", currency_options: {} });

    const created = await stripeCatalogWriter.createPrice("test", baseSpec);

    expect(created).toEqual({ id: "price_abc" });
  });
});

describe("addCurrencyOption", () => {
  it("updates currency_options[currency].unit_amount on an existing price", async () => {
    await stripeCatalogWriter.addCurrencyOption("test", "price_abc", "eur", 500, "opt:v1:eur");

    expect(stripeMock.pricesUpdate).toHaveBeenCalledWith(
      "price_abc",
      { currency_options: { eur: { unit_amount: 500 } } },
      { idempotencyKey: "opt:v1:eur" },
    );
  });

  it("returns only the updated price's id", async () => {
    stripeMock.pricesUpdate.mockResolvedValue({ id: "price_abc" });

    const updated = await stripeCatalogWriter.addCurrencyOption(
      "test",
      "price_abc",
      "eur",
      500,
      "opt:v1:eur",
    );

    expect(updated).toEqual({ id: "price_abc" });
  });
});

describe("archivePrice", () => {
  it("sets active: false on the price id it is given, not one it looks up", async () => {
    // §1.3: the archived price keeps `active: true` semantics for lookup
    // purposes until archived, and loses its `lookup_key` once archived — so
    // resolving by lookup key AT archive time would resolve to the price
    // that just replaced it. The caller must capture the old id before
    // creating the replacement; this method must not re-derive it.
    await stripeCatalogWriter.archivePrice("test", "price_old", "archive:v1:price_old");

    expect(stripeMock.pricesUpdate).toHaveBeenCalledWith(
      "price_old",
      { active: false },
      { idempotencyKey: "archive:v1:price_old" },
    );
  });

  it("returns only the archived price's id", async () => {
    stripeMock.pricesUpdate.mockResolvedValue({ id: "price_old", active: false });

    const archived = await stripeCatalogWriter.archivePrice(
      "test",
      "price_old",
      "archive:v1:price_old",
    );

    expect(archived).toEqual({ id: "price_old" });
  });
});

describe("updatePriceTaxBehavior", () => {
  it("sends tax_behavior as the sole field being changed", async () => {
    // §1.4: unspecified -> a value is accepted, and only once. This method
    // does not enforce the one-way rule itself — Stripe does, by rejecting
    // the second call — but it must send nothing else that could smuggle in
    // an amount change alongside it.
    await stripeCatalogWriter.updatePriceTaxBehavior(
      "test",
      "price_abc",
      "exclusive",
      "taxbehavior:v1:price_abc",
    );

    expect(stripeMock.pricesUpdate).toHaveBeenCalledWith(
      "price_abc",
      { tax_behavior: "exclusive" },
      { idempotencyKey: "taxbehavior:v1:price_abc" },
    );
  });

  it("returns only the updated price's id", async () => {
    stripeMock.pricesUpdate.mockResolvedValue({ id: "price_abc", tax_behavior: "exclusive" });

    const updated = await stripeCatalogWriter.updatePriceTaxBehavior(
      "test",
      "price_abc",
      "exclusive",
      "taxbehavior:v1:price_abc",
    );

    expect(updated).toEqual({ id: "price_abc" });
  });
});

/* ------------------------------------------------------------------------ *
 * createCoupon — every assertion here is on the REQUEST
 * ------------------------------------------------------------------------ */

/**
 * WHY THESE READ THE PAYLOAD AND NOT THE RETURN VALUE.
 *
 * `stripeMock.couponsCreate` resolves successfully whatever it is handed, so
 * a test that asserted on the returned `{ id }` would pass against a request
 * Stripe rejects outright. That is not hypothetical here: a missing
 * `transfer_lookup_key` on `prices.create` survived this suite green and made
 * every price change impossible for 18 days, because the plan, the ordering
 * and the operation log were all right and the only wrong thing was a field
 * in the payload no test looked at. Every assertion below reads
 * `couponsCreate.mock.calls[0]`.
 */
const percentOff: PromoCodeDiscount = {
  kind: "percent_off",
  percentOff: 25,
  duration: "forever",
  durationInMonths: null,
};

const amountOff: PromoCodeDiscount = {
  kind: "amount_off",
  amountOffMinor: 1500,
  currency: "usd",
  duration: "once",
  durationInMonths: null,
};

/** The params object handed to `coupons.create` on the first (and only) call. */
function couponParams(): Record<string, unknown> {
  expect(stripeMock.couponsCreate).toHaveBeenCalledTimes(1);
  return stripeMock.couponsCreate.mock.calls[0][0] as Record<string, unknown>;
}

async function createCoupon(spec: CreateCouponSpec, key = "coupon:v1:k1") {
  return stripeCatalogWriter.createCoupon("test", spec, key);
}

describe("createCoupon sends the discount shape Stripe names", () => {
  it("sends percent_off for a percent-off discount, and NEITHER amount_off nor a currency", async () => {
    // Stripe refuses a Coupon carrying both amounts. A currency alongside a
    // percentage is worse than refused — 0046's
    // `promo_codes_discount_currency_accompanies_amount_off` exists because a
    // percentage with a currency reads as a currency-scoped discount on every
    // surface that renders it, and is not one.
    await createCoupon({ discount: percentOff });

    const params = couponParams();
    expect(params.percent_off).toBe(25);
    expect(params).not.toHaveProperty("amount_off");
    expect(params).not.toHaveProperty("currency");
  });

  it("sends amount_off WITH its currency, and no percent_off", async () => {
    // The mirror. An amount without a currency is an amount in no unit;
    // Stripe requires the pair.
    await createCoupon({ discount: amountOff });

    const params = couponParams();
    expect(params.amount_off).toBe(1500);
    expect(params.currency).toBe("usd");
    expect(params).not.toHaveProperty("percent_off");
  });

  it("sends the authored duration through untouched", async () => {
    await createCoupon({ discount: { ...percentOff, duration: "once" } });

    expect(couponParams().duration).toBe("once");
  });
});

describe("createCoupon and duration_in_months", () => {
  it("carries duration_in_months for a repeating discount", async () => {
    // The field Stripe REQUIRES for `repeating`. Dropping it does not produce
    // a quiet wrong answer — the create fails — but it fails at publish time,
    // against a live account, for whoever is publishing.
    await createCoupon({
      discount: { ...percentOff, duration: "repeating", durationInMonths: 3 },
    });

    const params = couponParams();
    expect(params.duration).toBe("repeating");
    expect(params.duration_in_months).toBe(3);
  });

  it("omits duration_in_months for 'once'", async () => {
    // Stripe REJECTS the field on a non-repeating coupon, so sending it is
    // not harmlessly redundant.
    await createCoupon({ discount: { ...amountOff, duration: "once" } });

    expect(couponParams()).not.toHaveProperty("duration_in_months");
  });

  it("omits duration_in_months for 'forever'", async () => {
    await createCoupon({ discount: { ...percentOff, duration: "forever" } });

    expect(couponParams()).not.toHaveProperty("duration_in_months");
  });

  it("refuses 'repeating' with no month count rather than sending a create Stripe will reject", async () => {
    await expect(
      createCoupon({ discount: { ...percentOff, duration: "repeating", durationInMonths: null } }),
    ).rejects.toThrow(StripeCouponTermsError);

    expect(stripeMock.couponsCreate).not.toHaveBeenCalled();
  });

  it("refuses a month count on a non-repeating discount rather than dropping it silently", async () => {
    // THE DANGEROUS DIRECTION. An operator who authored "3 months at 25% off"
    // against a `forever` duration would otherwise get a successful create
    // and a PERMANENT discount in a live account, with nothing anywhere
    // reading as wrong.
    await expect(
      createCoupon({ discount: { ...percentOff, duration: "forever", durationInMonths: 3 } }),
    ).rejects.toThrow(/month count/);

    expect(stripeMock.couponsCreate).not.toHaveBeenCalled();
  });
});

describe("createCoupon refuses a definition with no discount terms", () => {
  /**
   * THE RULE THE DATABASE CANNOT ENFORCE. 0046's closing paragraph states it
   * outright: nothing in Postgres refuses a `promo_code_stripe_coupons` row
   * against a definition carrying no terms, because a cross-table CHECK is
   * not expressible. It does not need to be, as long as a terms-less
   * definition can never obtain a `co_...` to record — and this method is the
   * only place one comes from.
   *
   * The type system carries the first half: `PromoCodeRow.discount` is
   * `PromoCodeDiscount | null` and {@link CreateCouponSpec.discount} is not
   * nullable, so a caller that has not narrowed the null does not compile.
   * The cast below is what that leaves, and it is exactly what a caller in a
   * hurry reaches for.
   */
  it("throws, and makes no Stripe call at all, when the terms are absent", async () => {
    await expect(
      createCoupon({ discount: null as unknown as PromoCodeDiscount }),
    ).rejects.toThrow(StripeCouponTermsError);

    expect(stripeMock.couponsCreate).not.toHaveBeenCalled();
  });

  it("says a trial-extension-only definition has nothing to mint, not something generic", async () => {
    // The operator reading this is looking at a code that works. The message
    // has to say why it has no coupon rather than that something failed.
    await expect(
      createCoupon({ discount: undefined as unknown as PromoCodeDiscount }),
    ).rejects.toThrow(/extends the trial only/);
  });
});

describe("createCoupon passes through what it is given, and nothing it was not", () => {
  it("passes the idempotency key as a request option, never minting one", async () => {
    await createCoupon({ discount: percentOff }, "coupon:v1:LAUNCH25:test");

    expect(stripeMock.couponsCreate.mock.calls[0][1]).toEqual({
      idempotencyKey: "coupon:v1:LAUNCH25:test",
    });
  });

  it("forwards a name and Stripe's own redemption cap when the caller supplies them", async () => {
    // `maxRedemptions` here is STRIPE's cap on the Coupon. It is not
    // `promo_codes.max_redemptions`, which 0046 keeps out of the terms
    // deliberately: that one is the cap mark8ly enforces on the CODE, counted
    // transactionally at signup, and the two count different events.
    await createCoupon({ discount: percentOff, name: "LAUNCH25", maxRedemptions: 50 });

    const params = couponParams();
    expect(params.name).toBe("LAUNCH25");
    expect(params.max_redemptions).toBe(50);
  });

  it("omits name and max_redemptions entirely when they are not supplied", async () => {
    // Not sent as null. An absent `max_redemptions` is uncapped, which is
    // what the caller declining to set one means.
    await createCoupon({ discount: percentOff });

    const params = couponParams();
    expect(params).not.toHaveProperty("name");
    expect(params).not.toHaveProperty("max_redemptions");
  });

  it("returns only the created coupon's id, not the raw SDK object", async () => {
    stripeMock.couponsCreate.mockResolvedValue({
      id: "co_abc",
      percent_off: 25,
      livemode: false,
      valid: true,
    });

    expect(await createCoupon({ discount: percentOff })).toEqual({ id: "co_abc" });
  });
});
/* ------------------------------------------------------------------------ *
 * deleteCoupon
 * ------------------------------------------------------------------------ */

/**
 * A Stripe API error as the SDK hands it to a caller: an `Error` carrying the
 * structured `code` field Stripe documents. `deleteCoupon` discriminates on
 * that field and on nothing else — not on the class (every
 * `invalid_request_error` shares one) and not on the message text.
 */
function stripeApiError(code: string | undefined, message: string): Error {
  const error = new Error(message);
  return Object.assign(error, { type: "StripeInvalidRequestError", code });
}

describe("deleteCoupon", () => {
  it("deletes the coupon id it is given", async () => {
    await stripeCatalogWriter.deleteCoupon("test", "co_abc");

    expect(stripeMock.couponsDel).toHaveBeenCalledWith("co_abc");
  });

  it("sends NO idempotency key, because Stripe accepts one on POST only", async () => {
    // Every other method on this surface takes one and forwards it. This is a
    // DELETE, and Stripe's idempotency layer covers POST requests; sending
    // one here would be a request option Stripe has no use for. Asserted
    // rather than left implicit so a later "consistency" edit that adds one
    // has to argue with a test.
    await stripeCatalogWriter.deleteCoupon("test", "co_abc");

    expect(stripeMock.couponsDel.mock.calls[0]).toEqual(["co_abc"]);
  });

  it("returns only the id, not the raw SDK object", async () => {
    stripeMock.couponsDel.mockResolvedValue({
      id: "co_abc",
      object: "coupon",
      deleted: true,
    });

    expect(await stripeCatalogWriter.deleteCoupon("test", "co_abc")).toEqual({ id: "co_abc" });
  });

  it("treats an ALREADY-DELETED coupon as success, not failure", async () => {
    // Stripe raises `resource_missing` for a coupon that is not there. The
    // goal state — this coupon can never be redeemed again — holds either
    // way, and a caller that retires its own row first (the revoke path)
    // would otherwise be stranded behind a step that can never pass.
    stripeMock.couponsDel.mockRejectedValue(
      stripeApiError("resource_missing", "No such coupon: 'co_gone'"),
    );

    expect(await stripeCatalogWriter.deleteCoupon("test", "co_gone")).toEqual({ id: "co_gone" });
  });

  it("returns the id it was GIVEN when the coupon was already deleted", async () => {
    // There is no response body to read an id off in that case, so the id
    // comes from the argument. It is the same id either way, which is what
    // makes the two paths' return values interchangeable to a caller.
    stripeMock.couponsDel.mockRejectedValue(
      stripeApiError("resource_missing", "No such coupon: 'co_gone'"),
    );

    const deleted = await stripeCatalogWriter.deleteCoupon("live", "co_gone");

    expect(deleted.id).toBe("co_gone");
  });

  it("propagates a Stripe error whose code is NOT resource_missing", async () => {
    // The half that must not be swallowed. An auth failure means the console
    // deleted nothing and does not know it; reporting success would let a
    // caller retire a row against a coupon still live in the account.
    stripeMock.couponsDel.mockRejectedValue(
      stripeApiError("api_key_expired", "Expired API Key provided"),
    );

    await expect(stripeCatalogWriter.deleteCoupon("test", "co_abc")).rejects.toThrow(
      /Expired API Key/,
    );
  });

  it("propagates an error carrying no code at all", async () => {
    // A network failure, or anything else that is not a structured Stripe API
    // error. Nothing about it says the coupon is gone.
    stripeMock.couponsDel.mockRejectedValue(new Error("socket hang up"));

    await expect(stripeCatalogWriter.deleteCoupon("test", "co_abc")).rejects.toThrow(
      /socket hang up/,
    );
  });

  it("does not match on the message text of an error with a different code", async () => {
    // The failure this guards against is a discriminator that greps English:
    // a message mentioning "No such coupon" on an error Stripe did NOT code
    // `resource_missing` is not the already-deleted case.
    stripeMock.couponsDel.mockRejectedValue(
      stripeApiError("rate_limit", "No such coupon: 'co_abc' (rate limited)"),
    );

    await expect(stripeCatalogWriter.deleteCoupon("test", "co_abc")).rejects.toThrow(/rate limited/);
  });

  it("fails with StripeWriteUnavailableError, before any delete, when the mode's key is absent", async () => {
    vi.stubEnv("STRIPE_WRITE_KEY_TEST", "");

    await expect(stripeCatalogWriter.deleteCoupon("test", "co_abc")).rejects.toThrow(
      StripeWriteUnavailableError,
    );
    expect(stripeMock.couponsDel).not.toHaveBeenCalled();
  });
});

// No per-mode key test here: `mode isolation` below already asserts it, and
// the module's client cache is keyed on (mode, key) and outlives a single
// test file's `beforeEach` — a second call that constructs the live client
// leaves the later test with nothing new constructed to observe. Adding one
// here turned that test red, which is the cache working as designed.

describe("mode isolation", () => {
  it("never reaches the other mode's key", async () => {
    vi.stubEnv("STRIPE_WRITE_KEY_TEST", "sk_test_aaa");
    vi.stubEnv("STRIPE_WRITE_KEY_LIVE", "sk_live_bbb");

    await stripeCatalogWriter.findProductByPlan("live", "pro", "mark8ly");

    expect(stripeMock.constructedWith.map((c) => c.key)).toEqual(["sk_live_bbb"]);
  });
});
