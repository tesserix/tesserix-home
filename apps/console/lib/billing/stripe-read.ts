// `server-only`: this module holds Stripe API credentials and speaks to
// Stripe over the network. A client component that reaches it must fail the
// build loudly, naming the import chain, rather than being bundled — the same
// guard `lib/auth/operator-token-store.ts` and `lib/db/tesserix.ts` carry, for
// the same reason.
import "server-only";

import Stripe from "stripe";

import type { StripePriceLike } from "./parity";

/**
 * The console's ONLY way to reach Stripe — and it reads Prices, in either mode.
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
 *  - The `Stripe` instances below are PRIVATE to this module and are never
 *    returned, exported, or attached to anything that is. Handing one back —
 *    from an export, a getter, a `client` property — would give every caller
 *    the full write API in one move, and narrowing the reader's own surface
 *    would then be decoration.
 *
 * # Two modes, and no coupling between them
 *
 * Test and live are separate Stripe accounts with separate catalogs, and as of
 * 2026-08-27 only test has ever been bootstrapped. So the two credentials are
 * INDEPENDENTLY OPTIONAL, and the independence is the design constraint:
 *
 *  - A missing key fails THAT MODE, at call time, with a message naming that
 *    mode's variable. It does not throw on import and does not touch the other
 *    mode. Live may have no restricted key for months; that must cost live's
 *    row and nothing else, because taking test down with it would forfeit
 *    every clean day test has accumulated.
 *  - The memo is keyed on mode AND on the key's value, so rotating one
 *    credential neither requires a restart nor evicts the other's client.
 *
 * # The credentials
 *
 * Stripe RESTRICTED keys, scoped to read on Products and Prices — decided on
 * the issue. Nothing here assumes more than that scope: no `expand` of
 * `data.product`, no Product listing, no Subscription reads. If a key is ever
 * widened, this module must not be the reason.
 */

/**
 * Stripe's two modes. Not a boolean, because these are names that appear in a
 * database column, a log line and an operator's vocabulary — and `isLive:
 * false` reads as an assertion where `"test"` reads as a fact.
 *
 * Test first: it is the order the runners iterate in, the order the logs come
 * out in, and it puts the mode that actually has a catalog today first.
 */
export const STRIPE_MODES = ["test", "live"] as const;

export type StripeMode = (typeof STRIPE_MODES)[number];

/**
 * The environment variable carrying each mode's restricted key.
 *
 * Named in the failure message on purpose, and EXPORTED so the failure message
 * and the chart's env block can be checked against one source rather than two
 * string literals that agree today. These secrets are provisioned separately
 * from every other credential the console holds and separately from each
 * other, so "which variable" is the entire question an operator has when they
 * read a `failed` parity run — and Stripe's own constructor error ("Neither
 * apiKey nor config.authenticator provided") does not answer it.
 */
export const KEY_ENV: Record<StripeMode, string> = {
  test: "STRIPE_RESTRICTED_READ_KEY_TEST",
  live: "STRIPE_RESTRICTED_READ_KEY_LIVE",
};

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

/** Raised when a mode's credential is absent, or is a credential for the other
 *  mode. Distinguishable by the runners, which record the reason on that
 *  mode's `failed` run rather than a stack trace. */
export class StripeReadUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeReadUnavailableError";
  }
}

/**
 * True when a caught value is this module refusing to read a mode.
 *
 * Matched STRUCTURALLY on `name`, never with `instanceof`, and walking one
 * `cause` chain — the same discipline `isUndefinedTable` (`db-read-error.ts`)
 * applies to a SQLSTATE, for the same two reasons: a caller may wrap this
 * error to add context, and `instanceof` is a lie across two module instances
 * (a mocked module in a test, a re-bundled copy in a server component).
 *
 * Exists so a CALLER can tell "Stripe was never reached, and no retry will
 * change that" apart from a genuine failure, without importing the class into
 * a position where it has to reason about this module's `stripe` dependency.
 */
export function isStripeReadUnavailable(caught: unknown): boolean {
  for (let value = caught, depth = 0; value !== null && value !== undefined && depth < 4; depth++) {
    if (typeof value !== "object") return false;
    if ((value as { name?: unknown }).name === "StripeReadUnavailableError") return true;
    value = (value as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The mode a key announces in its own prefix, or null if it announces none.
 *
 * Stripe puts the mode in the same position for every key class — `sk_live_`,
 * `pk_test_`, `rk_live_` — so this keys off the mode and ignores the class.
 *
 * NULL IS A DELIBERATE ANSWER, not a failure. Only a prefix that CONTRADICTS
 * its slot is worth refusing; an unrecognised shape is not evidence of
 * anything, Stripe has introduced prefixes before, and this module must not be
 * the reason a new one is unusable. Stripe's own 401 is the right authority on
 * a key it does not accept.
 */
function announcedMode(key: string): StripeMode | null {
  const match = /^(?:sk|pk|rk)_(live|test)_/.exec(key);
  return match ? (match[1] as StripeMode) : null;
}

/**
 * The private instances, one per mode. Module-scoped, never exported, never
 * returned.
 *
 * Memoised against the key each was built with rather than built once: like
 * `isDatabaseConfigured`, the environment is read at CALL time so the module
 * can be imported during the window before the chart supplies the variables
 * without throwing on import and taking the console down with it. Keying the
 * cache on the value means a rotated key takes effect without a restart, and
 * means the tests are not fighting a client built under a previous stub.
 *
 * A MAP RATHER THAN A SINGLE SLOT, and that is not tidiness: with one slot the
 * two modes would evict each other on every alternating call, rebuilding both
 * clients every night and making "was this key rotated?" unanswerable from the
 * cache's behaviour.
 */
const clients = new Map<StripeMode, { key: string; client: Stripe }>();

function client(mode: StripeMode): Stripe {
  const variable = KEY_ENV[mode];
  const key = process.env[variable];
  if (!key || key.length === 0) {
    throw new StripeReadUnavailableError(
      `${variable} is not set; the plan catalog parity check cannot read ${mode} mode Stripe Prices`,
    );
  }

  // Checked BEFORE the memo and before the constructor, so a mix-up costs a
  // `failed` row rather than a confident comparison against the wrong account.
  // That mix-up cost an hour on 2026-08-27 — a `rk_live_` key read as the test
  // credential, reporting an empty account against a 42-price catalog. A wrong
  // answer delivered confidently is strictly worse than no answer: nothing in
  // the report reveals it.
  const announced = announcedMode(key);
  if (announced !== null && announced !== mode) {
    throw new StripeReadUnavailableError(
      // The key itself is NEVER quoted. This message lands in the `error`
      // column, which an operator reads and which outlives the run.
      `${variable} holds a ${announced} mode key but is read as the ${mode} mode credential; ` +
        `refusing to compare the ${mode} catalog against the ${announced} account`,
    );
  }

  const cached = clients.get(mode);
  if (cached?.key === key) return cached.client;

  const created = new Stripe(key, {
    apiVersion: API_VERSION as Stripe.StripeConfig["apiVersion"],
    // Named so a restricted key's requests are identifiable in Stripe's own
    // logs. It is the only place this check announces itself to the account.
    appInfo: { name: "tesserix-console plan-catalog-parity" },
    maxNetworkRetries: 2,
  });
  clients.set(mode, { key, client: created });
  return created;
}

/**
 * The entire Stripe surface this estate has.
 *
 * ONE method. See the module header before adding a second.
 *
 * The mode is a REQUIRED parameter rather than a defaulted one. A default
 * would make `listPrices()` compile at a call site that had simply forgotten
 * which account it meant, and the resulting row would name a mode it did not
 * check.
 */
export interface StripePriceReader {
  listPrices(mode: StripeMode): Promise<StripePriceLike[]>;
}

export const stripePriceReader: StripePriceReader = {
  async listPrices(mode: StripeMode): Promise<StripePriceLike[]> {
    const prices = await client(mode)
      .prices.list({
        // ACTIVE ONLY. An archived Price is drift the catalog should see as
        // `price_missing_in_stripe`; including archived ones would let a
        // retired Price go on matching its catalog row forever. It is also
        // what makes `lookup_key` unique in the result, which the comparator
        // relies on.
        //
        // This is also why `parity.ts`'s `price_shape_mismatch("active")`
        // branch cannot fire against a live read today: this filter never
        // lets an archived Price reach the comparator in the first place. If
        // this filter is ever relaxed, an archived Price is reported as
        // `price_shape_mismatch`, NOT `price_missing_in_stripe` — see that
        // branch's comment for why the two must not be conflated.
        active: true,
        limit: PAGE_SIZE,
        // WITHOUT THIS THE CHECK IS WRONG, SILENTLY. Stripe omits
        // `currency_options` unless it is expanded, so the six `developed`
        // Prices would read as covering one currency each and the comparator
        // would open with 36 phantom `currency_missing_in_stripe` findings —
        // 36 false positives on day one of a window that only means anything
        // if people read it.
        //
        // NO expand IS NEEDED for `active`, `product` or `recurring` — Stripe
        // returns all three on every Price by default (`product` as a plain
        // id string, since it is not expanded). `StripePriceLike` used to
        // declare only the fields the comparator read and silently discard
        // the rest; it now carries them so the shape check in `parity.ts` can
        // catch a Price minted against the wrong Product or the wrong
        // interval — a mistake that agrees on every amount.
        expand: ["data.currency_options"],
      })
      .autoPagingToArray({ limit: MAX_PRICES });
    // `Stripe.Price` satisfies `StripePriceLike` structurally; the assignment
    // is checked at compile time in `parity.test.ts`. No adapter, because an
    // adapter is one more place `currency_options` could be dropped.
    return prices;
  },
};
