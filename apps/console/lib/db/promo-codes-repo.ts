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
import { tesserixQuery } from "./tesserix";

/**
 * Reads and writes for `promo_codes` (0046) — the DEFINITION side of
 * tesserix-home#521.
 *
 * ITS OWN FILE, NOT `plan-catalog-repo.ts`. That module is the read side of a
 * mirrored, published, per-mode catalog with a parity check hanging off it;
 * this is a small CRUD over a table nothing joins. They share a `source` and
 * nothing else, and the precedent for "this is neither of the existing paths"
 * is `crm-templates.ts` splitting out of `crm-repo.ts` for the same reason.
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

/** A promo code definition, as the console and the served contract see it. */
export interface PromoCodeRow {
  id: string;
  source: PromoCodeSource;
  /** Always the canonical form: upper-case, trimmed. */
  code: string;
  /** Null means this code does not extend the trial — never 0, which 0046
   *  refuses. */
  trialExtensionDays: number | null;
  /** A Stripe Coupon id (`co_...`), or null for a code with no discount.
   *  Carries no mode; see 0046's header for why that is an open question. */
  stripeCouponId: string | null;
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
  stripe_coupon_id: string | null;
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

function toPromoCodeRow(row: PromoCodeDbRow): PromoCodeRow {
  return {
    id: row.id,
    source: row.source,
    code: row.code,
    trialExtensionDays: toIntOrNull(row.trial_extension_days),
    stripeCouponId: row.stripe_coupon_id,
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
const PROMO_CODE_COLUMNS = `id, source, code, trial_extension_days, stripe_coupon_id,
                            valid_from, valid_until, max_redemptions, is_active,
                            created_by, created_at, updated_at`;

export interface CreatePromoCodeInput {
  /** Normalised on the way in — a caller may pass what the operator typed. */
  code: string;
  source?: PromoCodeSource;
  trialExtensionDays?: number | null;
  stripeCouponId?: string | null;
  /** Defaults to `now()` in the database when omitted. */
  validFrom?: Date | string | null;
  validUntil?: Date | string | null;
  maxRedemptions?: number | null;
  isActive?: boolean;
  createdBy: string;
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
  const rows = await tesserixQuery<PromoCodeDbRow>(
    `INSERT INTO promo_codes
       (source, code, trial_extension_days, stripe_coupon_id,
        valid_from, valid_until, max_redemptions, is_active, created_by)
     VALUES ($1, $2, $3, $4,
             COALESCE($5::timestamptz, now()), $6::timestamptz,
             $7, COALESCE($8::boolean, true), $9)
     RETURNING ${PROMO_CODE_COLUMNS}`,
    [
      input.source ?? DEFAULT_PROMO_CODE_SOURCE,
      normalisePromoCode(input.code),
      input.trialExtensionDays ?? null,
      input.stripeCouponId ?? null,
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
 * them is how a partial update from a form silently wipes the coupon id of
 * every code it touches.
 *
 * `code`, `source` and `createdBy` are ABSENT ON PURPOSE. Re-coding a
 * definition after it has been handed out is not an edit, it is a different
 * code: mark8ly's ledger references what was redeemed, and rewriting the
 * string under it makes every existing redemption describe a code that no
 * longer exists. Author a new definition and deactivate the old one.
 */
export interface UpdatePromoCodeInput {
  trialExtensionDays?: number | null;
  stripeCouponId?: string | null;
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
  stripeCouponId: "stripe_coupon_id",
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
