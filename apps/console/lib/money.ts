/**
 * Money, and how to render it.
 *
 * # Why this is its own module
 *
 * It imports NOTHING. That is the entire point: `lib/billing.ts` imports
 * `PlatformApiError` from `lib/platform-api.ts`, which reaches
 * `lib/auth/platform-token.ts` → `@tesserix/platform-auth` → `pg` and
 * `node:crypto`. A client component importing a *value* from `lib/billing.ts`
 * therefore drags all of that into the browser bundle and fails the build.
 *
 * The other surfaces got away with it by importing only `import type` from
 * their lib modules — types are erased, so no runtime edge exists. `formatMoney`
 * is a real function, so it needs a home with no server-side ancestry.
 *
 * `tsc` and the whole jsdom suite pass either way; only `next build` sees it.
 */

/**
 * §4.2's shape: minor units with an explicit currency, never a bare number.
 *
 * §8.2 warns this is the endpoint most likely to be handed a bare number,
 * *because* Stripe amounts already arrive in minor units and the temptation is
 * to pass them through uncurrencied. A bare 4900 is 49 dollars or 49 rupees
 * depending on a fact the payload no longer carries.
 */
export interface Money {
  /** MINOR units — cents, paise. Never a decimal. */
  readonly amount: number;
  readonly currency: string;
}

let knownCurrencies: ReadonlySet<string> | null = null;

/**
 * The currency codes this runtime actually knows the exponent for.
 *
 * Checked EXPLICITLY rather than relying on `Intl` to throw, because it does
 * not: `Intl.NumberFormat` accepts any well-formed three-letter code and
 * renders an unknown one as `ZZZ 1.00` — silently assuming two decimal places.
 * On a money surface that is the worst possible failure, because 100 minor
 * units become "1.00" and the output looks entirely reasonable.
 *
 * Computed once; `supportedValuesOf` builds a sizable array.
 */
function isKnownCurrency(code: string): boolean {
  if (knownCurrencies === null) {
    try {
      knownCurrencies = new Set(Intl.supportedValuesOf("currency"));
    } catch {
      // No `supportedValuesOf` in this runtime. An empty set sends every code
      // down the raw-pair path — uglier, and never wrong by a factor of a
      // hundred.
      knownCurrencies = new Set<string>();
    }
  }
  return knownCurrencies.has(code);
}

/**
 * Render money in its own currency.
 *
 * The payload's currency, not a hardcoded symbol: the estate already spans
 * AUD, INR and USD, and a "$" prefix would be wrong for two of the three.
 */
export function formatMoney(value: Money | undefined): string {
  if (!value) return "—";

  // An unrecognised code is the product's problem to fix, not this renderer's
  // to hide. Showing the raw pair is honest and diagnosable; a confident wrong
  // number is neither.
  if (!isKnownCurrency(value.currency)) {
    return `${value.amount} ${value.currency}`;
  }

  const format = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: value.currency,
  });
  // The currency's OWN exponent, not a hardcoded /100: JPY has no minor unit
  // at all, so a constant would be wrong by a factor of a hundred there.
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(value.amount / 10 ** digits);
}
