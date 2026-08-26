import { describe, expect, it } from "vitest";
import type Stripe from "stripe";

import {
  MARK8LY_LOOKUP_KEY_PREFIX,
  ZERO_DECIMAL_CURRENCIES,
  compareCatalogToStripe,
  type CatalogAmount,
  type StripePriceLike,
} from "./parity";

/**
 * The comparator's whole test surface — fixtures in, a structured report out.
 *
 * There is no database here and no `Stripe` client, because `parity.ts` has
 * neither. That is the property being protected as much as the arithmetic: the
 * function that decides whether the 7-day window means anything has to be
 * exhaustively testable without a network, and it has to stay clear of any
 * module with server ancestry so that P1b can render a report from a component.
 *
 * The stakes, stated once: this comparator's output is what P2 revokes
 * mark8ly's Stripe write key on. A false positive makes the window worthless
 * (nobody reads a check that cries drift on day one); a false negative makes it
 * dangerous (a clean week that was never actually clean).
 */

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * The seven currencies a `developed` descriptor covers. Taken from the seed in
 * `0032_plan_catalog.sql` rather than invented, so a fixture that matches here
 * is a fixture that would match production.
 *
 * `aud` is first on purpose: it is the only currency in the whole catalog
 * carrying `exclusive`, so it is the one that proves tax_behavior is compared
 * per-currency and not per-Price.
 */
const DEVELOPED_STARTER_MONTHLY: ReadonlyArray<
  readonly [currency: string, minor: number, tax: CatalogAmount["taxBehavior"]]
> = [
  ["aud", 2900, "exclusive"],
  ["cad", 2500, "unspecified"],
  ["eur", 1700, "unspecified"],
  ["gbp", 1500, "unspecified"],
  ["nzd", 2900, "unspecified"],
  ["sgd", 2500, "unspecified"],
  ["usd", 1900, "unspecified"],
];

function catalogAmount(
  lookupKey: string,
  currency: string,
  unitAmountMinor: number,
  taxBehavior: CatalogAmount["taxBehavior"] = "unspecified",
): CatalogAmount {
  return { lookupKey, currency, unitAmountMinor, taxBehavior };
}

/** The catalog side of one `developed` descriptor: seven rows, one lookup key. */
function developedCatalog(lookupKey: string): CatalogAmount[] {
  return DEVELOPED_STARTER_MONTHLY.map(([currency, minor, tax]) =>
    catalogAmount(lookupKey, currency, minor, tax),
  );
}

/**
 * A Stripe Price, in the shape the API actually returns.
 *
 * Snake_case, and `currency_options` as a map keyed by currency — this is the
 * live payload, not an adapter's idea of it. `base` is the Price's OWN
 * currency; `options` are the further ones.
 */
function stripePrice(args: {
  id?: string;
  lookupKey: string | null;
  base: readonly [currency: string, unitAmount: number | null, tax?: StripePriceLike["tax_behavior"]];
  options?: ReadonlyArray<
    readonly [currency: string, unitAmount: number | null, tax?: StripePriceLike["tax_behavior"]]
  >;
}): StripePriceLike {
  const [currency, unitAmount, tax] = args.base;
  const currency_options: Record<
    string,
    { unit_amount: number | null; tax_behavior: StripePriceLike["tax_behavior"] }
  > = {};
  for (const [c, amount, t] of args.options ?? []) {
    currency_options[c] = { unit_amount: amount, tax_behavior: t ?? "unspecified" };
  }
  return {
    id: args.id ?? `price_${args.lookupKey ?? "anon"}`,
    lookup_key: args.lookupKey,
    currency,
    unit_amount: unitAmount,
    tax_behavior: tax ?? "unspecified",
    currency_options: args.options ? currency_options : undefined,
  };
}

/** The Stripe side of one `developed` descriptor: ONE Price, seven currencies. */
function developedStripePrice(lookupKey: string): StripePriceLike {
  const [base, ...rest] = DEVELOPED_STARTER_MONTHLY;
  return stripePrice({
    lookupKey,
    base: [base[0], base[1], base[2]],
    options: rest.map(([c, minor, tax]) => [c, minor, tax] as const),
  });
}

const STARTER_MONTHLY = `${MARK8LY_LOOKUP_KEY_PREFIX}starter_monthly_developed_v1`;
const STARTER_VND = `${MARK8LY_LOOKUP_KEY_PREFIX}starter_monthly_ppp_vnd_v1`;
const STARTER_IDR = `${MARK8LY_LOOKUP_KEY_PREFIX}starter_monthly_ppp_idr_v1`;

// ---------------------------------------------------------------------------

describe("the shape asymmetry", () => {
  it("matches one Price against seven catalog rows without inventing a difference", () => {
    // The trap the whole two-table schema exists to avoid: a naive
    // one-row-per-Price comparison lines 78 catalog rows up against 42 Prices
    // and reports 36 phantom "missing" Prices on its first run.
    const report = compareCatalogToStripe(developedCatalog(STARTER_MONTHLY), [
      developedStripePrice(STARTER_MONTHLY),
    ]);

    expect(report.differences).toEqual([]);
    expect(report.catalogPriceCount).toBe(1);
    expect(report.stripePriceCount).toBe(1);
  });

  it("reports nothing at all for a fully matching catalog across both tiers", () => {
    const catalog = [
      ...developedCatalog(STARTER_MONTHLY),
      catalogAmount(STARTER_VND, "vnd", 32_900_000),
      catalogAmount(STARTER_IDR, "idr", 19_900_000),
    ];
    const prices = [
      developedStripePrice(STARTER_MONTHLY),
      stripePrice({ lookupKey: STARTER_VND, base: ["vnd", 32_900_000] }),
      stripePrice({ lookupKey: STARTER_IDR, base: ["idr", 19_900_000] }),
    ];

    const report = compareCatalogToStripe(catalog, prices);

    expect(report.differences).toEqual([]);
    expect(report.catalogPriceCount).toBe(3);
    expect(report.stripePriceCount).toBe(3);
  });

  it("counts a Price's own currency as covered even with no currency_options", () => {
    // A `ppp` descriptor is its own Price with no `currency_options` key at
    // all. Reading coverage from `currency_options` alone would report all 36
    // of them as covering nothing.
    const report = compareCatalogToStripe(
      [catalogAmount(STARTER_VND, "vnd", 32_900_000)],
      [stripePrice({ lookupKey: STARTER_VND, base: ["vnd", 32_900_000] })],
    );
    expect(report.differences).toEqual([]);
  });
});

describe("price-level differences", () => {
  it("reports a catalog key with no live Price, naming the currencies it covers", () => {
    const report = compareCatalogToStripe(developedCatalog(STARTER_MONTHLY), []);

    expect(report.differences).toEqual([
      {
        kind: "price_missing_in_stripe",
        lookupKey: STARTER_MONTHLY,
        currencies: ["aud", "cad", "eur", "gbp", "nzd", "sgd", "usd"],
      },
    ]);
  });

  it("reports a live Price in our namespace with no catalog row, naming its id", () => {
    const extra = stripePrice({
      id: "price_1Extra",
      lookupKey: `${MARK8LY_LOOKUP_KEY_PREFIX}legacy_monthly_developed_v1`,
      base: ["usd", 1900],
      options: [["eur", 1700]],
    });

    const report = compareCatalogToStripe([], [extra]);

    expect(report.differences).toEqual([
      {
        kind: "price_missing_in_catalog",
        lookupKey: `${MARK8LY_LOOKUP_KEY_PREFIX}legacy_monthly_developed_v1`,
        currencies: ["eur", "usd"],
        priceId: "price_1Extra",
      },
    ]);
  });

  it("ignores Prices outside our namespace, and Prices with no lookup_key", () => {
    // The account is shared. Reporting every unrelated Price as drift is the
    // same signal-destroying false positive as any other, just louder.
    const report = compareCatalogToStripe(
      [],
      [
        stripePrice({ lookupKey: "kora_pro_monthly_v1", base: ["usd", 1900] }),
        stripePrice({ id: "price_nokey", lookupKey: null, base: ["usd", 1900] }),
      ],
    );
    expect(report.differences).toEqual([]);
    expect(report.stripePriceCount).toBe(0);
  });
});

describe("currency-level differences", () => {
  it("reports a currency the catalog covers and Stripe does not", () => {
    const stripeSide = stripePrice({
      lookupKey: STARTER_MONTHLY,
      base: ["aud", 2900, "exclusive"],
      // `usd` deliberately absent.
      options: DEVELOPED_STARTER_MONTHLY.slice(1, -1).map(
        ([c, minor, tax]) => [c, minor, tax] as const,
      ),
    });

    const report = compareCatalogToStripe(developedCatalog(STARTER_MONTHLY), [stripeSide]);

    expect(report.differences).toEqual([
      {
        kind: "currency_missing_in_stripe",
        lookupKey: STARTER_MONTHLY,
        currency: "usd",
        unitAmountMinor: 1900,
        taxBehavior: "unspecified",
      },
    ]);
  });

  it("reports a currency Stripe covers and the catalog does not", () => {
    const stripeSide = stripePrice({
      lookupKey: STARTER_VND,
      base: ["vnd", 32_900_000],
      options: [["jpy", 2900, "inclusive"]],
    });

    const report = compareCatalogToStripe(
      [catalogAmount(STARTER_VND, "vnd", 32_900_000)],
      [stripeSide],
    );

    expect(report.differences).toEqual([
      {
        kind: "currency_missing_in_catalog",
        lookupKey: STARTER_VND,
        currency: "jpy",
        unitAmountMinor: 2900,
        taxBehavior: "inclusive",
      },
    ]);
  });
});

describe("amount_mismatch", () => {
  it("reports both values so the report is actionable without a second query", () => {
    const report = compareCatalogToStripe(
      [catalogAmount(STARTER_MONTHLY, "usd", 1900)],
      [stripePrice({ lookupKey: STARTER_MONTHLY, base: ["usd", 2900] })],
    );

    expect(report.differences).toEqual([
      {
        kind: "amount_mismatch",
        lookupKey: STARTER_MONTHLY,
        currency: "usd",
        catalogUnitAmountMinor: 1900,
        stripeUnitAmountMinor: 2900,
        zeroDecimalSuspect: false,
      },
    ]);
  });

  it("reports a Price that carries no flat unit_amount as a mismatch, not a match", () => {
    // `billing_scheme=tiered` and `custom_unit_amount` both leave `unit_amount`
    // null. The currency IS covered, so this is not a coverage difference — it
    // is a Price that cannot charge the catalog's amount.
    const report = compareCatalogToStripe(
      [catalogAmount(STARTER_MONTHLY, "usd", 1900)],
      [stripePrice({ lookupKey: STARTER_MONTHLY, base: ["usd", null] })],
    );

    expect(report.differences).toEqual([
      {
        kind: "amount_mismatch",
        lookupKey: STARTER_MONTHLY,
        currency: "usd",
        catalogUnitAmountMinor: 1900,
        stripeUnitAmountMinor: null,
        zeroDecimalSuspect: false,
      },
    ]);
  });
});

describe("the zero-decimal trap", () => {
  it("keeps VND out of the zero-decimal set's blind spot and IDR out of the set", () => {
    // `catalog.go:159` claims Stripe stores IDR and VND x100. IDR is not a
    // Stripe zero-decimal currency, so x100 is simply correct there. VND is.
    expect(ZERO_DECIMAL_CURRENCIES).toContain("vnd");
    expect(ZERO_DECIMAL_CURRENCIES).not.toContain("idr");
  });

  it("flags a VND mismatch that is exactly a factor of 100", () => {
    // The catalog says d32,900,000 minor; Stripe says d329,000. VND has no
    // minor unit, so the catalog's number is a hundred times the real price.
    // Reported VERBATIM and flagged — never silently normalised.
    const report = compareCatalogToStripe(
      [catalogAmount(STARTER_VND, "vnd", 32_900_000)],
      [stripePrice({ lookupKey: STARTER_VND, base: ["vnd", 329_000] })],
    );

    expect(report.differences).toEqual([
      {
        kind: "amount_mismatch",
        lookupKey: STARTER_VND,
        currency: "vnd",
        catalogUnitAmountMinor: 32_900_000,
        stripeUnitAmountMinor: 329_000,
        zeroDecimalSuspect: true,
      },
    ]);
  });

  it("does NOT flag an IDR mismatch that is exactly a factor of 100", () => {
    // Same arithmetic, different currency, different meaning: IDR has two
    // decimal places in Stripe, so a x100 gap there is an ordinary pricing
    // difference and must not be dressed up as the VND question.
    const report = compareCatalogToStripe(
      [catalogAmount(STARTER_IDR, "idr", 19_900_000)],
      [stripePrice({ lookupKey: STARTER_IDR, base: ["idr", 199_000] })],
    );

    expect(report.differences).toEqual([
      {
        kind: "amount_mismatch",
        lookupKey: STARTER_IDR,
        currency: "idr",
        catalogUnitAmountMinor: 19_900_000,
        stripeUnitAmountMinor: 199_000,
        zeroDecimalSuspect: false,
      },
    ]);
  });

  it("does not flag a zero-decimal mismatch that is not a factor of 100", () => {
    const report = compareCatalogToStripe(
      [catalogAmount(STARTER_VND, "vnd", 32_900_000)],
      [stripePrice({ lookupKey: STARTER_VND, base: ["vnd", 33_900_000] })],
    );
    expect(report.differences[0]).toMatchObject({ zeroDecimalSuspect: false });
  });

  it("normalises nothing — the amounts in the report are the amounts on both sides", () => {
    const report = compareCatalogToStripe(
      [catalogAmount(STARTER_VND, "vnd", 32_900_000)],
      [stripePrice({ lookupKey: STARTER_VND, base: ["vnd", 329_000] })],
    );
    const diff = report.differences[0];
    if (diff.kind !== "amount_mismatch") expect.unreachable("expected amount_mismatch");
    else {
      expect(diff.catalogUnitAmountMinor).toBe(32_900_000);
      expect(diff.stripeUnitAmountMinor).toBe(329_000);
    }
  });
});

describe("tax_behavior", () => {
  it("treats catalog `unspecified` and Stripe `unspecified` as the same state", () => {
    // Part 1 normalised `''` to `unspecified` in the migration precisely so
    // this comparison is direct. Reintroducing a mapping here would open the
    // check with 72 false positives out of 78 rows.
    const report = compareCatalogToStripe(
      [catalogAmount(STARTER_MONTHLY, "usd", 1900, "unspecified")],
      [stripePrice({ lookupKey: STARTER_MONTHLY, base: ["usd", 1900, "unspecified"] })],
    );
    expect(report.differences).toEqual([]);
  });

  it("treats a null tax_behavior from Stripe as `unspecified`, not as drift", () => {
    // The API types `tax_behavior` as nullable. A null read as a difference
    // from `unspecified` is the same 72-row false positive by another route.
    const report = compareCatalogToStripe(
      [catalogAmount(STARTER_MONTHLY, "usd", 1900, "unspecified")],
      [stripePrice({ lookupKey: STARTER_MONTHLY, base: ["usd", 1900, null] })],
    );
    expect(report.differences).toEqual([]);
  });

  it("treats a missing tax_behavior in currency_options as `unspecified` too", () => {
    const price: StripePriceLike = {
      id: "price_1",
      lookup_key: STARTER_MONTHLY,
      currency: "aud",
      unit_amount: 2900,
      tax_behavior: "exclusive",
      currency_options: { usd: { unit_amount: 1900, tax_behavior: null } },
    };
    const report = compareCatalogToStripe(
      [
        catalogAmount(STARTER_MONTHLY, "aud", 2900, "exclusive"),
        catalogAmount(STARTER_MONTHLY, "usd", 1900, "unspecified"),
      ],
      [price],
    );
    expect(report.differences).toEqual([]);
  });

  it("reports a real tax_behavior difference with both values", () => {
    const report = compareCatalogToStripe(
      [catalogAmount(STARTER_MONTHLY, "aud", 2900, "exclusive")],
      [stripePrice({ lookupKey: STARTER_MONTHLY, base: ["aud", 2900, "inclusive"] })],
    );

    expect(report.differences).toEqual([
      {
        kind: "tax_behavior_mismatch",
        lookupKey: STARTER_MONTHLY,
        currency: "aud",
        catalogTaxBehavior: "exclusive",
        stripeTaxBehavior: "inclusive",
      },
    ]);
  });

  it("reports an amount and a tax_behavior difference on one currency separately", () => {
    // They are independent facts about the same row. Collapsing them into one
    // difference would mean fixing the amount silently closes the tax finding.
    const report = compareCatalogToStripe(
      [catalogAmount(STARTER_MONTHLY, "aud", 2900, "exclusive")],
      [stripePrice({ lookupKey: STARTER_MONTHLY, base: ["aud", 3900, "inclusive"] })],
    );

    expect(report.differences.map((d) => d.kind)).toEqual([
      "amount_mismatch",
      "tax_behavior_mismatch",
    ]);
  });
});

describe("the report itself", () => {
  it("never throws and never asserts equality — it returns a value", () => {
    expect(() => compareCatalogToStripe([], [])).not.toThrow();
    expect(compareCatalogToStripe([], [])).toEqual({
      differences: [],
      catalogPriceCount: 0,
      stripePriceCount: 0,
    });
  });

  it("orders differences deterministically, so two runs diff cleanly", () => {
    const catalog = [
      catalogAmount("mark8ly_b_v1", "usd", 100),
      catalogAmount("mark8ly_a_v1", "usd", 100),
      catalogAmount("mark8ly_a_v1", "eur", 100),
    ];
    const report = compareCatalogToStripe(catalog, []);
    expect(report.differences.map((d) => d.lookupKey)).toEqual([
      "mark8ly_a_v1",
      "mark8ly_b_v1",
    ]);

    const currencyLevel = compareCatalogToStripe(catalog, [
      stripePrice({ lookupKey: "mark8ly_a_v1", base: ["gbp", 100] }),
      stripePrice({ lookupKey: "mark8ly_b_v1", base: ["gbp", 100] }),
    ]);
    expect(
      currencyLevel.differences.map((d) => [d.lookupKey, "currency" in d ? d.currency : null]),
    ).toEqual([
      ["mark8ly_a_v1", "eur"],
      ["mark8ly_a_v1", "gbp"],
      ["mark8ly_a_v1", "usd"],
      ["mark8ly_b_v1", "gbp"],
      ["mark8ly_b_v1", "usd"],
    ]);
  });
});

describe("the Stripe shape this comparator is written against", () => {
  it("accepts a real `Stripe.Price` without an adapter", () => {
    // A COMPILE-TIME assertion, and the only place `stripe` is named in this
    // module's tests. `parity.ts` itself imports nothing from the SDK — not
    // even a type — so this is what stops `StripePriceLike` drifting away from
    // the payload it claims to describe. If Stripe changes `currency_options`
    // or the `tax_behavior` union, this line stops compiling and `typecheck`
    // fails, rather than the comparator quietly reading undefined at runtime.
    const assignable = (price: Stripe.Price): StripePriceLike => price;
    expect(typeof assignable).toBe("function");
  });
});
