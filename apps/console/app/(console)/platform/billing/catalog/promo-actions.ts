"use server";

import { revalidatePath } from "next/cache";
import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import { auditedOperation, type AuditDescription } from "@/lib/db/audit-repo";
import {
  createPromoCode,
  deactivatePromoCode,
  normalisePromoCode,
  readPromoCodeByCode,
  readStripeCoupons,
  recordStripeCoupon,
  updatePromoCode,
  type PromoCodeDiscount,
  type PromoCodePlan,
} from "@/lib/db/promo-codes-repo";
import {
  StripeCouponTermsError,
  StripeWriteUnavailableError,
  WRITE_KEY_ENV,
  stripeCatalogWriter,
} from "@/lib/billing/mark8ly/stripe-write";
import type { StripeMode } from "@/lib/billing/stripe-read";

/**
 * The promo-code surface's write path (tesserix-home#521, T4).
 *
 * A SIBLING of `actions.ts`, not an addition to it — the same reasoning that
 * file's own header gives for being a sibling of `crm-write.ts` rather than a
 * caller of it. The two surfaces share a page and share nothing else: the
 * catalog's writes are draft revisions and Stripe Prices, these are promo
 * definitions and Stripe Coupons, and folding them into one 900-line module
 * would put a change to either in the other's blast radius.
 *
 * # The same two capabilities, checked the same way
 *
 * `billing` for anything that writes a DEFINITION — authoring, amending and
 * retiring a promo code touches nothing Stripe has ever seen, exactly as a
 * draft edit does. `publish-catalog` IN ADDITION for {@link mintCouponAction},
 * which creates a real, immediately-redeemable object in a real Stripe
 * account: that is the same class of act as publishing a price, and it is
 * gated by the same risk verb. Each check is independent and each runs INSIDE
 * `auditedOperation`, so a refusal is written as a `capability.refused` row
 * (#409) rather than never entering the audit path — see `withDraftWrite`'s
 * comment in `actions.ts` for the full argument.
 *
 * # The database judges a definition; this module only translates
 *
 * There is no second copy of 0046's rules here. `createPromoCode`'s own doc
 * comment settles it: every rule is a NAMED constraint, a TypeScript
 * pre-check is one a future caller routes around, and duplicating a rule
 * gives it two places to disagree with itself. What this module owns is the
 * WORDING — {@link PROMO_REFUSALS} maps each constraint name to a sentence
 * written for an operator, and anything unmatched degrades to the
 * conservative default so a transport error cannot leak by omission.
 */

export type PromoActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

const NO_PERMISSION_MESSAGE = "You don't have permission to edit promo codes.";

const NO_MINT_PERMISSION_MESSAGE =
  "You don't have permission to mint Stripe coupons.";

/** Internal error text — a driver message, a constraint body, a repo
 *  function's own wording — must never reach the operator verbatim. Same
 *  discipline `actions.ts`'s `NOT_SAVED_MESSAGE` applies. */
const NOT_SAVED_MESSAGE = "That change was not saved.";

/**
 * Minting is the one action here whose failure is genuinely ambiguous.
 *
 * `auditedOperation` raises `AuditUnavailableError` BEFORE the operation and
 * `AuditWriteError` after it, and a failure between `createCoupon` and
 * `recordStripeCoupon` leaves a live coupon in a Stripe account that this
 * database does not name. So this message never claims nothing happened — it
 * says where to look, the way `PUBLISH_INCOMPLETE_MESSAGE` does.
 */
/**
 * The message for a mint whose outcome we cannot describe.
 *
 * It names the MODE, because the previous wording — "check the Stripe
 * dashboard for this code" — does not, and Stripe's dashboard is per-mode. A
 * live mint failed on 2026-09-06 and the operator twice checked TEST, found
 * the coupon minted the day before, and reasonably concluded the mint had
 * half-succeeded. It had not: the live key was missing `coupon_write`.
 *
 * It also no longer asserts that a coupon may already exist. That was true of
 * the case this message was written for — a write that may have reached Stripe
 * before failing — but it is false for a permission or validation refusal,
 * which creates nothing. Saying "may exist" for every unrecognised cause sends
 * an operator looking for an orphan that is usually not there.
 *
 * So it states what is actually known: which mode, that we could not tell what
 * happened, and where the answer is. The cause is logged server-side
 * (tesserix-home#607), which is what makes "the logs will say" a real
 * instruction rather than a deflection.
 */
const mintIncompleteMessage = (mode: StripeMode): string =>
  `The coupon could not be minted in ${mode} mode, and the reason was not one this screen recognises. ` +
  `The failure is in the console logs. Check the ${mode} Stripe dashboard before retrying: most refusals ` +
  `(a key without Coupons Write, for instance) create nothing, but a write that failed part-way can leave a coupon there.`

/**
 * The message a second mint in the same mode produces, and the reason
 * `recordStripeCoupon` carries no `ON CONFLICT`.
 *
 * Used in TWO places on purpose: {@link mintCouponAction} refuses on a read
 * before it calls Stripe (so the second mint does not create a second real
 * coupon and then fail), and {@link PROMO_REFUSALS} answers the primary key
 * with the identical sentence for the race that read cannot close.
 */
const ALREADY_MINTED_MESSAGE =
  "This code already has a coupon in that mode. The existing coupon is live and still redeemable, so a second one is not minted — to change the discount, author a new code and deactivate this one.";

/**
 * Constraint name -> operator sentence.
 *
 * MATCHED ON THE CONSTRAINT, not on English: `pg` puts the violated
 * constraint's name on the error as `constraint`, and 0046 names every rule
 * deliberately so this mapping is possible. A rule that is not in this list
 * degrades to {@link NOT_SAVED_MESSAGE} rather than showing an operator a
 * message that names a table and a regular expression.
 */
const PROMO_REFUSALS: Readonly<Record<string, string>> = {
  promo_codes_code_unique:
    "That code already exists. Codes are stored upper-case, so LAUNCH50 and launch50 are the same code.",
  promo_codes_code_has_no_whitespace:
    "A code cannot be empty or contain spaces.",
  promo_codes_code_is_upper_case: "A code cannot be empty or contain spaces.",
  promo_codes_has_at_least_one_effect:
    "A code has to do something: extend the trial, apply a discount, or both.",
  promo_codes_trial_extension_is_positive:
    "The trial extension has to be a whole number of days above zero. Leave it empty for a code that only discounts.",
  promo_codes_discount_percent_off_is_in_range:
    "Percent off has to be above 0 and at most 100.",
  promo_codes_discount_amount_off_is_positive:
    "Amount off has to be above zero, in minor units.",
  promo_codes_discount_currency_is_lowercase_iso_4217:
    "The currency has to be a three-letter ISO code in lower case — usd, not USD.",
  promo_codes_discount_months_iff_repeating:
    "A repeating discount needs a month count; 'once' and 'forever' must not carry one.",
  promo_codes_discount_months_is_positive:
    "The month count has to be above zero.",
  promo_codes_max_redemptions_is_positive:
    "The redemption cap has to be above zero. Leave it empty for an uncapped code.",
  promo_codes_validity_window_is_ordered:
    "The end of the validity window has to be after its start.",
  // 0051's rules. NOT re-checked before the INSERT — see this module's header
  // on why the database keeps every rule — so these are the sentences an
  // operator gets when a request arrives carrying something the three
  // checkboxes cannot produce. That is not a hypothetical shape: a server
  // action's argument is whatever the client sent, and `PromoCodePlan` is a
  // compile-time claim about the caller, not a runtime one.
  //
  // `promo_codes_allowed_plans_is_not_empty` is deliberately absent: an empty
  // list is the one shape this module DOES translate, because it is what the
  // form's untouched checkbox group means. See {@link authoredScope}.
  promo_codes_allowed_plans_are_known_plans:
    "A code can be scoped to Starter, Studio or Pro. Leave every box unticked for a code that applies to all three.",
  promo_codes_allowed_plans_has_no_null_elements:
    "The plan list arrived with an empty entry in it. Re-pick the plans this code applies to.",
  promo_codes_allowed_plans_has_no_duplicates:
    "The same plan was listed twice. Re-pick the plans this code applies to.",
  promo_code_stripe_coupons_pkey: ALREADY_MINTED_MESSAGE,
};

/**
 * The form's selection, as the database spells it: `null` for unscoped.
 *
 * THIS IS THE ONE PLACE THE EMPTY LIST IS TRANSLATED, and it belongs here
 * rather than in the repository on purpose. `createPromoCode` refuses to make
 * this call — its doc says so at length — because an `[]` arriving there is
 * ambiguous: a caller that built it might have meant "no plans" (nothing can
 * redeem this) or "I did not scope it" (everything can), and guessing the
 * second would ship the widest possible scope for a code someone believed they
 * had narrowed. That refusal is right, and nothing below weakens it — the
 * repository still receives `null` or a non-empty list and still lets
 * `promo_codes_allowed_plans_is_not_empty` answer anything else.
 *
 * What this layer has that the repository does not is the KNOWLEDGE OF THE
 * FORM. The control is a checkbox group with no third state, so an untouched
 * one is an operator who did not scope the code — which is exactly the reading
 * the repository would have had to guess at, and is not a guess here. The
 * ambiguity is resolved where the meaning is known, and once.
 *
 * A `null` argument means the same thing and is passed through, so a caller may
 * spell "unscoped" either way and neither reaches the database as `[]`.
 *
 * IT DOES NOT TAKE `undefined`, and the omission is load-bearing on the
 * amendment path: there, `undefined` means "leave the scope alone" and `null`
 * means "clear it", so a signature that swallowed both would turn every
 * amendment of the validity window into a silent widening of the scope. The
 * caller has to say which it means, and the compiler makes it.
 */
function authoredScope(plans: readonly PromoCodePlan[] | null): readonly PromoCodePlan[] | null {
  return plans === null || plans.length === 0 ? null : plans;
}

/** The constraint a driver error names, if it names one. `pg` sets
 *  `constraint`; the message carries the name too, and is read as the
 *  fallback so a wrapped or re-thrown error is still translated. */
function violatedConstraint(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null) return null;
  const named = (cause as { constraint?: unknown }).constraint;
  if (typeof named === "string" && named.length > 0) return named;
  const message = cause instanceof Error ? cause.message : "";
  return Object.keys(PROMO_REFUSALS).find((name) => message.includes(name)) ?? null;
}

function promoRefusal(cause: unknown): string | null {
  const constraint = violatedConstraint(cause);
  return constraint === null ? null : (PROMO_REFUSALS[constraint] ?? null);
}

const CATALOG_SURFACE_PATH = "/platform/billing/catalog";

/**
 * The definition half's wrapper: one capability, one audit row, one message
 * vocabulary. Deliberately not `withDraftWrite` — that function's copy is
 * about the plan catalog ("edit the plan catalog"), and sharing it would tie
 * this surface's wording to a change in that one.
 */
async function withPromoWrite<T>(
  target: string,
  run: (actor: { sub: string }) => Promise<T>,
  describe: (result: T) => AuditDescription,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    const session = await getCurrentSession();
    const actor = { sub: session?.sub ?? "unknown" };
    const value = await auditedOperation({
      actor: actor.sub,
      target,
      operation: async () => {
        await checkOperatorCapabilityLive(session, "billing");
        return run(actor);
      },
      describe,
    });
    return { ok: true, value };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_PERMISSION_MESSAGE };
    }
    const refusal = promoRefusal(cause);
    if (refusal === null) {
      // Same reasoning as the mint path below: an unrecognised cause is the
      // one this branch cannot describe, so discarding it leaves nobody able
      // to say what happened.
      console.error(`[console] promo write failed for ${target} — cause not recognised`, cause);
    }
    return { ok: false, message: refusal ?? NOT_SAVED_MESSAGE };
  }
}

/**
 * What the authoring form sends. A plain, serialisable shape — `Date`s are
 * ISO strings across the boundary, and `null` means "not set" throughout.
 *
 * `source` is absent: `DEFAULT_PROMO_CODE_SOURCE` is the only value 0046
 * admits, and offering a control for a closed set of one would be inventing a
 * decision for the operator to make wrongly.
 */
export interface PromoCodeDraftInput {
  readonly code: string;
  readonly trialExtensionDays: number | null;
  readonly discount: PromoCodeDiscount | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly maxRedemptions: number | null;
  /**
   * The plans this code is scoped to. The EMPTY LIST is accepted and means
   * unscoped — the form's untouched checkbox group — and never reaches the
   * database as `[]`; see {@link authoredScope}.
   */
  readonly allowedPlans: readonly PromoCodePlan[] | null;
  /** No monthly counterpart, because mark8ly's redeemer has none. 0051's
   *  header, and `promo-codes-panel.tsx`'s `NO_MONTHLY_ONLY_NOTE`, which is
   *  the operator-facing half of the same fact. */
  readonly annualOnly: boolean;
}

/** Author a definition. See this module's header on why nothing here
 *  re-checks 0046's rules. */
export async function createPromoCodeAction(
  input: PromoCodeDraftInput,
): Promise<PromoActionResult> {
  const code = normalisePromoCode(input.code);
  const result = await withPromoWrite(
    code,
    (actor) =>
      createPromoCode({
        code,
        trialExtensionDays: input.trialExtensionDays,
        discount: input.discount,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        maxRedemptions: input.maxRedemptions,
        allowedPlans: authoredScope(input.allowedPlans),
        // `=== true` and not a pass-through: this is a server action, so the
        // argument is whatever the client sent, and every other field here is
        // one the database will judge. A boolean column would take a truthy
        // string quietly.
        annualOnly: input.annualOnly === true,
        createdBy: actor.sub,
      }),
    (row) => ({
      action: "billing.promo.create",
      summary: { created: 1 },
      target: row.code,
    }),
  );
  if (!result.ok) return result;
  revalidatePath(CATALOG_SURFACE_PATH);
  return { ok: true };
}

/**
 * The fields an amendment may change — `UpdatePromoCodeInput` exactly, and it
 * carries NO discount terms.
 *
 * That absence is T1's, for a Stripe reason: a Coupon's `percent_off`,
 * `amount_off`, `currency` and `duration` are immutable after creation, so
 * editing terms under a minted coupon would leave this console displaying a
 * discount different from the one Stripe applies, with nothing to reconcile
 * them. The surface does not offer the control at all — see
 * `promo-codes-panel.tsx`'s "Replace this code" affordance for the path that
 * does work.
 */
export interface PromoCodeAmendment {
  readonly trialExtensionDays?: number | null;
  readonly validFrom?: string;
  readonly validUntil?: string | null;
  readonly maxRedemptions?: number | null;
  /**
   * THE CAMPAIGN SCOPE IS AMENDABLE, unlike the terms above it, and the reason
   * is that Stripe holds no copy of it to diverge from: a Coupon knows about
   * money and nothing about plans, so re-scoping a definition leaves a minted
   * coupon untouched and still correct.
   *
   * Omit to leave the scope alone; the empty list and `null` both mean
   * unscoped, which WIDENS the code to every plan. What this does not do is
   * reach mark8ly for a code it has already ingested — see
   * `promo-codes-panel.tsx`'s `describeScopeSyncGap`, which is where an
   * operator is told so.
   */
  readonly allowedPlans?: readonly PromoCodePlan[] | null;
  readonly annualOnly?: boolean;
}

export async function updatePromoCodeAction(
  id: string,
  code: string,
  changes: PromoCodeAmendment,
): Promise<PromoActionResult> {
  const result = await withPromoWrite(
    code,
    () =>
      updatePromoCode(id, {
        ...changes,
        // Each spread ONLY when the caller sent the key, because `undefined`
        // and `null` are different instructions here — "leave it" and "clear
        // it" — and `updatePromoCode` distinguishes them by presence. Writing
        // `allowedPlans: authoredScope(changes.allowedPlans ?? null)`
        // unconditionally would clear the scope on every amendment that never
        // mentioned it.
        ...(changes.allowedPlans === undefined
          ? {}
          : { allowedPlans: authoredScope(changes.allowedPlans) }),
        ...(changes.annualOnly === undefined
          ? {}
          : { annualOnly: changes.annualOnly === true }),
      }),
    (row) => ({
      action: "billing.promo.update",
      // `updatePromoCode` returns null for an unknown id AND for an empty
      // change set, and the audit row says `0` rather than claiming an
      // amendment that did not happen — `deactivatePromoCode`'s own rule.
      summary: { updated: row === null ? 0 : 1 },
      target: code,
    }),
  );
  if (!result.ok) return result;
  revalidatePath(CATALOG_SURFACE_PATH);
  return { ok: true };
}

/** Retire a definition. Never a delete — mark8ly's ledger references the code
 *  that was redeemed; see `deactivatePromoCode`. */
export async function deactivatePromoCodeAction(
  id: string,
  code: string,
): Promise<PromoActionResult> {
  const result = await withPromoWrite(
    code,
    () => deactivatePromoCode(id),
    (rows) => ({
      action: "billing.promo.deactivate",
      // The rows the UPDATE actually reported: a second deactivation matches
      // nothing and is audited as `0`.
      summary: { deactivated: rows.length },
      target: code,
    }),
  );
  if (!result.ok) return result;
  revalidatePath(CATALOG_SURFACE_PATH);
  return { ok: true };
}

/* ------------------------------------------------------------------------ *
 * Minting — the one action here that writes to Stripe
 * ------------------------------------------------------------------------ */

/**
 * Deterministic per (definition, mode), and namespaced by this caller the way
 * `publish-executor.ts`'s `idempotencyKeyFor` is.
 *
 * DETERMINISTIC IS THE POINT: a retry after a timeout — where the coupon may
 * already exist in Stripe and the response was lost — replays the same key
 * and gets the same coupon back rather than minting a second one. A random
 * key would make the network failure that this action cannot see into a
 * duplicate live coupon that nothing names.
 */
const MINT_KEY_VERSION = "v1";

function mintKey(promoCodeId: string, mode: StripeMode): string {
  return `promo-coupon:${MINT_KEY_VERSION}:${promoCodeId}:${mode}`;
}

/**
 * Which mode has no write credential, said in the operator's terms.
 *
 * `StripeWriteUnavailableError` covers two conditions — the variable is
 * unset, or it holds the OTHER mode's key — and its own message names the
 * variable and the mode. That message is internal (it is written for a run
 * log), so this is the operator-facing form of the same fact, and it names
 * the mode and the variable rather than collapsing into "something went
 * wrong". An operator not told WHICH mode they cannot write to has no way to
 * learn that the other one would have worked.
 *
 * This used to add that `STRIPE_WRITE_KEY_TEST` was unset "as of
 * tesserix-home#540", so every test mint failed here. That is no longer true —
 * all four read/write keys are present and both modes have minted
 * (`SAVEOFFER20OFF6MONTHS`: test 2026-09-05, live 2026-09-07). Which keys exist
 * is state that moves, so this comment no longer claims to know it; the message
 * below names the variable, which lets a reader check the current answer
 * instead of trusting a remembered one.
 */
function unavailableMessage(mode: StripeMode): string {
  return (
    `${mode} mode has no usable Stripe write credential (${WRITE_KEY_ENV[mode]} is unset, ` +
    `or holds a key for the other account), so nothing was minted in ${mode}. ` +
    `The definition is saved and can be minted once the credential is in place.`
  );
}

export async function mintCouponAction(
  code: string,
  mode: StripeMode,
): Promise<PromoActionResult> {
  const normalised = normalisePromoCode(code);
  try {
    const session = await getCurrentSession();
    const actor = { sub: session?.sub ?? "unknown" };
    await auditedOperation({
      actor: actor.sub,
      target: `${normalised} (${mode})`,
      operation: async () => {
        // BOTH, independently, and both inside `operation` — see this
        // module's header.
        await checkOperatorCapabilityLive(session, "billing");
        await checkOperatorCapabilityLive(session, "publish-catalog");

        // RE-READ, rather than trusting terms sent by the client. The terms
        // decide what a real Stripe account will charge; a client that could
        // supply them could mint a coupon the definition does not describe.
        const definition = await readPromoCodeByCode(normalised);
        if (definition === null) {
          throw new MintRefused("That code no longer exists.");
        }
        if (definition.discount === null) {
          throw new MintRefused(
            "This code extends the trial only. There is no discount to mint — trial extension is applied by mark8ly, not by a Stripe coupon.",
          );
        }

        // The pre-check that keeps a duplicate from becoming a real object.
        // `recordStripeCoupon`'s primary key is the backstop for the race
        // this read cannot close; reaching Stripe first would create a second
        // live coupon and only THEN fail, orphaning it.
        const minted = await readStripeCoupons(definition.id);
        if (minted.some((coupon) => coupon.mode === mode)) {
          throw new MintRefused(ALREADY_MINTED_MESSAGE);
        }

        const created = await stripeCatalogWriter.createCoupon(
          mode,
          {
            discount: definition.discount,
            // The code is the obvious label and `stripe-write.ts` cannot
            // derive it — that module does not know what a promo code is.
            // Without it the coupon shows in the dashboard as a bare `co_…`.
            name: definition.code,
            // `maxRedemptions` is DELIBERATELY NOT FORWARDED.
            // `promo_codes.max_redemptions` is the cap MARK8LY counts, on the
            // code, transactionally at signup; Stripe's cap counts a
            // different event in a different system. Sending it would create
            // two numbers that must agree with no way to make them —
            // `CreateCouponSpec.maxRedemptions`' own doc comment.
          },
          mintKey(definition.id, mode),
        );

        return recordStripeCoupon({
          promoCodeId: definition.id,
          mode,
          stripeCouponId: created.id,
          createdBy: actor.sub,
        });
      },
      describe: (coupon) => ({
        action: "billing.promo.coupon.mint",
        summary: { minted: 1, [`mode_${mode}`]: 1 },
        target: `${normalised} (${mode}) ${coupon.stripeCouponId}`,
      }),
    });
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_MINT_PERMISSION_MESSAGE };
    }
    if (cause instanceof MintRefused) {
      return { ok: false, message: cause.message };
    }
    if (cause instanceof StripeWriteUnavailableError) {
      return { ok: false, message: unavailableMessage(mode) };
    }
    if (cause instanceof StripeCouponTermsError) {
      // Its own class precisely so this branch can exist: a misconfigured
      // console and a definition with nothing to mint are different problems
      // and get different sentences.
      return {
        ok: false,
        message:
          "These discount terms are not something Stripe can mint a coupon from. Author a replacement code with corrected terms.",
      };
    }
    const refusal = promoRefusal(cause);
    if (refusal === null) {
      // The ONLY branch that reaches here has no recognised shape, which means
      // nothing above it knows what went wrong — so this is the one place the
      // cause can still be read, and it was being discarded.
      //
      // The cost was measured rather than assumed: a live mint failed on
      // 2026-09-06, the operator got the unrecognised-cause message, and the console
      // pods carried ZERO error lines for the six hours around it. Neither the
      // operator nor anyone reading the logs afterwards could say whether
      // Stripe refused the key's scope, rejected the terms, or timed out
      // mid-write — and that message deliberately allows the mint
      // MAY have half-succeeded, so "retry and see" is not a safe diagnosis.
      //
      // Server-side only: this is a server action, so it lands in the app's
      // logs and never in the response. The mode and code are the two facts
      // that make a Stripe dashboard search possible; `cause` carries Stripe's
      // own `type`/`code`/`requestId`, which is what distinguishes a scope
      // refusal from a bad request. Stripe SDK errors do not embed the API
      // key, so this does not leak the credential.
      console.error(
        `[console] promo coupon mint failed for ${normalised} (${mode}) — cause not recognised`,
        cause,
      );
    }
    return { ok: false, message: refusal ?? mintIncompleteMessage(mode) };
  }
  revalidatePath(CATALOG_SURFACE_PATH);
  return { ok: true };
}

/** A refusal this action decided itself, with text written to be shown
 *  verbatim — the same split `PublishRefused` draws in `actions.ts`. */
class MintRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MintRefused";
  }
}
