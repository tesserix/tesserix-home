// `server-only`: this module holds a Stripe API credential and speaks to
// Stripe over the network. A client component that reaches it must fail the
// build loudly, naming the import chain, rather than being bundled — the same
// guard `lib/auth/operator-token-store.ts` and `lib/db/tesserix.ts` carry, for
// the same reason.
import "server-only";

import Stripe from "stripe";

import type { StripePriceLike } from "./parity";

/**
 * The console's ONLY way to reach Stripe — and it reads Prices.
 *
 * # Why the surface is this small
 *
 * #326's definition of done says "no write path to Stripe anywhere in this
 * change", and P2 revokes mark8ly's Stripe write key on the strength of the
 * 7-day window this check opens. So read-only has to be true by CONSTRUCTION,
 * not by review:
 *
 *  - {@link StripePriceReader} declares ONE method. `create`, `update`, `del`
 *    and `archive` are not "present but unused", they are ABSENT — a future
 *    edit cannot quietly acquire one without adding a method to a type whose
 *    entire purpose is visibly to have none, and `stripe-read.test.ts` fails by
 *    name if it tries.
 *  - The `Stripe` instance below is PRIVATE to this module and is never
 *    returned, exported, or attached to anything that is. Handing it back —
 *    from an export, a getter, a `client` property — would give every caller
 *    the full write API in one move, and narrowing the reader's own surface
 *    would then be decoration.
 *
 * # The credential
 *
 * A Stripe RESTRICTED key, scoped to read on Products and Prices — decided on
 * the issue. Nothing here assumes more than that scope: no `expand` of
 * `data.product`, no Product listing, no Subscription reads. If the key is
 * ever widened, this module must not be the reason.
 */

/**
 * The environment variable carrying the restricted key.
 *
 * Named in the failure message on purpose. This secret is provisioned
 * separately from every other credential the console holds, so "which variable"
 * is the entire question an operator has when they read a `failed` parity run,
 * and Stripe's own constructor error ("Neither apiKey nor config.authenticator
 * provided") does not answer it.
 */
const KEY_ENV = "STRIPE_RESTRICTED_READ_KEY";

/**
 * The API version this code was written against.
 *
 * PINNED, not inherited from the account's default. An account-level version
 * bump is a thing someone else does, on a different day, for a different
 * reason — and `currency_options` and the `tax_behavior` enum are exactly the
 * fields whose shape the comparator depends on. A silent reshape there turns
 * every run into differences without anything in this repo changing.
 */
const API_VERSION = "2025-10-29.clover";

/**
 * The ceiling on how many Prices one run will read.
 *
 * The catalog expects 42 and the namespace filter drops the rest, so this is a
 * runaway guard rather than a page size: a shared account that has grown tens
 * of thousands of Prices should make the run fail visibly on the cap rather
 * than page for minutes inside a CronJob's timeout.
 *
 * Exported so the test asserts the pagination is bounded rather than trusting
 * it.
 */
export const MAX_PRICES = 1000;

/** How many Prices Stripe returns per HTTP round trip. 100 is its maximum. */
const PAGE_SIZE = 100;

/** Raised when the credential is absent. Distinguishable by the route, which
 *  records the reason on the `failed` run rather than a stack trace. */
export class StripeReadUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeReadUnavailableError";
  }
}

/**
 * The private instance. Module-scoped, never exported, never returned.
 *
 * Memoised against the key it was built with rather than built once: like
 * `isDatabaseConfigured`, the environment is read at CALL time so the module
 * can be imported during the window before the chart supplies the variable
 * without throwing on import and taking the console down with it. Keying the
 * cache on the value means a rotated key takes effect without a restart, and
 * means the tests are not fighting a client built under a previous stub.
 */
let cached: { key: string; client: Stripe } | null = null;

function client(): Stripe {
  const key = process.env[KEY_ENV];
  if (!key || key.length === 0) {
    throw new StripeReadUnavailableError(
      `${KEY_ENV} is not set; the plan catalog parity check cannot read Stripe Prices`,
    );
  }
  if (cached?.key === key) return cached.client;
  const client = new Stripe(key, {
    apiVersion: API_VERSION as Stripe.StripeConfig["apiVersion"],
    // Named so a restricted key's requests are identifiable in Stripe's own
    // logs. It is the only place this check announces itself to the account.
    appInfo: { name: "tesserix-console plan-catalog-parity" },
    maxNetworkRetries: 2,
  });
  cached = { key, client };
  return client;
}

/**
 * The entire Stripe surface this estate has.
 *
 * ONE method. See the module header before adding a second.
 */
export interface StripePriceReader {
  listPrices(): Promise<StripePriceLike[]>;
}

export const stripePriceReader: StripePriceReader = {
  async listPrices(): Promise<StripePriceLike[]> {
    const prices = await client()
      .prices.list({
        // ACTIVE ONLY. An archived Price is drift the catalog should see as
        // `price_missing_in_stripe`; including archived ones would let a
        // retired Price go on matching its catalog row forever. It is also
        // what makes `lookup_key` unique in the result, which the comparator
        // relies on.
        active: true,
        limit: PAGE_SIZE,
        // WITHOUT THIS THE CHECK IS WRONG, SILENTLY. Stripe omits
        // `currency_options` unless it is expanded, so the six `developed`
        // Prices would read as covering one currency each and the comparator
        // would open with 36 phantom `currency_missing_in_stripe` findings —
        // 36 false positives on day one of a window that only means anything
        // if people read it.
        expand: ["data.currency_options"],
      })
      .autoPagingToArray({ limit: MAX_PRICES });
    // `Stripe.Price` satisfies `StripePriceLike` structurally; the assignment
    // is checked at compile time in `parity.test.ts`. No adapter, because an
    // adapter is one more place `currency_options` could be dropped.
    return prices;
  },
};
