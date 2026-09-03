// `server-only` for the same reason `plan-catalog-repo.ts` carries it: this
// module reaches `pg` through `./tesserix`, and a client component that
// reaches it must fail the build with the import chain named rather than
// `Can't resolve 'net'` from somewhere inside the driver.
import "server-only";

// A VALUE import, not type-only: `CATALOG_SOURCES` is the closed list the
// migration's `promo_codes_source_is_a_known_source` admits, and reusing it
// here rather than spelling a second one is the same drift argument
// `source-policy.ts` makes for `CatalogSource` itself. `source-policy.ts` is a
// plain constants module with no `server-only` and no `pg` ancestry, so
// importing it as a value costs this module nothing.
import { CATALOG_SOURCES, type CatalogSource } from "@/lib/billing/source-policy";
import { STRIPE_MODES, type StripeMode } from "@/lib/billing/stripe-read";
import { tesserixQuery } from "./tesserix";

/**
 * Reads and writes for `promo_codes` and `promo_code_stripe_coupons` (0046) —
 * the DEFINITION side of tesserix-home#521.
 *
 * ITS OWN FILE, NOT `plan-catalog-repo.ts`. That module is the read side of a
 * mirrored, published, per-mode catalog with a parity check hanging off it;
 * this is a small CRUD over two tables nothing else joins. They share a
 * `source` and a `mode` vocabulary and nothing else, and the precedent for
 * "this is neither of the existing paths" is `crm-templates.ts` splitting out
 * of `crm-repo.ts` for the same reason.
 *
 * ══ TERMS ARE MODE-INDEPENDENT; THE MINTED COUPON IS NOT ══
 *
 * A definition carries the discount TERMS an operator authored — percent-off
 * or amount-off, duration, months, currency. It does NOT carry a
 * `stripe_coupon_id`, and #521's body asking for one is wrong: a `co_...` is
 * account-scoped exactly as a `price_...` is, and 0032 already settled that a
 * per-mode Stripe id must not sit on a mode-independent row. What was actually
 * minted lives in `promo_code_stripe_coupons`, keyed `(promo_code_id, mode)`
 * — the shape `plan_catalog_publications` uses for the same reason.
 *
 * A definition with terms and no coupon in any mode is NORMAL, not incomplete.
 * See {@link recordStripeCoupon} and {@link readStripeCoupons}.
 *
 * ══ MARK8LY IS THE ONLY REDEEMER ══
 *
 * `maxRedemptions` is an EXACT cap, and it is exact only because mark8ly is
 * declared the sole consumer: it counts its own redemptions transactionally,
 * inside the transaction that creates the tenant, which it can do precisely
 * because nothing else redeems. A SECOND CONSUMER MAKES THE CAP DISTRIBUTED
 * AND THIS DESIGN STOPS BEING CORRECT — it would keep presenting as a hard
 * limit while over-issuing under concurrency, and nothing here would say so.
 * Repeated from 0046's header rather than cross-referenced, because the person
 * who adds the second consumer will be reading one of the two and we do not
 * get to choose which.
 *
 * Nothing in this module counts redemptions or stores a count. The ledger is
 * transactional and tenant-scoped and lives where redemptions happen.
 *
 * ══ THE CANONICAL FORM IS THE DATABASE'S RULE, NOT THIS MODULE'S ══
 *
 * Every code stored is upper-case with no whitespace in it, and 0046's
 * `promo_codes_code_is_upper_case` and `promo_codes_code_has_no_whitespace`
 * REFUSE anything else. {@link normalisePromoCode} is what every boundary
 * applies so a caller never meets the first of those refusals; it is
 * convenience, not enforcement. Redemption is then case-insensitive by
 * construction, with no `lower()` on the read path — see
 * {@link readPromoCodeByCode}.
 *
 * The SECOND refusal is one a caller can still meet, deliberately: a code with
 * a space inside it is not something normalisation should silently repair,
 * because the repair would change what the operator authored into a different
 * string than the one they are about to print on a sticker.
 */

/**
 * Which product's onboarding a code is for.
 *
 * Reused from `source-policy.ts` rather than re-declared: the values are the
 * same literals, the migration's CHECK admits the same list, and two
 * independent spellings of one closed set is the drift that module already
 * argued against. If promo codes ever need a source the plan catalog does not
 * have, that is the moment to split the type — not now, on the guess that they
 * might.
 */
export type PromoCodeSource = CatalogSource;

/** The default, and today the only, source. Spelled via the array so adding a
 *  second source makes this line a compile error to revisit rather than a
 *  silently wrong default. */
export const DEFAULT_PROMO_CODE_SOURCE: PromoCodeSource = CATALOG_SOURCES[0];

/**
 * The one normalisation, applied at every boundary that handles a typed code.
 *
 * `toUpperCase()` and not `toLocaleUpperCase()`: the latter is locale-sensitive
 * and maps Turkish dotless `ı` to `I` differently, so the same string would
 * canonicalise differently depending on where the process runs — a code that
 * works in one region and not another, for a reason no log would show.
 * `toUpperCase()` is locale-independent, and over the ASCII these codes are
 * written in it agrees exactly with Postgres `upper()`, which is what
 * `promo_codes_code_is_upper_case` evaluates.
 *
 * IT TRIMS ONLY THE ENDS, and does not strip interior whitespace, so
 * `"LAUNCH 50"` comes back unchanged and is then REFUSED by
 * `promo_codes_code_has_no_whitespace`. That is the intended split: padding is
 * an artefact of copy-paste and safe to discard silently, while a space in the
 * middle is part of what the operator typed and must not be rewritten under
 * them. 0046's header records why the database refuses whitespace outright
 * rather than trying to mirror this function's trim.
 */
export function normalisePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Stripe's three coupon durations, passed through rather than reinterpreted.
 *
 * Spelled here as well as in 0046's
 * `promo_codes_discount_duration_is_a_stripe_duration` for the reason
 * `TemplateChannel` is: a caller passing `"monthly"` should be a TypeScript
 * error at the call site, not a CHECK violation from Postgres at runtime.
 */
export type DiscountDuration = "once" | "repeating" | "forever";

/**
 * The discount TERMS an operator authored — `createCoupon`'s input, not its
 * output, and true regardless of which Stripe account they are later minted
 * into.
 *
 * A DISCRIMINATED UNION on `kind`, which is the type-level form of 0046's
 * `promo_codes_discount_is_percent_off_xor_amount_off`. The alternative — one
 * shape with both fields optional — would make "both set" and "neither set"
 * expressible in TypeScript and rejected only by the database, which is the
 * long way round to the same error.
 *
 * `currency` sits on the amount-off arm ONLY, so the biconditional
 * `promo_codes_discount_currency_accompanies_amount_off` enforces is a thing
 * the type system will not let a caller violate either.
 *
 * `durationInMonths` stays optional on both arms rather than being lifted onto
 * a `repeating` variant: the iff is a fact about `duration`, not about the
 * discount shape, and modelling it here would multiply the union by three for
 * one rule the database already states.
 */
export type PromoCodeDiscount = {
  duration: DiscountDuration;
  /** Required iff `duration` is `"repeating"` —
   *  `promo_codes_discount_months_iff_repeating`. */
  durationInMonths: number | null;
} & (
  | { kind: "percent_off"; percentOff: number }
  | { kind: "amount_off"; amountOffMinor: number; currency: string }
);

/** A promo code definition, as the console and the served contract see it. */
export interface PromoCodeRow {
  id: string;
  source: PromoCodeSource;
  /** Always the canonical form: upper-case, no whitespace. */
  code: string;
  /** Null means this code does not extend the trial — never 0, which 0046
   *  refuses. */
  trialExtensionDays: number | null;
  /**
   * The authored terms, or null for a trial-extension-only code.
   *
   * NOT a Stripe coupon id. Terms present with no coupon minted anywhere is the
   * normal state between authoring and first publish — read what was minted
   * with {@link readStripeCoupons}.
   */
  discount: PromoCodeDiscount | null;
  validFrom: string;
  /** Null means no expiry, not unknown. */
  validUntil: string | null;
  /** Null means uncapped. EXACT only while mark8ly is the sole redeemer. */
  maxRedemptions: number | null;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface PromoCodeDbRow {
  id: string;
  source: PromoCodeSource;
  code: string;
  trial_extension_days: number | null;
  /** `numeric` arrives from `pg` as a STRING — it does not fit a JS number in
   *  general. Narrowed by {@link toNumericOrNull}. */
  discount_percent_off: string | number | null;
  /** `bigint`, likewise a string. See `plan-catalog-repo.ts`'s `toMinorUnits`
   *  for the identical narrowing on the identical Stripe concept. */
  discount_amount_off: string | number | null;
  discount_currency: string | null;
  discount_duration: DiscountDuration | null;
  discount_duration_in_months: number | null;
  valid_from: unknown;
  valid_until: unknown;
  max_redemptions: number | null;
  is_active: boolean;
  created_by: string;
  created_at: unknown;
  updated_at: unknown;
}

/** Local rather than shared, per `crm-templates.ts`'s `toIsoRequired`: every
 *  NOT NULL timestamp on this table is genuinely NOT NULL, so a null here means
 *  the query stopped selecting the column, which should be loud rather than
 *  silently rendered as an empty date. */
function toIsoRequired(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("promo-codes-repo: expected a NOT NULL timestamp");
}

function toIsoNullable(value: unknown): string | null {
  return value === null || value === undefined ? null : toIsoRequired(value);
}

/**
 * `integer` columns arrive from `pg` as numbers, but a driver that hands back a
 * string (or a `bigint` after a future widening) must not silently become
 * `NaN` on the far side of a subtraction. Narrowed here, once.
 */
function toIntOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`promo-codes-repo: expected an integer, got ${String(value)}`);
  }
  return n;
}

/**
 * `numeric` arrives from `pg` as a string, deliberately — it is arbitrary
 * precision and does not fit a JS number in general. `percent_off` does fit:
 * 0046 declares it `numeric(5,2)`, so every storable value is at most 100.00
 * and exactly representable. Narrowed here rather than at each call site so
 * that reasoning is written down once.
 */
function toNumericOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`promo-codes-repo: expected a numeric, got ${String(value)}`);
  }
  return n;
}

/**
 * Reassemble the discount terms from six flat columns into the discriminated
 * union.
 *
 * `discount_duration` is the presence marker, matching
 * `promo_codes_discount_terms_are_all_or_nothing` — the same column the
 * database anchors the group on, so the two cannot disagree about whether a row
 * has terms.
 *
 * THROWS rather than returning null on a row that has a duration and neither
 * amount: that shape is refused by
 * `promo_codes_discount_is_percent_off_xor_amount_off`, so meeting it means the
 * constraint is gone or the SELECT stopped fetching a column. Silently
 * returning null there would render a discount code as trial-only, which is a
 * wrong answer presented as a normal one.
 */
function toDiscount(row: PromoCodeDbRow): PromoCodeDiscount | null {
  if (row.discount_duration === null) return null;

  const shared = {
    duration: row.discount_duration,
    durationInMonths: toIntOrNull(row.discount_duration_in_months),
  };

  const percentOff = toNumericOrNull(row.discount_percent_off);
  if (percentOff !== null) return { ...shared, kind: "percent_off", percentOff };

  const amountOffMinor = toIntOrNull(row.discount_amount_off);
  if (amountOffMinor !== null && row.discount_currency !== null) {
    return { ...shared, kind: "amount_off", amountOffMinor, currency: row.discount_currency };
  }

  throw new Error(
    `promo-codes-repo: promo code ${row.id} has discount terms with neither a percent-off nor an amount-off and currency`,
  );
}

function toPromoCodeRow(row: PromoCodeDbRow): PromoCodeRow {
  return {
    id: row.id,
    source: row.source,
    code: row.code,
    trialExtensionDays: toIntOrNull(row.trial_extension_days),
    discount: toDiscount(row),
    validFrom: toIsoRequired(row.valid_from),
    validUntil: toIsoNullable(row.valid_until),
    maxRedemptions: toIntOrNull(row.max_redemptions),
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
  };
}

/** Every column, in one place, so the statements below cannot drift into
 *  returning different shapes for the same type — `crm-templates.ts`'s
 *  `TEMPLATE_COLUMNS` rule. */
const PROMO_CODE_COLUMNS = `id, source, code, trial_extension_days,
                            discount_percent_off, discount_amount_off, discount_currency,
                            discount_duration, discount_duration_in_months,
                            valid_from, valid_until, max_redemptions, is_active,
                            created_by, created_at, updated_at`;

export interface CreatePromoCodeInput {
  /** Normalised on the way in — a caller may pass what the operator typed. */
  code: string;
  source?: PromoCodeSource;
  trialExtensionDays?: number | null;
  /** The authored terms. Omit for a trial-extension-only code. */
  discount?: PromoCodeDiscount | null;
  /** Defaults to `now()` in the database when omitted. */
  validFrom?: Date | string | null;
  validUntil?: Date | string | null;
  maxRedemptions?: number | null;
  isActive?: boolean;
  createdBy: string;
}

/** Flatten the union back into the six columns. The inverse of
 *  {@link toDiscount}, and the only place that mapping is written in this
 *  direction. */
function discountColumns(discount: PromoCodeDiscount | null | undefined): {
  percentOff: number | null;
  amountOffMinor: number | null;
  currency: string | null;
  duration: DiscountDuration | null;
  durationInMonths: number | null;
} {
  if (!discount) {
    return {
      percentOff: null,
      amountOffMinor: null,
      currency: null,
      duration: null,
      durationInMonths: null,
    };
  }
  return {
    percentOff: discount.kind === "percent_off" ? discount.percentOff : null,
    amountOffMinor: discount.kind === "amount_off" ? discount.amountOffMinor : null,
    currency: discount.kind === "amount_off" ? discount.currency : null,
    duration: discount.duration,
    durationInMonths: discount.durationInMonths,
  };
}

/**
 * Author a definition.
 *
 * NORMALISES THE CODE AND THEN LETS THE DATABASE JUDGE EVERYTHING ELSE. The
 * "at least one effect", positivity, window-ordering and uniqueness rules are
 * NOT re-implemented here as early returns, and that is deliberate: a
 * TypeScript pre-check is one a script, a second surface or a future caller
 * routes around, and duplicating a rule gives it two places to disagree with
 * itself. 0046 holds each rule as a NAMED constraint, so a violation arrives as
 * an error naming which rule was broken — which is the message the authoring
 * surface wants anyway.
 *
 * Emptiness, trimming beyond the canonical form, and operator-facing wording
 * are the ACTION's job, per the same rule `createTemplate` follows: this layer
 * stays plain data access.
 */
export async function createPromoCode(input: CreatePromoCodeInput): Promise<PromoCodeRow> {
  const discount = discountColumns(input.discount);
  const rows = await tesserixQuery<PromoCodeDbRow>(
    `INSERT INTO promo_codes
       (source, code, trial_extension_days,
        discount_percent_off, discount_amount_off, discount_currency,
        discount_duration, discount_duration_in_months,
        valid_from, valid_until, max_redemptions, is_active, created_by)
     VALUES ($1, $2, $3,
             $4::numeric, $5::bigint, $6, $7, $8,
             COALESCE($9::timestamptz, now()), $10::timestamptz,
             $11, COALESCE($12::boolean, true), $13)
     RETURNING ${PROMO_CODE_COLUMNS}`,
    [
      input.source ?? DEFAULT_PROMO_CODE_SOURCE,
      normalisePromoCode(input.code),
      input.trialExtensionDays ?? null,
      discount.percentOff,
      discount.amountOffMinor,
      discount.currency,
      discount.duration,
      discount.durationInMonths,
      input.validFrom ?? null,
      input.validUntil ?? null,
      input.maxRedemptions ?? null,
      input.isActive ?? null,
      input.createdBy,
    ],
  );
  return toPromoCodeRow(rows[0]);
}

/**
 * The redemption lookup: one code, or null.
 *
 * NO `lower()`, `upper()` OR `ILIKE` ON THE COLUMN — the whole point of the
 * canonical stored form. The comparison is a plain equality against
 * `promo_codes_code_unique`, so it is one index probe, and case-insensitivity
 * comes from normalising the INPUT rather than from transforming every stored
 * row on every read.
 *
 * Returns the definition whatever its state — inactive, expired, not yet
 * valid. Deciding redeemability is the caller's, because the caller is the only
 * one that knows the clock it is deciding against and what to tell the person
 * who typed it. A read that returned null for an expired code would make
 * "expired" and "never existed" the same answer, and those want different
 * copy.
 */
export async function readPromoCodeByCode(code: string): Promise<PromoCodeRow | null> {
  const rows = await tesserixQuery<PromoCodeDbRow>(
    `SELECT ${PROMO_CODE_COLUMNS}
       FROM promo_codes
      WHERE code = $1`,
    [normalisePromoCode(code)],
  );
  return rows[0] ? toPromoCodeRow(rows[0]) : null;
}

export interface ListPromoCodesOptions {
  source?: PromoCodeSource;
  /** Inactive definitions are excluded by default. */
  includeInactive?: boolean;
}

/**
 * Definitions, newest first.
 *
 * INACTIVE ARE EXCLUDED BY DEFAULT, mirroring `listTemplates`: every surface
 * that renders a picker or serves a redeemer wants live rows, and exactly one
 * (the authoring table's "show inactive" toggle) wants the rest. A default that
 * showed everything would put a retired code back in front of an operator about
 * to hand it to a merchant.
 *
 * `id` in the ORDER BY is load-bearing, for the same reason it is in
 * `listTemplates`: `created_at` is not unique, so without a total order two
 * definitions written in the same statement swap places between renders.
 */
export async function listPromoCodes(
  options: ListPromoCodesOptions = {},
): Promise<PromoCodeRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!options.includeInactive) conditions.push("is_active");
  if (options.source !== undefined) {
    params.push(options.source);
    conditions.push(`source = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await tesserixQuery<PromoCodeDbRow>(
    `SELECT ${PROMO_CODE_COLUMNS}
       FROM promo_codes
       ${where}
      ORDER BY created_at DESC, id DESC`,
    params,
  );
  return rows.map(toPromoCodeRow);
}

/**
 * The fields an update may change.
 *
 * `undefined` means "leave alone" and `null` means "clear it" — two distinct
 * intentions that a single optional-with-null shape would collapse. Collapsing
 * them is how a partial update from a form silently wipes the redemption cap of
 * every code it touches.
 *
 * `code`, `source` and `createdBy` are ABSENT ON PURPOSE. Re-coding a
 * definition after it has been handed out is not an edit, it is a different
 * code: mark8ly's ledger references what was redeemed, and rewriting the
 * string under it makes every existing redemption describe a code that no
 * longer exists. Author a new definition and deactivate the old one.
 *
 * THE DISCOUNT TERMS ARE ABSENT TOO, and for a Stripe reason rather than a
 * ledger one. A Stripe Coupon's `percent_off`, `amount_off`, `currency` and
 * `duration` are IMMUTABLE after creation — the API will not change them. So
 * once a definition has been minted into any mode, editing its terms here
 * would leave the row describing a discount different from the one Stripe will
 * actually apply, with nothing to reconcile them and no error anywhere. That
 * divergence is invisible: both sides keep working, and the merchant simply
 * gets a discount other than the one the console displays.
 *
 * A definition NOT yet minted anywhere could safely be re-termed, but making
 * that legal would put the safety of an edit behind a state check in another
 * table that every future caller has to remember to make. Authoring a
 * replacement and deactivating the old one is correct in both states and
 * requires no such check.
 */
export interface UpdatePromoCodeInput {
  trialExtensionDays?: number | null;
  validFrom?: Date | string;
  validUntil?: Date | string | null;
  maxRedemptions?: number | null;
  isActive?: boolean;
}

/** Column per updatable field, so the dynamic SET below builds from a closed
 *  map rather than from caller-supplied keys — there is no path here by which a
 *  key from a request body becomes SQL. */
const UPDATABLE_COLUMNS = {
  trialExtensionDays: "trial_extension_days",
  validFrom: "valid_from",
  validUntil: "valid_until",
  maxRedemptions: "max_redemptions",
  isActive: "is_active",
} as const satisfies Record<keyof UpdatePromoCodeInput, string>;

/**
 * Amend a definition.
 *
 * Returns null for "no such id" AND for an empty change set, and those are
 * distinguished by nothing here on purpose: a caller with nothing to change
 * should not be issuing an UPDATE, and an `UPDATE ... SET updated_at = now()`
 * with no other change would record an amendment that did not happen. The
 * empty case is answered before touching the database.
 *
 * `updated_at` is set in this statement rather than by a trigger, per 0043 and
 * 0046: there are no triggers on these tables and every writer maintains the
 * column itself.
 */
export async function updatePromoCode(
  id: string,
  changes: UpdatePromoCodeInput,
): Promise<PromoCodeRow | null> {
  const assignments: string[] = [];
  const params: unknown[] = [];

  for (const [field, column] of Object.entries(UPDATABLE_COLUMNS) as [
    keyof UpdatePromoCodeInput,
    string,
  ][]) {
    const value = changes[field];
    if (value === undefined) continue;
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  }

  if (assignments.length === 0) return null;

  params.push(id);
  const rows = await tesserixQuery<PromoCodeDbRow>(
    `UPDATE promo_codes
        SET ${assignments.join(", ")}, updated_at = now()
      WHERE id = $${params.length}
      RETURNING ${PROMO_CODE_COLUMNS}`,
    params,
  );
  return rows[0] ? toPromoCodeRow(rows[0]) : null;
}

/**
 * Retire a definition.
 *
 * DEACTIVATE, NEVER DELETE — 0046's reasoning, and `archiveTemplate`'s before
 * it: mark8ly's redemption ledger references the code that was redeemed, and a
 * deleted definition turns every one of those rows into a dangling reference
 * nobody can resolve. The ledger would still say a trial was extended and would
 * no longer be able to say by which code.
 *
 * Returns THE ROWS THE UPDATE ACTUALLY REPORTED, not a boolean and not an
 * assumed 1. `WHERE id = $1 AND is_active` matches nothing on a second
 * deactivation or an unknown id, so the caller's audit row says
 * `{ deactivated: 0 }` rather than recording a retirement that did not happen.
 * An audit trail that overstates what occurred is worse than one that omits it.
 */
export async function deactivatePromoCode(id: string): Promise<PromoCodeRow[]> {
  const rows = await tesserixQuery<PromoCodeDbRow>(
    `UPDATE promo_codes
        SET is_active = false, updated_at = now()
      WHERE id = $1 AND is_active
      RETURNING ${PROMO_CODE_COLUMNS}`,
    [id],
  );
  return rows.map(toPromoCodeRow);
}

// ════════════════════════════════════════════════════════════════════════════
// `promo_code_stripe_coupons` — what was actually minted, in which account.
//
// The per-mode half of 0046's split. Two functions, deliberately: #521's T2
// (the Stripe writer) records, and T3/T4 read. Nothing here creates a coupon —
// that is the writer's job, and this module knows nothing about Stripe beyond
// the shape of an id.
// ════════════════════════════════════════════════════════════════════════════

export interface PromoCodeStripeCoupon {
  promoCodeId: string;
  mode: StripeMode;
  stripeCouponId: string;
  createdBy: string;
  createdAt: string;
}

interface PromoCodeStripeCouponDbRow {
  promo_code_id: string;
  mode: StripeMode;
  stripe_coupon_id: string;
  created_by: string;
  created_at: unknown;
}

const COUPON_COLUMNS = `promo_code_id, mode, stripe_coupon_id, created_by, created_at`;

function toStripeCoupon(row: PromoCodeStripeCouponDbRow): PromoCodeStripeCoupon {
  return {
    promoCodeId: row.promo_code_id,
    mode: row.mode,
    stripeCouponId: row.stripe_coupon_id,
    createdBy: row.created_by,
    createdAt: toIsoRequired(row.created_at),
  };
}

export interface RecordStripeCouponInput {
  promoCodeId: string;
  mode: StripeMode;
  /** A Stripe Coupon id (`co_...`), as returned by the create call. */
  stripeCouponId: string;
  createdBy: string;
}

/**
 * Record that a coupon now exists in one Stripe account for one definition.
 *
 * A PLAIN INSERT, WITH NO `ON CONFLICT`. A second coupon for the same
 * (definition, mode) is refused by the primary key, loudly, and that is the
 * intended behaviour rather than an unhandled case: the first coupon is a real
 * object in a real Stripe account, and quietly overwriting the id that points
 * at it ORPHANS it — still live, still redeemable by anyone holding it, and no
 * longer named by anything in this database. Minting a replacement is a
 * deliberate act that has to archive the first, so it must not be reachable by
 * calling this function twice.
 *
 * WHAT THIS FUNCTION CANNOT CHECK, per 0046's closing paragraph: it does not
 * refuse a coupon against a definition carrying no discount terms. Postgres
 * cannot express that cross-table CHECK and neither can one INSERT; the rule
 * belongs to the writer that decided to mint. Said out loud so nobody reads the
 * FK as more of a guarantee than it is.
 */
export async function recordStripeCoupon(
  input: RecordStripeCouponInput,
): Promise<PromoCodeStripeCoupon> {
  const rows = await tesserixQuery<PromoCodeStripeCouponDbRow>(
    `INSERT INTO promo_code_stripe_coupons
       (promo_code_id, mode, stripe_coupon_id, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COUPON_COLUMNS}`,
    [input.promoCodeId, input.mode, input.stripeCouponId, input.createdBy],
  );
  return toStripeCoupon(rows[0]);
}

/**
 * Every mode this definition has been minted into, in `STRIPE_MODES` order.
 *
 * RETURNS THE ROWS THAT EXIST, and does not pad the absent modes with nulls.
 * An absent mode is a real and expected state — nothing in this estate has ever
 * bootstrapped live — and a `{ test: "co_…", live: null }` shape would invite a
 * caller to render "live: none" as a defect rather than as the norm. A caller
 * that wants a per-mode map can build one over `STRIPE_MODES`, which is
 * exported for exactly that.
 *
 * Ordered by `STRIPE_MODES` rather than alphabetically so a surface listing
 * modes lists them the same way every other per-mode surface in the console
 * does. `array_position` rather than an ORDER BY CASE, so the order is defined
 * by the same array TypeScript iterates and cannot drift from it.
 */
export async function readStripeCoupons(
  promoCodeId: string,
): Promise<PromoCodeStripeCoupon[]> {
  const rows = await tesserixQuery<PromoCodeStripeCouponDbRow>(
    `SELECT ${COUPON_COLUMNS}
       FROM promo_code_stripe_coupons
      WHERE promo_code_id = $1
      ORDER BY array_position($2::text[], mode)`,
    [promoCodeId, [...STRIPE_MODES]],
  );
  return rows.map(toStripeCoupon);
}
