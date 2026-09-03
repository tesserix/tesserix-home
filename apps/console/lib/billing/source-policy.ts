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
 * THIS IS NOW THE ONLY COPY. It began as a mirror of mark8ly's Go
 * `zeroDecimalCurrencies` map in `internal/billing/stripe/price.go`, held
 * separately rather than imported because the console deliberately does not
 * depend on mark8ly's Go module. That map was deleted with
 * tesserix/mark8ly#639, which retired `billing-bootstrap` and every Stripe
 * product/price WRITE in mark8ly — the console is the sole writer now, so
 * mark8ly no longer needs to convert anything at a Stripe boundary it never
 * reaches.
 *
 * The drift risk the duplication carried is therefore gone, and what
 * replaced it is a single point of failure: if this list is wrong, nothing
 * else holds a copy to disagree with it. Both halves of that trade are worth
 * knowing — there is no second opinion here any more.
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
 * Every catalog source there is, in the order callers should iterate them.
 *
 * An array of one today, and shaped exactly like `STRIPE_MODES` in
 * `stripe-read.ts` for exactly the same reason: the parity check is asked once
 * per (mode, source) pair, so both axes need something a caller can loop over.
 * `STRIPE_MODES` is what makes `readWindowStatus` report BOTH modes rather than
 * only the modes it happened to find rows for; this is the equivalent guarantee
 * on the source axis — see tesserix-home#392, where a mode-keyed run silently
 * covering a second source's catalog is the omission being closed.
 *
 * The value is the same literal `plan_catalog_prices.source` (0035) and
 * `plan_catalog_parity_runs.source` (0044) store, and the same one 0044's
 * `..._source_is_a_known_source` CHECK admits. A source added here without a
 * migration will be rejected by the database rather than written wrongly, which
 * is the intended order of events.
 */
export const CATALOG_SOURCES = ["mark8ly"] as const;

/**
 * Which product's catalog a row belongs to.
 *
 * A union of one today. It exists so the type system says "this is per
 * product" out loud, rather than a second product discovering the assumption
 * by having its prices come out wrong.
 *
 * DERIVED FROM {@link CATALOG_SOURCES} rather than written out again, mirroring
 * `StripeMode`/`STRIPE_MODES` in `stripe-read.ts`. Two independent declarations
 * of the same closed set is the drift this module already argued against for
 * `MARK8LY_LOOKUP_KEY_PREFIX` and for `SINGLE_SOURCE` below; here the drift
 * would be quieter still, because a source added to the array but not the union
 * would fail to typecheck at every call site while a source added to the union
 * but not the array would simply never be iterated — i.e. never checked, which
 * is the #392 failure reintroduced one layer up.
 */
export type CatalogSource = (typeof CATALOG_SOURCES)[number];

/**
 * The conventions a product's catalog follows, which are NOT facts about
 * Stripe.
 */
export interface SourcePolicy {
  /**
   * Does this catalog store zero-decimal amounts multiplied by 100?
   *
   * mark8ly's does, for internal consistency. The division at the Stripe
   * boundary used to happen in mark8ly's own `billing-bootstrap`; since
   * tesserix/mark8ly#639 retired it, this console does it — see
   * {@link toStripeUnitAmount}, which is now the only place the convention
   * is undone before an amount reaches Stripe.
   *
   * It remains a mark8ly decision, not a Stripe rule — and it lived in the
   * shared comparator until 2026-08-27, where a second product storing
   * genuine minor units would have had every VND, JPY and KRW price divided
   * by 100 on write and mis-compared on read. That is why it sits on the
   * per-source policy rather than in the comparator.
   */
  readonly amountsAreScaledBy100: boolean;
  /**
   * The prefix that makes a live Stripe Price this source's, and that makes a
   * `lookup_key` this source's within the shared `plan_catalog_prices` table.
   *
   * A catalog convention, exactly like `amountsAreScaledBy100` above — not a
   * Stripe fact — so it lives on the same per-source record rather than
   * behind a second `prefixFor()` lookup beside `policyFor`. `parity.ts`
   * previously hard-coded `MARK8LY_LOOKUP_KEY_PREFIX` as the comparator's
   * only default; that constant is now DERIVED from this field (see that
   * module) so the string exists in exactly one place.
   */
  readonly lookupKeyPrefix: string;
  /**
   * The brand this source's Stripe Products are named after.
   *
   * `createProduct` used to hardcode `"Mark8ly " + plan`. That was correct
   * while `mark8ly` was the only source and silently wrong the moment it
   * was not: a second source's Product would have been created named
   * "Mark8ly ...". A product name is customer-visible in Stripe and there
   * is no product-merge to undo it with, so this is a fact about the
   * SOURCE, exactly like the two above, and belongs on the same record.
   *
   * This is a DEFAULT, not the final word. tesserix-home#327's redesign
   * work introduces an operator-confirmed product name read from the live
   * Stripe account rather than generated; until that lands this keeps the
   * generated name at least correct per source instead of correct only by
   * coincidence.
   */
  readonly productBrand: string;
}

const POLICIES: Record<CatalogSource, SourcePolicy> = {
  mark8ly: { amountsAreScaledBy100: true, lookupKeyPrefix: "mark8ly_", productBrand: "Mark8ly" },
};

/**
 * The one source that exists today, exported so every real caller that must
 * currently pick a source — `bootstrap.ts`'s `runBootstrap`, the catalog
 * surface's `page.tsx`, `publish-executor.ts`'s default deps — shares ONE
 * literal rather than each hardcoding `"mark8ly"` separately.
 *
 * `parity-run.ts`'s `performParityCheck` WAS one of these callers and is no
 * longer: since tesserix-home#392 it takes the source as a parameter and its
 * two runners loop over {@link CATALOG_SOURCES}. That is the distinction the
 * last paragraph below draws, now with an example on each side of it.
 *
 * That collapse matters here specifically: this module already collapsed
 * `MARK8LY_LOOKUP_KEY_PREFIX` from a second literal into one derived value
 * (see `parity.ts`), on the reasoning that a fact repeated in multiple files
 * is a fact that can drift when only some of the copies are updated. A
 * hardcoded `"mark8ly"` at each of those call sites is the identical risk one
 * axis over — the day a second source lands, every one of them must be found
 * and changed together, and a constant is the only way "found together" is
 * guaranteed rather than hoped for.
 *
 * Lives beside `policyFor` rather than in `parity-run.ts`: it is a fact
 * about the CATALOG (which source's rows exist), not about the parity
 * runner, and `bootstrap.ts` / `page.tsx` have no reason to import
 * `parity-run.ts` — a module that reaches `stripe-read.ts` and `pg` through
 * `plan-catalog-repo.ts` — just to read a constant. `parity-run.ts` used to
 * re-export it for its own importers; it no longer does, because since
 * tesserix-home#392 it has no use for the constant itself and every importer
 * already takes it from here.
 *
 * NOT the same thing as {@link CATALOG_SOURCES}, and the difference is the
 * whole of tesserix-home#392. This constant is for a caller that must pick ONE
 * source because it has nowhere to put a second answer — a page rendering one
 * catalog, a bootstrap run seeding one product. `CATALOG_SOURCES` is for a
 * caller that must cover ALL of them, which is what the parity check is. The
 * two are indistinguishable while the array has one element, which is exactly
 * why they are named apart now rather than once a second source makes the
 * distinction expensive.
 */
export const SINGLE_SOURCE: CatalogSource = "mark8ly";

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
