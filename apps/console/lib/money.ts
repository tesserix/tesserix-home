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
  //
  // KNOWN WRONG for a Stripe minor-unit amount, left as-is here — this
  // function's blast radius (the federated billing surface, the stat tiles)
  // is wider than any one caller's fix, and correcting it is being filed
  // separately. `resolvedOptions().maximumFractionDigits` answers a CLDR
  // question — how many decimals a LOCALE conventionally shows a currency
  // with — and CLDR data disagrees with Stripe, and with ITSELF across
  // runtimes: IDR resolves to 0 fraction digits under Chrome/en-US and to 2
  // under Node's ICU, while Stripe treats IDR as an ordinary two-decimal
  // currency regardless of any of that (`lib/billing/source-policy.ts`
  // confirms this against live data). A caller that fed this function a real
  // Stripe `unit_amount` for IDR rendered `IDR 1,198,800,000` in production —
  // a hundredfold overstatement — while a Node test asserting the same value
  // passed, because Node's ICU happened to agree with Stripe by accident. Any
  // caller formatting a genuine Stripe amount should derive its exponent from
  // Stripe's own zero-decimal-currency list (`ZERO_DECIMAL_CURRENCIES` in
  // `lib/billing/source-policy.ts`) and pass `minimumFractionDigits` /
  // `maximumFractionDigits` explicitly, the way
  // `app/(console)/platform/billing/catalog/catalog-views.tsx`'s
  // `formatCatalogAmount` now does — never trust this line's guess.
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(value.amount / 10 ** digits);
}
