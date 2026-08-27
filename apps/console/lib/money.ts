/**
 * Money, and how to render it.
 *
 * # Why this is (almost) its own module
 *
 * It imports almost nothing. That matters because `lib/billing.ts` imports
 * `PlatformApiError` from `lib/platform-api.ts`, which reaches
 * `lib/auth/platform-token.ts` → `@tesserix/platform-auth` → `pg` and
 * `node:crypto`. A client component importing a *value* from `lib/billing.ts`
 * therefore drags all of that into the browser bundle and fails the build.
 *
 * The other surfaces got away with it by importing only `import type` from
 * their lib modules — types are erased, so no runtime edge exists. `formatMoney`
 * is a real function, so it needs a home with no server-side ancestry.
 *
 * The ONE import this module now carries — `ZERO_DECIMAL_CURRENCIES` from
 * `./billing/source-policy` — is safe for exactly this reason and no other:
 * `source-policy.ts` itself has ZERO imports (verified before adding this),
 * so it cannot smuggle `pg`, `stripe`, or anything server-only in behind it.
 * If a future edit ever gives `source-policy.ts` an import of its own, THIS
 * import becomes precisely the client-bundle hazard the header above warns
 * about — the fix then is to keep `source-policy.ts` import-free (revert
 * whatever it just gained), not to "simplify" this into importing from
 * `lib/billing.ts` instead.
 *
 * `tsc` and the whole jsdom suite pass either way; only `next build` sees it.
 */

import { ZERO_DECIMAL_CURRENCIES } from "./billing/source-policy";

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
 * How many decimal places a MINOR-UNIT amount in `currency` divides by — 0
 * for a zero-decimal currency (JPY, VND, ...), 2 for every other currency
 * ISO 4217 defines.
 *
 * Case-insensitive on purpose: `ZERO_DECIMAL_CURRENCIES` is keyed lowercase
 * (the plan catalog's own storage convention), while this module's existing
 * callers hand `formatMoney` an uppercase code (`billing-views.tsx`'s own
 * fixtures use `"AUD"`) — this is the one place that difference is reconciled
 * rather than assumed away.
 *
 * NEVER derived from `Intl`. This replaced
 * `Intl.NumberFormat(...).resolvedOptions().maximumFractionDigits`, which
 * answers a CLDR question — how many decimals a LOCALE conventionally shows a
 * currency with — not an ISO 4217 one. The two disagree for IDR (CLDR says 0,
 * informally, because the sen is obsolete in practice; ISO says 2), and CLDR
 * disagrees with ITSELF across runtimes: Chrome's en-US locale resolves IDR
 * to 0 fraction digits, Node's ICU resolves it to 2. A caller that fed the old
 * `formatMoney` a real minor-unit amount for IDR rendered `IDR 1,198,800,000`
 * in production — a hundredfold overstatement — while a Node test asserting
 * the same value passed, because Node's ICU happened to agree with the
 * correct answer by accident. `ZERO_DECIMAL_CURRENCIES` is hard-coded and
 * versioned against Stripe's own API (see its own header comment) and is the
 * one legitimate source for this decision — imported, not copied, so this
 * module and the plan catalog's `formatCatalogAmount` cannot silently
 * disagree with each other the way this function and CLDR did.
 */
export function minorUnitExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase()) ? 0 : 2;
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

  // `minimumFractionDigits`/`maximumFractionDigits` passed explicitly, both
  // pinned to the SAME `minorUnitExponent` this function divides by — `Intl`
  // is left responsible for the symbol and the digit grouping only, and
  // cannot reintroduce its own CLDR-derived decimal count through the back
  // door of the formatter's own default.
  const digits = minorUnitExponent(value.currency);
  const format = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return format.format(value.amount / 10 ** digits);
}
