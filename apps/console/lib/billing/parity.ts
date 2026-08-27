/**
 * The plan-catalog parity comparator: catalog rows in, live Stripe Prices in,
 * a structured diff out.
 *
 * # What this module deliberately is not
 *
 * A PURE FUNCTION, and nothing else. No I/O, no database, no `stripe` import —
 * not even a type one. Two reasons, and both are load-bearing:
 *
 *  1. It is exhaustively testable against fixtures. The function that decides
 *     whether #326's 7-day observation window means anything must be provable
 *     without a network and without a Stripe account, because a check nobody
 *     can test is a check nobody can trust — and P2 revokes mark8ly's Stripe
 *     WRITE key on the strength of this window's result.
 *  2. It has no server ancestry, so a console surface (P1b) can render a
 *     report from a client component without dragging `stripe` — a Node
 *     library — into a browser bundle. `lib/money.ts` records the same lesson
 *     the expensive way: `tsc` and the whole vitest suite pass either way, and
 *     only `next build` sees it.
 *
 * It REPORTS. It never throws on a difference and never asserts equality. A
 * difference is a finding to be written to `plan_catalog_parity_runs` and read
 * by a human, not an exception that aborts the run and leaves the window with
 * a hole in it.
 *
 * # The shape asymmetry, which is the whole difficulty
 *
 * The catalog holds 78 amounts across only 42 `lookup_key`s. A `developed`
 * descriptor is ONE Stripe Price whose `currency_options` carry six further
 * currencies; each `ppp` descriptor is its own Price. So the unit of
 * comparison is the `lookup_key`, and within a matched key the unit is the
 * currency. A naive one-row-per-Price comparison lines 78 up against 42 and
 * reports 36 phantom missing Prices on its first run.
 */

import {
  policyFor,
  toStripeUnitAmount,
  ZERO_DECIMAL_CURRENCIES,
  type SourcePolicy,
} from "./source-policy";
export { ZERO_DECIMAL_CURRENCIES } from "./source-policy";

/**
 * Stripe's three tax behaviours, verbatim.
 *
 * The catalog stores exactly these — part 1's migration normalised `''` to
 * `unspecified` on the way in, because that is the literal value the API
 * returns for a Price created without one. The two sides therefore compare
 * DIRECTLY. Do not reintroduce a mapping here: with `''` on one side and
 * `unspecified` on the other, 72 of the catalog's 78 rows are a false positive
 * on the first run, and a check that opens with 72 false positives is ignored
 * by day two.
 */
export type TaxBehavior = "inclusive" | "exclusive" | "unspecified";

/** One row of `plan_catalog_amounts`, joined to its `lookup_key`. */
export interface CatalogAmount {
  readonly lookupKey: string;
  /** Lowercase ISO 4217, enforced by a CHECK in `0032_plan_catalog.sql`. */
  readonly currency: string;
  /**
   * Minor units. `number` rather than `bigint` even though the column is
   * `bigint`, because Stripe's own `unit_amount` is a JS number: a `bigint`
   * here would only have to be narrowed again at the point of comparison, and
   * the narrowing is the part that can be wrong. The catalog's largest value
   * is IDR annual at 1,198,800,000 — five orders of magnitude inside
   * `Number.MAX_SAFE_INTEGER`.
   */
  readonly unitAmountMinor: number;
  readonly taxBehavior: TaxBehavior;
}

/**
 * A live Stripe Price, in the shape the API actually returns.
 *
 * Structural, snake_case, and hand-written rather than imported: `parity.ts`
 * naming `stripe` even in a type position would put the SDK on this module's
 * import graph, and the point of the module is that it has no such graph. A
 * real `Stripe.Price` satisfies this structurally, and
 * `parity.test.ts` asserts exactly that at COMPILE time — so this type cannot
 * drift away from the payload it claims to describe without `typecheck`
 * failing.
 *
 * `currency_options` is optional because Stripe OMITS it unless the request
 * expands it. See `stripe-read.ts`, which does. A missing map here means "this
 * Price covers only its own currency", which is the truth for all 36 `ppp`
 * descriptors — so an absent map must never be read as "covers nothing".
 */
export interface StripePriceLike {
  readonly id: string;
  readonly lookup_key: string | null;
  /** The Price's OWN currency. Always covered, map or no map. */
  readonly currency: string;
  readonly unit_amount: number | null;
  readonly tax_behavior: TaxBehavior | null;
  /**
   * Whether Stripe still considers this Price usable.
   *
   * OPTIONAL so existing fixtures and call sites keep compiling, but Stripe
   * itself always returns it. `stripe-read.ts` filters to `active: true`
   * today, so in the live path this is only ever `true` — the check below
   * exists for the day that filter is relaxed, and for fixtures that model an
   * archived Price directly. An archived Price is a DIFFERENT fact from an
   * absent one: reporting it as `price_missing_in_stripe` would tell an
   * operator to create a Price that already exists.
   */
  readonly active?: boolean;
  /**
   * Stripe's Product id. Needed once the console can CREATE a price (Plan 2):
   * a Price minted against the wrong Product agrees on every amount and
   * every currency, and would converge to "clean" permanently and invisibly.
   * Stripe does not expand this by default, so it is a plain id string unless
   * a future caller asks for `expand: ["data.product"]`, in which case it
   * carries at least an `id`. Optional for the same fixture-compatibility
   * reason as `active`.
   */
  readonly product?: string | { readonly id: string } | null;
  /**
   * The billing interval. Only `interval` is read — mirrors mark8ly's own
   * check, and the catalog has no opinion on `interval_count`.
   */
  readonly recurring?: { readonly interval: string } | null;
  readonly currency_options?: {
    readonly [currency: string]: {
      readonly unit_amount: number | null;
      readonly tax_behavior: TaxBehavior | null;
    };
  };
}

/**
 * The prefix that makes a live Price ours.
 *
 * The Stripe account is shared. Without this filter every unrelated Price in
 * it is reported as `price_missing_in_catalog`, which is the same
 * signal-destroying false positive as any other, just louder.
 */
export const MARK8LY_LOOKUP_KEY_PREFIX = "mark8ly_";

// `ZERO_DECIMAL_CURRENCIES` and the per-source x100 conversion moved to
// `source-policy.ts` on 2026-08-27 (see the import above): the SET is a
// Stripe fact, but the x100 scaling was mark8ly's convention hard-coded into
// a comparator meant to be shared. A second product storing genuine minor
// units would have had every VND, JPY and KRW price divided by 100 on write
// and mis-compared on read. Re-exported above so existing importers keep
// working.

/** A `lookup_key` present on exactly one side. */
export interface PriceDifference {
  readonly kind: "price_missing_in_stripe" | "price_missing_in_catalog";
  readonly lookupKey: string;
  /**
   * Every currency the side that HAS the price covers, sorted. Carried so the
   * report says what would have to be created (or what exists and should not),
   * without a second query against either side.
   */
  readonly currencies: readonly string[];
  /** The live Price's id. Present only on `price_missing_in_catalog`. */
  readonly priceId?: string;
}

/** A matched `lookup_key` where only one side covers this currency. */
export interface CurrencyDifference {
  readonly kind: "currency_missing_in_stripe" | "currency_missing_in_catalog";
  readonly lookupKey: string;
  readonly currency: string;
  /** The value held by the side that HAS this currency. */
  readonly unitAmountMinor: number | null;
  readonly taxBehavior: TaxBehavior;
}

/** Same key, same currency, different amount. */
export interface AmountDifference {
  readonly kind: "amount_mismatch";
  readonly lookupKey: string;
  readonly currency: string;
  readonly catalogUnitAmountMinor: number;
  /**
   * Null when the live Price carries no flat amount at all —
   * `billing_scheme=tiered` or a `custom_unit_amount` both leave
   * `unit_amount` null. The currency IS covered, so that is not a coverage
   * difference; it is a Price that cannot charge the catalog's amount, which
   * is a mismatch and must read as one.
   */
  readonly stripeUnitAmountMinor: number | null;
  /**
   * The two amounts differ by exactly a factor of 100 AND the currency is
   * zero-decimal in Stripe.
   *
   * ALWAYS PRESENT, never omitted when false: an absent key in the stored
   * `differences` jsonb reads as "not evaluated", which is a different claim
   * from "evaluated, and no".
   */
  readonly zeroDecimalSuspect: boolean;
}

/** Same key, same currency, different tax behaviour. */
export interface TaxBehaviorDifference {
  readonly kind: "tax_behavior_mismatch";
  readonly lookupKey: string;
  readonly currency: string;
  readonly catalogTaxBehavior: TaxBehavior;
  readonly stripeTaxBehavior: TaxBehavior;
}

/**
 * Same key, right amounts, wrong object.
 *
 * This is the check that matters once the console can CREATE a Price (Plan
 * 2). Amount and tax-behaviour parity say nothing about whether a Price
 * belongs to the right Product, renews on the right cadence, or is even
 * still usable — a Price minted against the wrong Product, or with a monthly
 * interval where the catalog says annual, agrees on every amount and every
 * currency and would read as clean forever.
 */
export interface ShapeDifference {
  readonly kind: "price_shape_mismatch";
  readonly lookupKey: string;
  readonly field: "interval" | "active" | "product";
  readonly catalogValue: string;
  readonly stripeValue: string;
}

export type Difference =
  | PriceDifference
  | CurrencyDifference
  | AmountDifference
  | TaxBehaviorDifference
  | ShapeDifference;

export type DifferenceKind = Difference["kind"];

export interface ParityReport {
  /** Sorted by lookup key, then currency, then kind. Empty means clean. */
  readonly differences: readonly Difference[];
  /** Distinct `lookup_key`s on the catalog side — 42 today. */
  readonly catalogPriceCount: number;
  /** Live Prices in our namespace — should also be 42. */
  readonly stripePriceCount: number;
}

/** What one side knows about one (key, currency) pair. */
interface Coverage {
  readonly unitAmountMinor: number | null;
  readonly taxBehavior: TaxBehavior;
}

/**
 * Stripe's null and our `unspecified` are the same state.
 *
 * `tax_behavior` is typed nullable on both `Price` and each
 * `currency_options` entry. Reading a null as a difference from `unspecified`
 * is the 72-row false positive of the module header, arriving by a second
 * route.
 */
function taxBehaviorOf(value: TaxBehavior | null | undefined): TaxBehavior {
  return value ?? "unspecified";
}

/**
 * Every currency one live Price covers, and what it charges in each.
 *
 * The Price's OWN currency first, then every key of `currency_options`. Both
 * halves are required: reading only the map reports all 36 `ppp` descriptors
 * as covering nothing, and reading only `currency` reports the six `developed`
 * descriptors as missing six currencies each.
 */
function coverageOf(price: StripePriceLike): Map<string, Coverage> {
  const coverage = new Map<string, Coverage>();
  coverage.set(price.currency, {
    unitAmountMinor: price.unit_amount,
    taxBehavior: taxBehaviorOf(price.tax_behavior),
  });
  for (const [currency, option] of Object.entries(price.currency_options ?? {})) {
    coverage.set(currency, {
      unitAmountMinor: option.unit_amount,
      taxBehavior: taxBehaviorOf(option.tax_behavior),
    });
  }
  return coverage;
}

/** The catalog side, folded to the same (key -> currency -> value) shape. */
function catalogCoverage(amounts: readonly CatalogAmount[]): Map<string, Map<string, Coverage>> {
  const byKey = new Map<string, Map<string, Coverage>>();
  for (const amount of amounts) {
    let currencies = byKey.get(amount.lookupKey);
    if (!currencies) {
      currencies = new Map<string, Coverage>();
      byKey.set(amount.lookupKey, currencies);
    }
    currencies.set(amount.currency, {
      unitAmountMinor: amount.unitAmountMinor,
      taxBehavior: amount.taxBehavior,
    });
  }
  return byKey;
}

/**
 * Still exactly a factor of 100 apart AFTER {@link toStripeUnitAmount} has
 * already reconciled the representations.
 *
 * Before that conversion existed this flag fired on every zero-decimal row and
 * meant "probably a representation difference". It now means the opposite, and
 * is a much stronger signal: the two sides disagree by 100x on a currency whose
 * 100x is already accounted for, which is a real double- or missing conversion
 * rather than a units mismatch.
 *
 * This function decides whether a difference is LABELLED, and nothing more.
 * The amounts themselves are reported verbatim; see
 * {@link compareCatalogToStripe}.
 */
function isZeroDecimalSuspect(
  currency: string,
  // ALREADY normalised by `toStripeUnitAmount`. Named for what it holds, not
  // for where it came from: passing the RAW catalog amount here would make
  // this fire on every zero-decimal row again, which is the old bug.
  catalogAsStripeStores: number,
  stripeMinor: number | null,
): boolean {
  if (stripeMinor === null) return false;
  if (!ZERO_DECIMAL_CURRENCIES.has(currency)) return false;
  return (
    catalogAsStripeStores === stripeMinor * 100 ||
    stripeMinor === catalogAsStripeStores * 100
  );
}

/** Rank for the deterministic ordering below. Stable across runs, so two
 *  stored reports diff cleanly instead of shuffling. */
const KIND_ORDER: Record<DifferenceKind, number> = {
  price_missing_in_stripe: 0,
  price_missing_in_catalog: 1,
  currency_missing_in_stripe: 2,
  currency_missing_in_catalog: 3,
  amount_mismatch: 4,
  price_shape_mismatch: 5,
  tax_behavior_mismatch: 6,
};

/**
 * `annual` -> `year`, everything else -> `month`. Mirrors mark8ly's own
 * derivation (`mark8ly/services/marketplace-api/internal/billing/stripe/price.go:53-55`);
 * there is no third period in the catalog.
 *
 * INTENTIONAL DEFAULT, not a fallback of convenience: a key containing neither
 * `_annual_` nor `_monthly_` is treated as `month`. Today that default never
 * fires — all 42 mark8ly keys carry one of the two segments — so it is
 * currently a false negative waiting for a key shape it has never seen. A
 * second source with a different naming convention (see
 * `plan-catalog-repo.ts`'s note on `source`) could pass an unrecognised key
 * straight through this default and have its interval mismatch silently
 * approved. Do not "fix" this into a stricter check without a test that
 * proves what the new key shapes actually look like.
 */
function expectedInterval(lookupKey: string): "year" | "month" {
  return lookupKey.includes("_annual_") ? "year" : "month";
}

/**
 * The plan-name segment of a lookup key: `mark8ly_pro_annual_developed_v1`
 * `-> "pro"`. Same split the conformance work uses, so this introduces no new
 * vocabulary for "which plan does this key belong to".
 */
function planOf(lookupKey: string, namespacePrefix: string): string {
  const withoutPrefix = lookupKey.startsWith(namespacePrefix)
    ? lookupKey.slice(namespacePrefix.length)
    : lookupKey;
  return withoutPrefix.split("_")[0] ?? "";
}

/**
 * Stripe's `product` field, collapsed to an id.
 *
 * A plain string in the un-expanded response this estate actually requests;
 * an object with at least an `id` if a future caller expands it. `null` and
 * `undefined` both mean "nothing to check here" and are handled by the
 * caller, not here, so this never has to invent an id.
 */
function productIdOf(product: StripePriceLike["product"]): string | null {
  if (product === null || product === undefined) return null;
  return typeof product === "string" ? product : product.id;
}

function currencyOf(difference: Difference): string {
  return "currency" in difference ? difference.currency : "";
}

/**
 * Compare the local catalog against live Stripe Prices.
 *
 * # It compares normalised, and reports verbatim
 *
 * These are two different decisions and both matter.
 *
 * COMPARISON is done in Stripe's representation, via
 * {@link toStripeUnitAmount}. The catalog and Stripe hold the same price as
 * different numbers for zero-decimal currencies, and comparing them raw is
 * simply wrong — see that function for the mechanism and the live evidence.
 *
 * REPORTING is verbatim: each side's own stored number, unconverted. A report
 * that renamed the catalog's number would send a reader to `catalog.go`
 * looking for a value that is not written there.
 *
 * An earlier version of this comment said the comparator deliberately did NOT
 * normalise, on the theory that mark8ly's x100 might be a bug worth surfacing.
 * It was not a bug — `billing-bootstrap` converts at the Stripe boundary and
 * Stripe holds the right value. Not normalising produced six false positives a
 * night on the only six VND rows in the catalog, which would have kept the
 * observation window from ever going clean. If you are about to remove the
 * conversion, that is what happens.
 *
 * # What it ignores
 *
 * Live Prices with no `lookup_key`, and live Prices whose key is outside
 * {@link MARK8LY_LOOKUP_KEY_PREFIX}. The account is shared; the rest of it is
 * not this check's business.
 *
 * @param namespacePrefix overridable for tests and for a future second
 *   product's catalog. It is the only knob, on purpose.
 * @param policy which source's amount conventions apply — see
 *   `source-policy.ts`. Defaults to mark8ly's so existing call sites keep
 *   compiling, with the default made explicit rather than implied.
 * @param productsByPlan plan name -> Stripe Product id, from `metadata.plan`.
 *   OPTIONAL, and its absence SKIPS the product check rather than guessing:
 *   the map comes from a Stripe lookup the caller may not have made, and a
 *   wrong product finding is worse than no product finding.
 */
export function compareCatalogToStripe(
  catalogAmounts: readonly CatalogAmount[],
  stripePrices: readonly StripePriceLike[],
  namespacePrefix: string = MARK8LY_LOOKUP_KEY_PREFIX,
  policy: SourcePolicy = policyFor("mark8ly"),
  productsByPlan?: Readonly<Record<string, string>>,
): ParityReport {
  const catalog = catalogCoverage(catalogAmounts);

  // Stripe enforces that a `lookup_key` is unique among ACTIVE Prices, and
  // `stripe-read.ts` asks for active ones only — so a duplicate key here is
  // not a state Stripe can produce. First-wins rather than last-wins so that,
  // if that invariant ever changes, the outcome is at least deterministic
  // between runs instead of depending on page ordering.
  const stripe = new Map<string, StripePriceLike>();
  for (const price of stripePrices) {
    const key = price.lookup_key;
    if (!key || !key.startsWith(namespacePrefix)) continue;
    if (!stripe.has(key)) stripe.set(key, price);
  }

  const differences: Difference[] = [];

  for (const [lookupKey, catalogCurrencies] of catalog) {
    const price = stripe.get(lookupKey);
    if (!price) {
      differences.push({
        kind: "price_missing_in_stripe",
        lookupKey,
        currencies: [...catalogCurrencies.keys()].sort(),
      });
      continue;
    }

    // Price-level facts, checked once per key rather than once per currency —
    // unlike amount and tax behaviour, interval/active/product do not vary by
    // currency_options entry. Safe under Task 1's EDIT-only console: none of
    // these three fields can change underneath an edit. They stop being safe
    // to ignore the moment the console can CREATE a Price (Plan 2), because a
    // Price minted against the wrong Product or the wrong cadence agrees on
    // every amount checked below and would read as clean forever.

    if (price.recurring !== undefined && price.recurring !== null) {
      const expected = expectedInterval(lookupKey);
      if (price.recurring.interval !== expected) {
        differences.push({
          kind: "price_shape_mismatch",
          lookupKey,
          field: "interval",
          catalogValue: expected,
          stripeValue: price.recurring.interval,
        });
      }
    }

    // `active === false` is a different fact from "absent" (`price_missing_
    // in_stripe`, above) and must not be conflated with it: reporting an
    // archived Price as missing would tell an operator to create one that
    // already exists.
    if (price.active === false) {
      differences.push({
        kind: "price_shape_mismatch",
        lookupKey,
        field: "active",
        catalogValue: "true",
        stripeValue: "false",
      });
    }

    // SKIPPED, not guessed, when `productsByPlan` is absent — see the
    // parameter doc above. The map comes from a Stripe Product lookup the
    // caller may not have made, and a wrong product finding is worse than no
    // product finding.
    //
    // The same silence applies when the map IS supplied but has no entry for
    // this key's plan: `expectedProductId` is `undefined` and the check below
    // is skipped for this key, not flagged. A plan absent from the map reads
    // as "not checked", never as "missing product" — so whoever wires this map
    // up next should expect silence, not a finding, for a plan they forgot.
    if (productsByPlan) {
      const plan = planOf(lookupKey, namespacePrefix);
      const expectedProductId = productsByPlan[plan];
      const actualProductId = productIdOf(price.product);
      if (
        expectedProductId !== undefined &&
        actualProductId !== null &&
        actualProductId !== expectedProductId
      ) {
        differences.push({
          kind: "price_shape_mismatch",
          lookupKey,
          field: "product",
          catalogValue: expectedProductId,
          stripeValue: actualProductId,
        });
      }
    }

    const stripeCurrencies = coverageOf(price);

    for (const [currency, catalogSide] of catalogCurrencies) {
      const stripeSide = stripeCurrencies.get(currency);
      if (!stripeSide) {
        differences.push({
          kind: "currency_missing_in_stripe",
          lookupKey,
          currency,
          unitAmountMinor: catalogSide.unitAmountMinor,
          taxBehavior: catalogSide.taxBehavior,
        });
        continue;
      }

      // The catalog's amount is NOT NULL and `> 0` by CHECK, so the non-null
      // assertion below is the schema's guarantee rather than an assumption.
      const catalogMinor = catalogSide.unitAmountMinor ?? 0;

      // Amount and tax behaviour are independent facts about the same row and
      // are reported separately. Collapsing them would mean correcting the
      // amount silently closes the tax finding.
      // Compared in STRIPE's representation, not the catalog's — see
      // `toStripeUnitAmount`. Reported in the catalog's, because a report that
      // renamed the catalog's own number would send someone to `catalog.go`
      // looking for a value that is not written there.
      const catalogAsStripeStores = toStripeUnitAmount(currency, catalogMinor, policy);

      if (catalogAsStripeStores !== stripeSide.unitAmountMinor) {
        differences.push({
          kind: "amount_mismatch",
          lookupKey,
          currency,
          catalogUnitAmountMinor: catalogMinor,
          stripeUnitAmountMinor: stripeSide.unitAmountMinor,
          zeroDecimalSuspect: isZeroDecimalSuspect(
            currency,
            catalogAsStripeStores,
            stripeSide.unitAmountMinor,
          ),
        });
      }

      if (catalogSide.taxBehavior !== stripeSide.taxBehavior) {
        differences.push({
          kind: "tax_behavior_mismatch",
          lookupKey,
          currency,
          catalogTaxBehavior: catalogSide.taxBehavior,
          stripeTaxBehavior: stripeSide.taxBehavior,
        });
      }
    }

    for (const [currency, stripeSide] of stripeCurrencies) {
      if (catalogCurrencies.has(currency)) continue;
      differences.push({
        kind: "currency_missing_in_catalog",
        lookupKey,
        currency,
        unitAmountMinor: stripeSide.unitAmountMinor,
        taxBehavior: stripeSide.taxBehavior,
      });
    }
  }

  for (const [lookupKey, price] of stripe) {
    if (catalog.has(lookupKey)) continue;
    differences.push({
      kind: "price_missing_in_catalog",
      lookupKey,
      currencies: [...coverageOf(price).keys()].sort(),
      priceId: price.id,
    });
  }

  differences.sort(
    (a, b) =>
      a.lookupKey.localeCompare(b.lookupKey) ||
      currencyOf(a).localeCompare(currencyOf(b)) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );

  return {
    differences,
    catalogPriceCount: catalog.size,
    stripePriceCount: stripe.size,
  };
}
