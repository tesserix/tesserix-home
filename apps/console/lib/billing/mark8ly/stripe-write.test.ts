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
 *  - Exactly four methods, named individually, so a fifth cannot arrive
 *    quietly.
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
  const constructedWith: Array<{ key: string; config: unknown }> = [];
  return {
    pricesCreate,
    pricesUpdate,
    productsList,
    productsCreate,
    constructedWith,
  };
});

vi.mock("stripe", () => ({
  default: class FakeStripe {
    readonly prices = { create: stripeMock.pricesCreate, update: stripeMock.pricesUpdate };
    readonly products = { list: stripeMock.productsList, create: stripeMock.productsCreate };
    constructor(key: string, config: unknown) {
      stripeMock.constructedWith.push({ key, config });
    }
  },
}));

import { stripeCatalogWriter, StripeWriteUnavailableError, WRITE_KEY_ENV } from "./stripe-write";
import type { CreatePriceSpec } from "./stripe-write";

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
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("exposes exactly six methods, named individually so this fails on the next change", () => {
  // Named individually, not counted, so this fails on the NEXT method added
  // rather than merely on a count changing — see the module header.
  // `updatePriceCurrencyOptions` is deliberately absent: §1.6a proved an
  // existing currency's amount is immutable, so no such method can exist.
  expect(Object.keys(stripeCatalogWriter).sort()).toEqual([
    "addCurrencyOption",
    "archivePrice",
    "createPrice",
    "createProduct",
    "findProductByPlan",
    "updatePriceTaxBehavior",
  ]);
});

it("never returns the underlying Stripe instance", () => {
  for (const v of Object.values(stripeCatalogWriter)) expect(typeof v).toBe("function");
});

it("fails clearly when the mode's key is absent", async () => {
  vi.stubEnv("STRIPE_WRITE_KEY_TEST", "");
  await expect(stripeCatalogWriter.findProductByPlan("test", "pro")).rejects.toThrow(
    /STRIPE_WRITE_KEY_TEST/,
  );
});

it("fails with StripeWriteUnavailableError, not a bare Error", async () => {
  vi.stubEnv("STRIPE_WRITE_KEY_TEST", "");
  await expect(stripeCatalogWriter.findProductByPlan("test", "pro")).rejects.toThrow(
    StripeWriteUnavailableError,
  );
});

it("refuses a key whose prefix contradicts its mode", async () => {
  // The read-side version of this mistake cost an hour on 2026-08-27 and
  // produced a report claiming all 42 prices were missing. The WRITE-side
  // version creates 42 prices in the wrong account.
  vi.stubEnv("STRIPE_WRITE_KEY_TEST", ["sk", "live", "abc123"].join("_"));
  await expect(stripeCatalogWriter.findProductByPlan("test", "pro")).rejects.toThrow(/mode/i);
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

    const found = await stripeCatalogWriter.findProductByPlan("test", "pro");

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

    const found = await stripeCatalogWriter.findProductByPlan("test", "pro");

    expect(found).toBeNull();
  });
});

describe("createProduct", () => {
  it("names the product 'Mark8ly ' + plan and tags metadata.plan", async () => {
    await stripeCatalogWriter.createProduct("test", "pro", "product:v1:pro");

    expect(stripeMock.productsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Mark8ly pro", metadata: { plan: "pro" } }),
      { idempotencyKey: "product:v1:pro" },
    );
  });

  it("returns only the id, not the raw SDK object", async () => {
    stripeMock.productsCreate.mockResolvedValue({
      id: "prod_new",
      name: "Mark8ly pro",
      metadata: { plan: "pro" },
    });

    const created = await stripeCatalogWriter.createProduct("test", "pro", "product:v1:pro");

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

describe("mode isolation", () => {
  it("never reaches the other mode's key", async () => {
    vi.stubEnv("STRIPE_WRITE_KEY_TEST", "sk_test_aaa");
    vi.stubEnv("STRIPE_WRITE_KEY_LIVE", "sk_live_bbb");

    await stripeCatalogWriter.findProductByPlan("live", "pro");

    expect(stripeMock.constructedWith.map((c) => c.key)).toEqual(["sk_live_bbb"]);
  });
});
