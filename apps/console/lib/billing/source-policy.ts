/**
 * Stripe's zero-decimal currencies — the ones with no minor unit at all,
 * where a `unit_amount` of 329000 means 329,000 of the currency and not
 * 3,290.00.
 *
 * HARD-CODED, and hard-coded on purpose: this is a fact about Stripe's API,
 * not about the catalog, and it is versioned — ISK was on this list until
 * Stripe moved it to two decimals in 2021. Deriving it from `Intl` would be
 * worse, not better: `Intl` answers a question about the CURRENCY, and Stripe
 * has repeatedly answered a different one about its own API.
 *
 * VND IS HERE. IDR IS NOT, AND THAT IS NOT AN OMISSION. Confirmed against
 * live data on 2026-08-27: six VND rows differed from Stripe by exactly 100x
 * and zero IDR rows did, across the same 36 PPP amounts. IDR has two decimal
 * places in Stripe, so mark8ly's x100 storage convention is simply correct
 * there and needs no conversion; VND has none, so the x100 must be undone
 * before comparing — see {@link toStripeUnitAmount}.
 *
 * Mirrors mark8ly's Go `zeroDecimalCurrencies` map
 * (`internal/billing/stripe/price.go`) rather than importing it — the console
 * deliberately does not depend on mark8ly's Go module. The two held the
 * identical 16 currencies when last checked; if they ever diverge, this check
 * REPORTS the difference rather than hiding it.
 *
 * MOVED HERE FROM `parity.ts`, and the direction matters: `parity.ts` imports
 * this module, so importing back would be a cycle. This is also the more
 * honest home — the SET is a Stripe fact and the SCALING (below) is a product
 * convention, and they belong in the same file precisely so the difference
 * between them stays visible.
 *
 * `parity.ts` re-exports it so existing importers keep working.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

/**
 * Which product's catalog a row belongs to.
 *
 * A union of one today. It exists so the type system says "this is per
 * product" out loud, rather than a second product discovering the assumption
 * by having its prices come out wrong.
 */
export type CatalogSource = "mark8ly";

/**
 * The conventions a product's catalog follows, which are NOT facts about
 * Stripe.
 */
export interface SourcePolicy {
  /**
   * Does this catalog store zero-decimal amounts multiplied by 100?
   *
   * mark8ly's does, for internal consistency, and `billing-bootstrap` divides
   * at the Stripe boundary (`internal/billing/stripe/price.go`). That is a
   * mark8ly decision, not a Stripe rule — and it lived in the shared
   * comparator until 2026-08-27, where a second product storing genuine minor
   * units would have had every VND, JPY and KRW price divided by 100 on write
   * and mis-compared on read.
   */
  readonly amountsAreScaledBy100: boolean;
}

const POLICIES: Record<CatalogSource, SourcePolicy> = {
  mark8ly: { amountsAreScaledBy100: true },
};

export function policyFor(source: CatalogSource): SourcePolicy {
  return POLICIES[source];
}

/**
 * A catalog amount expressed the way Stripe stores it.
 *
 * The zero-decimal SET is a Stripe fact and stays shared. The x100
 * CONVENTION is the product's and arrives via `policy`.
 */
export function toStripeUnitAmount(
  currency: string,
  catalogMinor: number,
  policy: SourcePolicy,
): number {
  if (!policy.amountsAreScaledBy100) return catalogMinor;
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? catalogMinor / 100 : catalogMinor;
}
