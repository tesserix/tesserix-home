import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogAmount, StripePriceLike, TaxBehavior } from "./parity";

/**
 * The bootstrap decision, and the thin caller around it.
 *
 * `planBootstrap` is the pure half: 78 catalog amounts and whatever Stripe
 * Prices already exist go in, a plan of Products and Prices to create comes
 * out — no I/O, no `stripe` import, exhaustively fixture-testable. This is
 * deliberate for the same reason `parity.ts` is pure: the function that
 * decides what gets WRITTEN to a live Stripe account has to be provable
 * without a network before anything calls it for real.
 *
 * `runBootstrap` is the I/O half: it reads the catalog and the live Prices,
 * calls `planBootstrap`, refuses to run against a mode that already holds
 * prices unless told to proceed anyway, then creates the plan's Products
 * before its Prices.
 */

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const PLANS = ["pro", "starter", "studio"] as const;
const PERIODS = ["annual", "monthly"] as const;

/** Taken from the seed in `0032_plan_catalog.sql` rather than invented — see
 *  `parity.test.ts`'s `DEVELOPED_STARTER_MONTHLY` for the same discipline. */
const DEVELOPED_CURRENCIES = ["usd", "aud", "cad", "eur", "gbp", "nzd", "sgd"] as const;
const PPP_CURRENCIES = ["idr", "inr", "myr", "php", "thb", "vnd"] as const;

function developedKey(plan: string, period: string): string {
  return `mark8ly_${plan}_${period}_developed_v1`;
}

function pppKey(plan: string, period: string, currency: string): string {
  return `mark8ly_${plan}_${period}_ppp_${currency}_v1`;
}

function amount(
  lookupKey: string,
  currency: string,
  unitAmountMinor: number,
  taxBehavior: TaxBehavior = "unspecified",
): CatalogAmount {
  return { lookupKey, currency, unitAmountMinor, taxBehavior };
}

/**
 * The full 78-amount, 42-key catalog: 3 plans x 2 periods x (1 developed
 * descriptor carrying 7 currencies + 6 PPP descriptors carrying 1 each) =
 * (7 + 6) x 6 = 78 rows across 42 keys. Shape matches `0032_plan_catalog.sql`
 * exactly; the amounts themselves are synthetic — the tests below never
 * assert a specific price, only the shape and the conversion.
 */
function buildFullCatalog(): CatalogAmount[] {
  const rows: CatalogAmount[] = [];
  for (const plan of PLANS) {
    for (const period of PERIODS) {
      const devKey = developedKey(plan, period);
      for (const currency of DEVELOPED_CURRENCIES) {
        // `aud` is the catalog's one `exclusive` currency (see
        // `parity.test.ts`) — kept here too so a fixture that groups by
        // currency can't accidentally coalesce tax behaviours.
        rows.push(amount(devKey, currency, 1_900, currency === "aud" ? "exclusive" : "unspecified"));
      }
      for (const currency of PPP_CURRENCIES) {
        const key = pppKey(plan, period, currency);
        rows.push(amount(key, currency, currency === "vnd" ? 1_978_800_000 : 32_900));
      }
    }
  }
  return rows;
}

const FULL_CATALOG_78 = buildFullCatalog();

/** Every lookup key `FULL_CATALOG_78` describes, in the order it produces
 *  them — used to build "Stripe already has everything" fixtures. */
function allLookupKeys(): string[] {
  const keys: string[] = [];
  for (const plan of PLANS) {
    for (const period of PERIODS) {
      keys.push(developedKey(plan, period));
      for (const currency of PPP_CURRENCIES) keys.push(pppKey(plan, period, currency));
    }
  }
  return keys;
}

/** A live Stripe Price, minimal — `planBootstrap` only ever reads
 *  `lookup_key` off the "already exists" side, so nothing else is filled in
 *  unless a test needs it. */
function price(overrides: { lookup_key: string | null } & Partial<StripePriceLike>): StripePriceLike {
  return {
    id: `price_${overrides.lookup_key ?? "anon"}`,
    currency: "usd",
    unit_amount: 100,
    tax_behavior: "unspecified",
    ...overrides,
  };
}

const ALL_42_PRICES: StripePriceLike[] = allLookupKeys().map((lookup_key) => price({ lookup_key }));

// ---------------------------------------------------------------------------
// planBootstrap — pure
// ---------------------------------------------------------------------------

describe("planBootstrap", () => {
  it("plans 3 products and 42 prices against an empty mode", async () => {
    const { planBootstrap } = await import("./bootstrap");
    const plan = planBootstrap(FULL_CATALOG_78, []);
    expect(plan.products).toHaveLength(3);
    expect(plan.prices).toHaveLength(42);
  });

  it("skips a lookup key Stripe already has", async () => {
    // Re-running is safe BY CONSTRUCTION — lookup_key is unique among ACTIVE
    // prices, so the second run finds what the first created. This is what
    // lets a bootstrap skip the operation log and resumability entirely.
    const { planBootstrap } = await import("./bootstrap");
    const plan = planBootstrap(FULL_CATALOG_78, [
      price({ lookup_key: "mark8ly_pro_annual_developed_v1" }),
    ]);
    expect(plan.prices.map((p) => p.lookupKey)).not.toContain("mark8ly_pro_annual_developed_v1");
    expect(plan.prices).toHaveLength(41);
  });

  it("produces an EMPTY plan when the mode is already fully populated", async () => {
    // The convergence property, and the thing that makes re-running harmless.
    const { planBootstrap } = await import("./bootstrap");
    expect(planBootstrap(FULL_CATALOG_78, ALL_42_PRICES)).toMatchObject({ products: [], prices: [] });
  });

  it("ignores an existing price outside the mark8ly_ namespace", async () => {
    // The account is shared; an unrelated Price with the same-shaped lookup
    // key from a different product must not suppress ours.
    const { planBootstrap } = await import("./bootstrap");
    const plan = planBootstrap(FULL_CATALOG_78, [price({ lookup_key: "otherapp_pro_v1" })]);
    expect(plan.prices).toHaveLength(42);
  });

  it("groups a developed descriptor's seven currencies onto ONE price", async () => {
    // 78 amounts, 42 prices. A per-amount plan would create 78 Stripe Prices
    // and break every lookup-key assumption downstream.
    const { planBootstrap } = await import("./bootstrap");
    const plan = planBootstrap(FULL_CATALOG_78, []);
    const dev = plan.prices.find((p) => p.lookupKey === "mark8ly_pro_annual_developed_v1")!;
    expect(Object.keys(dev.currencyOptions).length + 1).toBe(7); // +1 for the baseline
    expect(dev.currency).toBe("usd");
    expect(dev.currencyOptions.usd).toBeUndefined();
  });

  it("converts zero-decimal amounts before sending", async () => {
    // Catalog holds VND x100. Sending it raw is the 100x defect found in the
    // comparator on 2026-08-27, on the write side where it charges people.
    const { planBootstrap } = await import("./bootstrap");
    const plan = planBootstrap(
      [amount("mark8ly_pro_annual_ppp_vnd_v1", "vnd", 1_978_800_000)],
      [],
    );
    expect(plan.prices[0].unitAmount).toBe(19_788_000);
    expect(plan.prices[0].currency).toBe("vnd");
  });

  it("converts every currency option too, not just the baseline", async () => {
    const { planBootstrap } = await import("./bootstrap");
    const plan = planBootstrap(
      [
        amount("mark8ly_pro_monthly_developed_v1", "usd", 1_900),
        amount("mark8ly_pro_monthly_developed_v1", "aud", 2_900, "exclusive"),
      ],
      [],
    );
    expect(plan.prices[0].currencyOptions.aud).toEqual({ unitAmount: 2_900, taxBehavior: "exclusive" });
  });

  it("derives period from the lookup key: annual", async () => {
    const { planBootstrap } = await import("./bootstrap");
    const plan = planBootstrap([amount("mark8ly_pro_annual_ppp_vnd_v1", "vnd", 100)], []);
    expect(plan.prices[0].period).toBe("annual");
  });

  it("derives period from the lookup key: monthly", async () => {
    const { planBootstrap } = await import("./bootstrap");
    const plan = planBootstrap([amount("mark8ly_pro_monthly_ppp_vnd_v1", "vnd", 100)], []);
    expect(plan.prices[0].period).toBe("monthly");
  });

  it("derives the plan name from the lookup key, via parity.ts's planOf", async () => {
    const { planBootstrap } = await import("./bootstrap");
    const plan = planBootstrap([amount("mark8ly_studio_annual_ppp_vnd_v1", "vnd", 100)], []);
    expect(plan.prices[0].plan).toBe("studio");
    expect(plan.products).toEqual(["studio"]);
  });

  it("fails loudly when a developed key's amounts don't include usd", async () => {
    // A wrong baseline creates a Price that agrees on nothing. Guessing here
    // would be worse than throwing.
    const { planBootstrap } = await import("./bootstrap");
    expect(() =>
      planBootstrap([amount("mark8ly_pro_annual_developed_v1", "eur", 1_000)], []),
    ).toThrow(/usd/i);
  });

  it("fails loudly when a non-developed key carries more than one currency", async () => {
    const { planBootstrap } = await import("./bootstrap");
    expect(() =>
      planBootstrap(
        [
          amount("mark8ly_pro_annual_ppp_vnd_v1", "vnd", 100),
          amount("mark8ly_pro_annual_ppp_vnd_v1", "inr", 100),
        ],
        [],
      ),
    ).toThrow(/single currency|one currency/i);
  });
});

// ---------------------------------------------------------------------------
// runBootstrap — the I/O caller
// ---------------------------------------------------------------------------

const catalogMock = vi.hoisted(() => ({ readCatalogAmounts: vi.fn() }));
const readerMock = vi.hoisted(() => ({ listPrices: vi.fn() }));
const writerMock = vi.hoisted(() => ({
  findProductByPlan: vi.fn(),
  createProduct: vi.fn(),
  createPrice: vi.fn(),
  addCurrencyOption: vi.fn(),
}));

vi.mock("@/lib/db/plan-catalog-repo", () => ({
  readCatalogAmounts: catalogMock.readCatalogAmounts,
}));
vi.mock("./stripe-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripe-read")>()),
  stripePriceReader: readerMock,
}));
vi.mock("./mark8ly/stripe-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mark8ly/stripe-write")>()),
  stripeCatalogWriter: writerMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  catalogMock.readCatalogAmounts.mockResolvedValue(FULL_CATALOG_78);
  readerMock.listPrices.mockResolvedValue([]);
  writerMock.findProductByPlan.mockResolvedValue(null);
  let productSeq = 0;
  writerMock.createProduct.mockImplementation(async (_mode: string, plan: string) => ({
    id: `prod_${plan}_${++productSeq}`,
  }));
  let priceSeq = 0;
  writerMock.createPrice.mockImplementation(async () => ({ id: `price_${++priceSeq}` }));
});

afterEach(() => {
  vi.resetModules();
});

describe("runBootstrap", () => {
  it("refuses to run against a mode that already holds prices, unless forced", async () => {
    // A bootstrap is for an EMPTY mode. Running it against a populated one is
    // almost always a mistake about which mode you are in — and this estate
    // has already made that mistake once with an rk_live_ key.
    readerMock.listPrices.mockResolvedValue(ALL_42_PRICES);
    const { runBootstrap } = await import("./bootstrap");

    await expect(runBootstrap("test")).rejects.toThrow(/already holds/i);
    await expect(runBootstrap("test", { force: true })).resolves.toBeDefined();
  });

  it("does not let an injected count substitute for what Stripe actually returned", async () => {
    // The guard is a live read, not a parameter a caller could lie to.
    // `readerMock.listPrices` returning an empty array is the only thing
    // that lets this resolve without `force`.
    readerMock.listPrices.mockResolvedValue([]);
    const { runBootstrap } = await import("./bootstrap");
    await expect(runBootstrap("test")).resolves.toBeDefined();
  });

  it("creates products before the prices that reference them", async () => {
    const order: string[] = [];
    writerMock.createProduct.mockImplementation(async (_mode: string, plan: string) => {
      order.push("product");
      return { id: `prod_${plan}` };
    });
    writerMock.createPrice.mockImplementation(async () => {
      order.push("price");
      return { id: "price_x" };
    });

    const { runBootstrap } = await import("./bootstrap");
    await runBootstrap("test");

    expect(order.indexOf("product")).toBeLessThan(order.lastIndexOf("price"));
    expect(order.filter((k) => k === "product")).toHaveLength(3);
    expect(order.filter((k) => k === "price")).toHaveLength(42);
  });

  it("reports what it created, per kind", async () => {
    const { runBootstrap } = await import("./bootstrap");
    const r = await runBootstrap("live");
    expect(r).toMatchObject({ productsCreated: 3, pricesCreated: 42, skipped: 0 });
  });

  it("reuses an existing product rather than creating a duplicate", async () => {
    writerMock.findProductByPlan.mockResolvedValue({ id: "prod_existing" });
    const { runBootstrap } = await import("./bootstrap");

    const r = await runBootstrap("test");

    expect(writerMock.createProduct).not.toHaveBeenCalled();
    expect(r.productsCreated).toBe(0);
    // Every price still gets created, against the existing product.
    expect(writerMock.createPrice).toHaveBeenCalledTimes(42);
    for (const call of writerMock.createPrice.mock.calls) {
      expect(call[1].productId).toBe("prod_existing");
    }
  });

  it("counts skipped prices when the mode is forced and already partially populated", async () => {
    readerMock.listPrices.mockResolvedValue([price({ lookup_key: "mark8ly_pro_annual_developed_v1" })]);
    const { runBootstrap } = await import("./bootstrap");

    const r = await runBootstrap("test", { force: true });

    expect(r).toMatchObject({ pricesCreated: 41, skipped: 1 });
  });

  it("passes console-namespaced idempotency keys, not mark8ly's literal ones", async () => {
    // The same account may hold Stripe's cached response for mark8ly's own
    // `price:v3:<key>` / `product:<plan>` idempotency keys — including a
    // cached ERROR — and replaying it would be invisible.
    const { runBootstrap } = await import("./bootstrap");
    await runBootstrap("test");

    for (const call of writerMock.createProduct.mock.calls) {
      const idempotencyKey = call[2] as string;
      expect(idempotencyKey).toMatch(/^console:bootstrap:v1:product:/);
    }
    for (const call of writerMock.createPrice.mock.calls) {
      const spec = call[1] as { idempotencyKey: string; lookupKey: string };
      expect(spec.idempotencyKey).toBe(`console:bootstrap:v1:price:${spec.lookupKey}`);
    }
  });

  it("only ever creates a price against a productId, never a plan name", async () => {
    const { runBootstrap } = await import("./bootstrap");
    await runBootstrap("test");

    for (const call of writerMock.createPrice.mock.calls) {
      const spec = call[1] as { productId: string };
      expect(spec.productId).toMatch(/^prod_/);
    }
  });

  it("filters the existing-price guard to the mark8ly_ namespace", async () => {
    // A shared account holding unrelated Prices must not refuse forever.
    readerMock.listPrices.mockResolvedValue([
      { id: "price_other", lookup_key: "otherapp_pro_v1", currency: "usd", unit_amount: 100, tax_behavior: "unspecified" },
    ]);
    const { runBootstrap } = await import("./bootstrap");

    await expect(runBootstrap("test")).resolves.toMatchObject({ pricesCreated: 42 });
  });
});
