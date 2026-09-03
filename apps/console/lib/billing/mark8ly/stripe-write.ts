// `server-only`: this module holds a Stripe API credential capable of
// WRITING to the account and speaks to Stripe over the network. A client
// component that reaches it must fail the build loudly, naming the import
// chain, rather than being bundled — the same guard `../stripe-read.ts`
// carries, doubled: a leak here does not misreport the catalog, it creates
// objects in the wrong account.
import "server-only";

import Stripe from "stripe";

import { expectedInterval } from "../parity";
import type { TaxBehavior } from "../parity";
import type { StripeMode } from "../stripe-read";

/**
 * The console's ONLY way to WRITE to Stripe — Products and Prices, in either
 * mode.
 *
 * # Why the surface is this small
 *
 * `../stripe-read.ts` exists because #326 needed a read-only comparator with
 * NO write path anywhere in that change. This module is the write path the
 * catalog bootstrap (Task B) actually needs, and the same discipline applies
 * in reverse: the surface is exactly the six operations the publish plan
 * (design spec §4) needs — `findProductByPlan`, `createProduct`,
 * `createPrice`, `addCurrencyOption`, `updatePriceTaxBehavior`,
 * `archivePrice` — and no more, so a seventh cannot arrive quietly:
 *
 *  - The `Stripe` instances below are PRIVATE to this module and are never
 *    returned, exported, or attached to anything that is. Handing one back
 *    would give every caller the full write API in one move.
 *  - Every method returns only the small shape its caller needs (`{ id }`),
 *    never the raw SDK object graph a caller could hold onto and write
 *    through.
 *
 * # Amount conversion is the CALLER's job
 *
 * Every `unitAmount` this module accepts — on {@link CreatePriceSpec} and on
 * {@link StripeCatalogWriter.addCurrencyOption} — MUST already be in
 * Stripe's own minor-unit convention. `toStripeUnitAmount`
 * (`../source-policy.ts`) is where that conversion happens, and it happens
 * BEFORE the caller reaches this module. This module must not be able to
 * think it converts: it does not know the catalog's `amountsAreScaledBy100`
 * convention and never will.
 *
 * # Idempotency keys are the CALLER's job too
 *
 * This module never mints one. It only forwards whatever it is given as a
 * Stripe request option. The console's idempotency keys are namespaced by
 * the caller (see Task B) — inventing one here would be a second, competing
 * source of the same key.
 */

export const WRITE_KEY_ENV: Record<StripeMode, string> = {
  test: "STRIPE_WRITE_KEY_TEST",
  live: "STRIPE_WRITE_KEY_LIVE",
};

/** The API version this code was written against. PINNED — see
 *  `../stripe-read.ts`'s `API_VERSION` for why an account-level default is
 *  the wrong source. */
const API_VERSION = "2025-10-29.clover";

/** Raised when a mode's write credential is absent, or is a credential for
 *  the other mode. Distinguishable from `StripeReadUnavailableError` so a
 *  caller that only ever expects to read cannot catch a write failure by
 *  accident. */
export class StripeWriteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeWriteUnavailableError";
  }
}

/**
 * The mode a key announces in its own prefix, or null if it announces none.
 *
 * Mirrors `../stripe-read.ts`'s `announcedMode`: NULL IS A DELIBERATE
 * ANSWER, not a failure. Only a prefix that CONTRADICTS its slot is worth
 * refusing.
 */
function announcedMode(key: string): StripeMode | null {
  const match = /^(?:sk|pk|rk)_(live|test)_/.exec(key);
  return match ? (match[1] as StripeMode) : null;
}

// Module-private and NEVER returned. Returning it hands every caller the
// full write API and makes the six-method surface decorative. Keyed on
// mode AND on the key's value — see `../stripe-read.ts`'s `clients` for why
// a single slot is wrong: it would evict one mode's client on every call
// that alternates modes.
const clients = new Map<StripeMode, { key: string; client: Stripe }>();

function client(mode: StripeMode): Stripe {
  const variable = WRITE_KEY_ENV[mode];
  const key = process.env[variable];
  if (!key || key.length === 0) {
    throw new StripeWriteUnavailableError(
      `${variable} is not set; the catalog bootstrap cannot write ${mode} mode Stripe objects`,
    );
  }

  const announced = announcedMode(key);
  if (announced !== null && announced !== mode) {
    throw new StripeWriteUnavailableError(
      // The key itself is NEVER quoted. This message lands in the run's
      // error output, which an operator reads and which outlives the run.
      `${variable} holds a ${announced} mode key but is read as the ${mode} mode credential; ` +
        `refusing to write to the ${mode} catalog using the ${announced} account`,
    );
  }

  const cached = clients.get(mode);
  if (cached?.key === key) return cached.client;

  const created = new Stripe(key, {
    apiVersion: API_VERSION as Stripe.StripeConfig["apiVersion"],
    appInfo: { name: "tesserix-console plan-catalog-bootstrap" },
    maxNetworkRetries: 2,
  });
  clients.set(mode, { key, client: created });
  return created;
}

/** The shape `findProductByPlan` and `createProduct` hand back — the id and
 *  nothing else the caller could write through. */
export interface StripeProductRef {
  readonly id: string;
}

/** The shape `createPrice` and `addCurrencyOption` hand back. */
export interface StripePriceRef {
  readonly id: string;
}

/**
 * What `createPrice` needs to mint one Stripe Price.
 *
 * `unitAmount` and every value in `currencyOptions` MUST already be in
 * Stripe's minor-unit convention — see the module header. This type does not
 * carry the catalog's `amountsAreScaledBy100` convention and never will;
 * converting is the caller's job, done via `toStripeUnitAmount` before the
 * spec is built.
 */
export interface CreatePriceSpec {
  readonly productId: string;
  readonly lookupKey: string;
  /**
   * Take {@link lookupKey} off whichever Price currently holds it, as part
   * of this create.
   *
   * REQUIRED whenever the key is already in use, which is every
   * `replace_price`: Stripe refuses `prices.create` with a `lookup_key`
   * another Price holds, and the refusal is not a warning — the create
   * simply fails. Verified against the live account on 2026-09-03, on the
   * first amount change this console ever attempted:
   * "A price (`price_1U94tmCyiazmanuP0CU2s7MA`) already uses that lookup
   * key."
   *
   * Left unset for a `create_price`, which mints a key nothing holds yet.
   * Asking to transfer a free key would work, but it would also silence the
   * one error that tells us a "new" price is not new — that a lookup key
   * believed unused is in fact live on some other Price is exactly the
   * surprise a bootstrap should stop on rather than absorb.
   */
  readonly transferLookupKey?: boolean;
  /** The Price's own (baseline) currency. MUST NOT appear as a key of
   *  `currencyOptions` — see `createPrice`. */
  readonly currency: string;
  readonly unitAmount: number;
  /**
   * `monthly` or `annual`, not `interval` — `createPrice` derives
   * `recurring.interval` from this via {@link expectedInterval}, the same
   * derivation `parity.ts` already uses to check a live Price's shape. Two
   * derivations of the same fact would be a second place for `annual` and
   * `year` to drift apart.
   */
  readonly period: "monthly" | "annual";
  readonly taxBehavior: TaxBehavior;
  /**
   * Every additional currency this Price should cover, keyed by ISO 4217,
   * carrying that currency's own amount AND its own tax behaviour. The
   * catalog holds `tax_behavior` per (lookup_key, currency) row, not per
   * Price — in mark8ly's catalog all six `aud` currency options are
   * `exclusive` while every other one of the 78 rows is `unspecified`, so a
   * Price-level `taxBehavior` alone cannot express this. Sent per entry on
   * create — see `createPrice` — because `../parity.ts`'s `coverageOf` reads
   * `currency_options[cur].tax_behavior` for exactly this comparison, and an
   * omitted value there reads as a `tax_behavior_mismatch` against those six
   * `aud` rows, forever.
   *
   * The BASELINE CURRENCY MUST NOT be a key here — Stripe rejects the create
   * call outright if it is, and that exact rejection once stuck a mark8ly
   * bootstrap run (mirrored in `createPrice`'s filter below, and the reason
   * mark8ly's own idempotency key reads `price:v3:`). `createPrice` filters
   * it out defensively regardless of what the caller passes.
   */
  readonly currencyOptions: Readonly<
    Record<string, { readonly unitAmount: number; readonly taxBehavior: TaxBehavior }>
  >;
  readonly idempotencyKey: string;
}

/**
 * The entire Stripe WRITE surface this estate has. Six methods: the three
 * matching mark8ly's own Go bootstrap (`billing/stripe/product.go`,
 * `billing/stripe/price.go`) one-for-one — `findProductByPlan`,
 * `createProduct`, `createPrice` — plus `addCurrencyOption`,
 * `updatePriceTaxBehavior`, and `archivePrice` — the three in-place and
 * archive operations the publish plan (design spec §4) needs. See the
 * module header before adding a seventh.
 */
export interface StripeCatalogWriter {
  /**
   * Looks up an existing Product by `metadata.plan`, mirroring mark8ly's
   * `FindProductByMetadata`. Lists ACTIVE products, first page only
   * (limit=100) — the same bound mark8ly's bootstrap accepted, because the
   * account will never hold more than a handful of plan Products.
   *
   * Returns `null`, not a thrown error, when nothing matches: the console
   * has no `ErrNotFound` idiom, and `createProduct`'s whole reason to exist
   * is the case where this returns `null`.
   */
  findProductByPlan(mode: StripeMode, plan: string): Promise<StripeProductRef | null>;

  /**
   * Creates a Product named `"Mark8ly " + plan`, tagged `metadata.plan` so a
   * later `findProductByPlan` call succeeds without the caller storing the
   * Stripe id anywhere — mirrors mark8ly's `CreateProduct` exactly.
   *
   * `idempotencyKey` is a required parameter, not minted here — see the
   * module header.
   */
  createProduct(mode: StripeMode, plan: string, idempotencyKey: string): Promise<StripeProductRef>;

  /** Creates one Price from {@link CreatePriceSpec}. */
  createPrice(mode: StripeMode, spec: CreatePriceSpec): Promise<StripePriceRef>;

  /**
   * Adds (or overwrites) `currency_options[currency].unit_amount` on an
   * EXISTING Price.
   *
   * This exists because spec §1.6a proved an existing currency's amount is
   * IMMUTABLE while ADDING a new currency succeeds — Stripe rejects an
   * update that changes an amount already present, but accepts one that adds
   * a currency the Price did not cover before. Plan 2's draft named this
   * `updatePriceCurrencyOptions`; that method cannot exist because "update an
   * existing amount" is not an operation Stripe permits. This is the only
   * in-place amount write Stripe allows, kept minimal on purpose: Task B
   * does not call it, and it is part of this surface only because the
   * six-method shape is what Plan 2 inherits.
   *
   * NO `taxBehavior` PARAMETER — unlike `CreatePriceSpec.currencyOptions`,
   * which spec §1.6a requires alongside every entry's `unitAmount`. Any
   * currency added through THIS method therefore lands with Stripe's own
   * default, `unspecified`, and stays that way: there is no follow-up call
   * this surface offers to set it afterward. If the catalog ever records a
   * non-`unspecified` `tax_behavior` for a currency added this way, `../parity.ts`'s
   * `coverageOf` reads `currency_options[cur].tax_behavior` and reports a
   * PERMANENT `tax_behavior_mismatch` for it — not a transient one that a
   * later sync clears, because nothing here ever writes that field.
   */
  addCurrencyOption(
    mode: StripeMode,
    priceId: string,
    currency: string,
    unitAmount: number,
    idempotencyKey: string,
  ): Promise<StripePriceRef>;

  /**
   * Moves an EXISTING Price's `tax_behavior` from `unspecified` to a value.
   *
   * This is a ONE-WAY DOOR — spec §1.4, verified by experiment on
   * 2026-08-27: `unspecified -> exclusive` was accepted, and the following
   * `exclusive -> inclusive` on the SAME price was refused outright with
   * *"You cannot update `tax_behavior` field once it has been specified."*
   * There is no third call that undoes the second. A caller that needs a
   * different `tax_behavior` on a Price that already has one set must go
   * through `replace_price` (create + `addCurrencyOption`/`archivePrice`),
   * not this method a second time.
   *
   * `null` (never set) and the STRING `'unspecified'` are distinct states in
   * Stripe's own model — see spec §1.4's closing note — so a caller checking
   * "has this already moved" must not treat an absent value and an explicit
   * `unspecified` as the same thing.
   *
   * This method does not itself enforce the one-way rule; Stripe does, by
   * rejecting the second call. It exists so that enforcement happens against
   * the live API, not against a local copy of the state machine that could
   * drift from what Stripe actually allows.
   */
  updatePriceTaxBehavior(
    mode: StripeMode,
    priceId: string,
    behavior: TaxBehavior,
    idempotencyKey: string,
  ): Promise<StripePriceRef>;

  /**
   * Sets `active: false` on the Price at `priceId`.
   *
   * `priceId` MUST be captured by the caller BEFORE it creates that price's
   * replacement — spec §1.3, verified by experiment on 2026-08-27: an
   * archived Price keeps `active: true` semantics for LOOKUP purposes only
   * until it is actually archived here, and loses its `lookup_key` the
   * moment it is. A caller that instead resolves "the price to archive" by
   * looking up the plan's lookup key AT archive time — after the replacement
   * has already been created and has claimed that lookup key via
   * `transfer_lookup_key` — resolves to the NEW price and archives it
   * instead, leaving the old one active and orphaned. This method trusts the
   * id it is given and performs no lookup of its own; it cannot protect a
   * caller that gets the ordering wrong.
   */
  archivePrice(mode: StripeMode, priceId: string, idempotencyKey: string): Promise<StripePriceRef>;
}

/**
 * `annual` -> `year`, `monthly` -> `month`, via `../parity.ts`'s
 * `expectedInterval` rather than a second copy of the same `annual -> year`
 * rule — see `CreatePriceSpec.period`'s comment.
 *
 * `expectedInterval` is written against a `lookup_key` (it looks for the
 * substring `_annual_`), not a `period`. Rather than copying its body to
 * operate on `period` directly, this wraps `period` in the shape
 * `expectedInterval` already recognises. `_${period}_` reproduces the
 * substring test exactly: `_annual_` contains `_annual_`; `_monthly_` does
 * not.
 */
function intervalOf(period: CreatePriceSpec["period"]): "year" | "month" {
  return expectedInterval(`_${period}_`);
}

export const stripeCatalogWriter: StripeCatalogWriter = {
  async findProductByPlan(mode, plan) {
    const products = await client(mode)
      .products.list({ active: true, limit: 100 })
      .autoPagingToArray({ limit: 100 });
    const match = products.find((p) => p.metadata?.plan === plan);
    return match ? { id: match.id } : null;
  },

  async createProduct(mode, plan, idempotencyKey) {
    const created = await client(mode).products.create(
      { name: `Mark8ly ${plan}`, metadata: { plan } },
      { idempotencyKey },
    );
    return { id: created.id };
  },

  async createPrice(mode, spec) {
    // The baseline currency MUST NOT appear inside `currency_options` —
    // Stripe rejects the create outright. Filtered here regardless of what
    // the caller passes, because the rejection this guards against once
    // stuck a live mark8ly bootstrap run.
    const currencyOptions: Record<string, { unit_amount: number; tax_behavior: TaxBehavior }> = {};
    for (const [currency, option] of Object.entries(spec.currencyOptions)) {
      if (currency === spec.currency) continue;
      currencyOptions[currency] = {
        unit_amount: option.unitAmount,
        tax_behavior: option.taxBehavior,
      };
    }

    const created = await client(mode).prices.create(
      {
        product: spec.productId,
        currency: spec.currency,
        unit_amount: spec.unitAmount,
        lookup_key: spec.lookupKey,
        // Only sent when asked for. `transfer_lookup_key: false` is Stripe's
        // default, so omitting it and sending it false are the same request
        // -- but omitting keeps the field out of the create for the path
        // that must never transfer, where its presence would invite someone
        // to flip it.
        ...(spec.transferLookupKey ? { transfer_lookup_key: true } : {}),
        tax_behavior: spec.taxBehavior,
        recurring: { interval: intervalOf(spec.period) },
        currency_options: currencyOptions,
      },
      { idempotencyKey: spec.idempotencyKey },
    );
    return { id: created.id };
  },

  async addCurrencyOption(mode, priceId, currency, unitAmount, idempotencyKey) {
    const updated = await client(mode).prices.update(
      priceId,
      { currency_options: { [currency]: { unit_amount: unitAmount } } },
      { idempotencyKey },
    );
    return { id: updated.id };
  },

  async updatePriceTaxBehavior(mode, priceId, behavior, idempotencyKey) {
    // Sends ONLY `tax_behavior` — no amount, no currency_options. See the
    // interface doc: mixing an amount into this call would smuggle in the
    // replace-price operation under a one-way-door call, and this method
    // must stay distinguishable from `replace_price` in what it sends.
    const updated = await client(mode).prices.update(
      priceId,
      { tax_behavior: behavior },
      { idempotencyKey },
    );
    return { id: updated.id };
  },

  async archivePrice(mode, priceId, idempotencyKey) {
    // `priceId` is used exactly as given — no lookup, no re-resolution. See
    // the interface doc: resolving by lookup key here (instead of trusting
    // the caller's captured id) would archive whatever price currently holds
    // that key, which after a replacement is the NEW price, not the old one.
    const updated = await client(mode).prices.update(
      priceId,
      { active: false },
      { idempotencyKey },
    );
    return { id: updated.id };
  },
};
