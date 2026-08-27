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

/**
 * Stripe's zero-decimal currencies — the ones with no minor unit at all, where
 * a `unit_amount` of 329000 means 329,000 of the currency and not 3,290.00.
 *
 * HARD-CODED, and hard-coded on purpose: this is a fact about Stripe's API,
 * not about the catalog, and it is versioned — ISK was on this list until
 * Stripe moved it to two decimals in 2021. Deriving it from `Intl` would be
 * worse, not better: `Intl` answers a question about the CURRENCY, and Stripe
 * has repeatedly answered a different one about its own API.
 *
 * VND IS HERE. IDR IS NOT, AND THAT IS NOT AN OMISSION. `catalog.go:159`
 * claims Stripe stores IDR and VND x100. IDR has two decimal places in Stripe,
 * so x100 is simply correct there. VND has none, so x100 means d32,900,000 for
 * a plan priced at d329,000. That open question is what
 * {@link AmountDifference.zeroDecimalSuspect} exists to surface — see the note
 * on {@link compareCatalogToStripe} about why this comparator does not fix it.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

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

export type Difference =
  | PriceDifference
  | CurrencyDifference
  | AmountDifference
  | TaxBehaviorDifference;

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
 * Exactly a factor of 100 apart, in either direction, on a currency Stripe
 * treats as zero-decimal.
 *
 * This function decides whether a difference is LABELLED, and nothing more.
 * The amounts themselves are reported verbatim; see
 * {@link compareCatalogToStripe}.
 */
function isZeroDecimalSuspect(
  currency: string,
  catalogMinor: number,
  stripeMinor: number | null,
): boolean {
  if (stripeMinor === null) return false;
  if (!ZERO_DECIMAL_CURRENCIES.has(currency)) return false;
  return catalogMinor === stripeMinor * 100 || stripeMinor === catalogMinor * 100;
}

/** Rank for the deterministic ordering below. Stable across runs, so two
 *  stored reports diff cleanly instead of shuffling. */
const KIND_ORDER: Record<DifferenceKind, number> = {
  price_missing_in_stripe: 0,
  price_missing_in_catalog: 1,
  currency_missing_in_stripe: 2,
  currency_missing_in_catalog: 3,
  amount_mismatch: 4,
  tax_behavior_mismatch: 5,
};

function currencyOf(difference: Difference): string {
  return "currency" in difference ? difference.currency : "";
}

/**
 * Compare the local catalog against live Stripe Prices.
 *
 * # It does not normalise, scale, or special-case anything
 *
 * Amounts are compared and reported VERBATIM. That is a decision, not an
 * oversight: the open VND question — whether mark8ly's x100 is wrong for a
 * zero-decimal currency — is a question about mark8ly's catalog, and a
 * comparator that "helpfully" scaled it would make the answer invisible in
 * exactly the report that exists to surface it. Instead the difference is
 * reported at full size and, when it is a factor of 100 on a zero-decimal
 * currency, labelled {@link AmountDifference.zeroDecimalSuspect} — so it lands
 * as a named, legible finding rather than an unexplained number.
 *
 * Fixing it is explicitly out of scope here and belongs to mark8ly.
 *
 * # What it ignores
 *
 * Live Prices with no `lookup_key`, and live Prices whose key is outside
 * {@link MARK8LY_LOOKUP_KEY_PREFIX}. The account is shared; the rest of it is
 * not this check's business.
 *
 * @param namespacePrefix overridable for tests and for a future second
 *   product's catalog. It is the only knob, on purpose.
 */
export function compareCatalogToStripe(
  catalogAmounts: readonly CatalogAmount[],
  stripePrices: readonly StripePriceLike[],
  namespacePrefix: string = MARK8LY_LOOKUP_KEY_PREFIX,
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
      if (catalogMinor !== stripeSide.unitAmountMinor) {
        differences.push({
          kind: "amount_mismatch",
          lookupKey,
          currency,
          catalogUnitAmountMinor: catalogMinor,
          stripeUnitAmountMinor: stripeSide.unitAmountMinor,
          zeroDecimalSuspect: isZeroDecimalSuspect(
            currency,
            catalogMinor,
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
