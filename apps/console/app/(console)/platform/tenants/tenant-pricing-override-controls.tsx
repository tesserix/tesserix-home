"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Callout,
  CalloutDescription,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from "@tesserix/web";
import { sourceLabel } from "@/lib/audit";
// A VALUE import, and it is safe: `source-policy.ts` has no imports at all —
// no `server-only`, no `pg` ancestry — which is the same clearance
// `promo-codes-repo.ts` cites for importing it as a value.
import { CATALOG_SOURCES } from "@/lib/billing/source-policy";
// TYPE-ONLY, the discipline every client module that names these keeps:
// `promo-codes-repo.ts` carries `import "server-only"` and reaches `pg`, so a
// value import would drag the driver into this bundle. `promo-codes-panel.tsx`
// imports the same two types the same way. `import type` is erased, so this
// costs nothing at runtime and nothing at bundle time.
import type { PromoCodeDiscount } from "@/lib/db/promo-codes-repo";
import type { StripeMode } from "@/lib/billing/stripe-read";
// TYPE-ONLY, and it must stay that way: `tenant-discount-write.ts` opens with
// `import "server-only"` and reaches the operator's platform API token. `import
// type` is erased, so this costs nothing at runtime and nothing at bundle time
// — the same clearance this file already cites for `PromoCodeDiscount`.
import type {
  TenantDiscountResult,
  TenantDiscountStore,
} from "@/lib/tenant-discount-write";
import { splitTenantId, type EstateTenant } from "@/lib/tenants";
import {
  grantTenantPricingOverrideAction,
  revokeTenantPricingOverrideAction,
} from "./actions";

/**
 * Giving one tenant a price nobody else gets, and taking it back, from its row
 * in the directory — tesserix-home#331 T2, and #581.
 *
 * The write lives in `lib/tenant-pricing-override-write.ts` behind
 * `./actions.ts`; this file is the affordance and the copy, on the surface
 * `tenant-lifecycle-controls.tsx` already established for "one consequential
 * change to one tenant, from its row". Everything exported besides the
 * component is a pure function, so the properties worth defending are testable
 * without driving a dialog.
 *
 * ══ A SUCCESS IS A COUPON PLUS A REPORT, AND THEY ARE TWO FACTS ══
 *
 * `grantTenantPricingOverride` mints a Stripe Coupon, records it, and asks
 * mark8ly — through platform-api's signed write — to put it on every
 * subscription the tenant owns. mark8ly fans out across the tenant's stores
 * and reports ONE OUTCOME PER STORE, so `ok: true` means "a coupon exists and
 * is recorded" and the attach is the separate `attach` half of the result.
 *
 * The two must never be merged in the copy. A grant can succeed with every
 * store applied, with some applied and some not, with none applied, or with
 * mark8ly never answering at all — and an operator who reads "20% off granted"
 * and tells the merchant the discount is live, when one of their three stores
 * took it, is the failure #331 exists to prevent.
 *
 * That is why {@link overrideMintedMessage} counts the stores that carry the
 * discount, names the ones that do not with mark8ly's own `failure_reason`,
 * and why the outcome renders in a warning callout rather than as the quiet
 * confirmation line the lifecycle control uses.
 *
 * COUNTS, NOT `status`. mark8ly's `status` says whether any store's
 * TRANSACTION failed; it is `ok` for a fan-out where every store was `pending`
 * — a card-less trial with no Stripe subscription to carry anything — so
 * reading it as "the discount is in force" would be wrong in exactly the
 * population an operator most often discounts.
 *
 * ══ AND A RETIREMENT IS THREE ACTS, TWO OF THEM THIS CONSOLE'S ══
 *
 * The second dialog is #581's, now complete. `revokeTenantPricingOverride`
 * retires this console's row — which frees 0047's partial unique index, so a
 * corrected override becomes grantable — then asks mark8ly to take the coupon
 * off the tenant's subscriptions, then deletes the Coupon. Deleting a Coupon
 * does NOT detach it: per Stripe's own reference it "does not affect any
 * customers who have already applied" it, which is why the detach is its own
 * step with its own reported outcome.
 *
 * So {@link overrideRetiredMessage} states what was retired, what mark8ly took
 * the discount off, which stores kept it — and, when the detach did not
 * happen, says plainly that the tenant is still discounted. A test asserts
 * that sentence appears exactly where it is true and nowhere else: a warning
 * that fires on every revoke is one an operator stops reading before the
 * revoke where it matters.
 */

/* ------------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------------ */

/**
 * Mirrors the lifecycle control's `NOT_APPLIED`, for the same reason and at
 * the same place: reached only when the server action CALL rejects — offline,
 * a 502 at the edge, an expired session — which never reaches the seam's own
 * error mapping and so has no message of its own.
 *
 * It does not say nothing happened, because it does not know: the request may
 * have arrived and minted — and gone on to apply the coupon to the tenant's
 * subscriptions — before the response was lost. That is the same ambiguity
 * `MINT_INCOMPLETE` in the seam describes, and the answer is the same one —
 * send the operator to look rather than invite a blind retry that mints a
 * second real coupon.
 *
 * TWO PLACES TO LOOK, not one, because the grant is now two acts in two
 * systems: the coupon lives in Stripe and the discount lives on mark8ly's
 * subscriptions, and a lost response can leave either or both.
 */
export const OVERRIDE_NOT_CONFIRMED =
  "That request could not be confirmed. Check the Stripe dashboard for this tenant, and their subscriptions in mark8ly, before trying again — a coupon may already have been minted and applied.";

/**
 * The outcomes that mean a store reached the goal of the call.
 *
 * READ FROM mark8ly's VOCABULARY, which platform-api copies verbatim from
 * `internal/billing/tenantdiscount/outcome.go`:
 *
 *   - apply — `applied` is the store this call attached the coupon to,
 *     `already_applied` is one that was carrying it before. Both carry it now,
 *     which is the only question this copy asks.
 *   - remove — `removed` is the store this call detached, `not_applied` is one
 *     that was not carrying it. Both are clear now.
 *
 * EVERY OTHER OUTCOME COUNTS AS "did not". That includes the ones that are not
 * failures — `pending` is a card-less trial with no Stripe subscription, and
 * `no_subscription` is a store with no billing at all — and it is deliberate:
 * this function answers "does this store carry the discount", and for those
 * the honest answer is no. The outcome word is printed beside the store, so an
 * operator reads what mark8ly actually said rather than this console's
 * judgement of it.
 */
const REACHED: Record<"apply" | "remove", readonly string[]> = {
  apply: ["applied", "already_applied"],
  remove: ["removed", "not_applied"],
};

/** `1 store` / `3 stores`. English, not a pluralisation library: this is the
 *  only count on the surface. */
function stores(count: number): string {
  return count === 1 ? "1 store" : `${count} stores`;
}

/**
 * The stores that did not reach the goal, named with mark8ly's own words.
 *
 * `failureReason` is that product's FIXED vocabulary — `storeFailure` composes
 * one of five literal sentences from the failure code, and its own comment
 * says the message "is composed here, never taken from err.Error()" — so it is
 * shown verbatim. It is set only for `failed`, which is why the outcome is
 * printed too: without it a `pending` store would render as a bare id with no
 * explanation at all.
 */
function missedStores(missed: readonly TenantDiscountStore[]): string {
  return missed
    .map((store) =>
      store.failureReason
        ? `${store.storeId} (${store.outcome} — ${store.failureReason})`
        : `${store.storeId} (${store.outcome})`,
    )
    .join("; ");
}

/** Whether Stripe moved somewhere mark8ly could not record, in the operator's
 *  terms. Its own fact and NOT a failure — which is why it is a sentence of
 *  its own rather than a word inside one of the sentences above. */
function reconciliationNote(report: TenantDiscountResult): string {
  if (!report.ok || !report.requiresReconciliation) return "";
  return (
    " mark8ly changed at least one subscription in Stripe and could not record it, so its own " +
    "account of this tenant's billing has diverged — reconcile it there before acting on the counts above."
  );
}

/**
 * What mark8ly did with the coupon, as one sentence.
 *
 * Shared by both dialogs because the shape of the answer is the same and only
 * the verb differs; the two verbs are passed in rather than derived, so a
 * caller cannot get a remove's sentence for an apply.
 */
function fanOutSentence(
  tenantName: string,
  operation: "apply" | "remove",
  report: TenantDiscountResult,
): string {
  // mark8ly never answered. Its message already says what is and is not known
  // and where to look, so it is shown verbatim rather than paraphrased into a
  // second, weaker sentence.
  if (!report.ok) return report.message;

  const reached = report.stores.filter((store) =>
    REACHED[operation].includes(store.outcome),
  );
  const missed = report.stores.filter(
    (store) => !REACHED[operation].includes(store.outcome),
  );
  const took = operation === "apply" ? "applied it to" : "took it off";
  const verb = operation === "apply" ? "get it" : "give it up";

  if (report.stores.length === 0) {
    // A report with no lines at all. Said rather than rendered as a count of
    // zero, which reads as a failure of the call rather than as a tenant with
    // no stores.
    return `mark8ly reported no stores for ${tenantName}.`;
  }
  if (missed.length === 0) {
    return `mark8ly ${took} all ${report.stores.length} of their stores.`;
  }
  const misses = `${stores(missed.length)} did not ${verb}: ${missedStores(missed)}.`;
  if (reached.length === 0) {
    return operation === "apply"
      ? `No store is carrying it, so ${tenantName}'s price has not moved. ${misses}`
      : `No store gave it up, so ${tenantName} is still discounted. ${misses}`;
  }
  return `mark8ly ${took} ${reached.length} of ${stores(report.stores.length)}. ${misses}`;
}

/**
 * What the operator is told after a mint the seam accepted.
 *
 * THREE FACTS, IN THIS ORDER: what now exists, what mark8ly did with it, and —
 * when there is one — what has diverged and must be reconciled by hand. The
 * second is read from the report rather than assumed, which is the whole
 * change T3 made to this function: before it, nothing could apply a coupon and
 * this sentence said so.
 *
 * "Applied" is now sayable, and only where mark8ly said it. A test asserts
 * that the claims which mean IN FORCE — "in force", "is applied to", "is now
 * active", "is being charged less", "is discounted" — are absent from every
 * message where no store carries the coupon. It asserts the claims rather than
 * the sentence, because the failure to guard against is a future rewording
 * that sounds friendlier and means something untrue.
 *
 * The coupon id is named because it is the only handle an operator has on the
 * object that now exists: the seam's own duplicate and incomplete-mint
 * messages both send them to the Stripe dashboard, and neither is useful
 * without it.
 *
 * The mode is named because a coupon minted in `test` against a live tenant is
 * a discount that silently does nothing — the reason the seam never defaults
 * `mode` — and after the dialog closes this line is the only place the choice
 * is still visible.
 */
export function overrideMintedMessage(
  tenantName: string,
  couponId: string,
  mode: StripeMode,
  attach: TenantDiscountResult,
): string {
  return (
    `Coupon ${couponId} was minted in ${mode} mode and recorded against ${tenantName}. ` +
    fanOutSentence(tenantName, "apply", attach) +
    reconciliationNote(attach)
  );
}

/**
 * {@link OVERRIDE_NOT_CONFIRMED}'s counterpart, and it is a separate sentence
 * because it sends the operator to two places rather than one.
 *
 * Reached on the same condition — the server action CALL rejected, so the seam
 * never mapped an error of its own — and it makes the same refusal to say
 * nothing happened: the request may have arrived and retired the row, and it
 * may have gone on to take the discount off the tenant's subscriptions and to
 * delete the coupon. All three halves are named because any of them can be the
 * state left behind, which is `RETIRE_INCOMPLETE`'s own reasoning in the seam.
 */
export const OVERRIDE_REVOKE_NOT_CONFIRMED =
  "That request could not be confirmed. Check this tenant's override, their subscriptions in mark8ly, and the Stripe dashboard, before trying again — the override may already have been retired, the discount taken off and the coupon deleted.";

/**
 * What the operator is told after a retirement the seam accepted.
 *
 * FOUR FACTS, IN THIS ORDER, the same discipline {@link overrideMintedMessage}
 * keeps: what this console did, what mark8ly did, what the operator can now do,
 * and what has diverged.
 *
 * 1. The row is retired and — in the `couponDeleted` case — the Coupon is gone.
 *    The id and the mode are named for {@link overrideMintedMessage}'s reasons,
 *    unchanged: the id is the operator's only handle on the object, and the
 *    mode says which of two real accounts was touched.
 * 2. What mark8ly did with the discount itself, per store. Deleting a Coupon
 *    does not detach it — Stripe's reference is explicit that it "does not
 *    affect any customers who have already applied" it — so this sentence is
 *    the only one that speaks to what the tenant is charged.
 * 3. A corrected override can now be granted. This is the affordance #581
 *    exists to restore — 0047's partial unique index counts a row with
 *    `removed_at IS NULL` as live, and there is no longer one.
 * 4. The reconciliation note, when mark8ly reports one.
 *
 * "cancelled", "refunded" and "revoked" are absent on purpose and a test
 * asserts their absence rather than the sentence: taking a coupon off a
 * subscription cancels nothing and refunds nothing, and a friendlier rewrite
 * that implies either would be a claim this console cannot make.
 *
 * "still discounted" is the sentence this function exists to be able to say,
 * and a test asserts it appears where a store kept the discount AND nowhere
 * else. A warning printed on every revoke is one an operator stops reading
 * before the revoke where it is true.
 */
export function overrideRetiredMessage(
  tenantName: string,
  couponId: string,
  mode: StripeMode,
  couponDeleted: boolean,
  detach: TenantDiscountResult,
): string {
  // TWO OBJECTS, NAMED SEPARATELY IN BOTH ARMS. The console retires its own
  // ROW and deletes a COUPON, and those are the two of a revoke's three steps
  // it owns — the third, detaching the discount from the subscriptions, is
  // mark8ly's and is the sentence that follows. "Coupon X was retired and
  // deleted" reads as one act on one object and loses exactly the distinction
  // the failed-delete arm below depends on being able to draw.
  const retired = couponDeleted
    ? `${tenantName}'s override was retired in ${mode} mode and coupon ${couponId} was deleted. `
    : `${tenantName}'s override was retired in ${mode} mode, but coupon ${couponId} was not deleted ` +
      `and is still live in the ${mode} Stripe account — delete it from the Stripe dashboard. `;
  // The warning goes with the DETACH, not with the delete: a coupon left in
  // Stripe is tidying, a discount left on a subscription is money.
  const stillDiscounted =
    detachIncomplete(detach) ? ` Treat ${tenantName} as still discounted until that is resolved.` : "";
  return (
    retired +
    fanOutSentence(tenantName, "remove", detach) +
    stillDiscounted +
    " A corrected override can now be granted." +
    reconciliationNote(detach)
  );
}

/**
 * Whether any store may still be carrying the discount.
 *
 * TRUE FOR AN UNANSWERED DETACH as well as for a reported one that missed a
 * store, and the first is the important half: mark8ly not answering means this
 * console does not know, and "does not know" must read as "assume it is still
 * there" on a question about what a merchant is being charged.
 */
function detachIncomplete(detach: TenantDiscountResult): boolean {
  if (!detach.ok) return true;
  return detach.stores.some((store) => !REACHED.remove.includes(store.outcome));
}

/**
 * Why the action is unavailable for a tenant belonging to a product this
 * console does not mint for.
 *
 * The coupon would be created in the Stripe account this console writes to —
 * the one mark8ly's catalog lives in ({@link CATALOG_SOURCES}) — for a tenant
 * that is not a customer in it, and the attach would be aimed at the product
 * that owns the tenant, which is not the product whose Stripe account holds
 * the coupon. So it is a real object in a real account that nothing could ever
 * use, and the only trace would be a row in `0047` pointing at it.
 *
 * THIS IS THE AFFORDANCE, NOT THE RULE. `grantTenantPricingOverride` does not
 * check the source and would mint for any tenant id; this disables the button
 * before that happens. The comment says so rather than implying a guard the
 * seam does not have — stating a rule more broadly than the code implements it
 * is this estate's documented recurring defect.
 *
 * Exported so a test asserts the shipped sentence rather than a second copy.
 */
export function overrideUnavailableNotice(product: string): string {
  // EVERY source, not `CATALOG_SOURCES[0]`. {@link mintsFor} admits all of
  // them, so naming only the first would leave a second product's tenants with
  // a working button and a notice that says they are somebody else's — the
  // exact drift `source-policy.ts` argues against, one layer up.
  const mints = CATALOG_SOURCES.map(sourceLabel).join(" and ");
  return (
    `Pricing overrides are minted only for ${mints} tenants, and this one belongs to ` +
    `${sourceLabel(product)}. Change its price from that product's own admin.`
  );
}

/**
 * The dialog's plain statement of what confirming does — all three steps of it.
 * Consequential enough to spell out rather than leave to the button's verb, the
 * same judgement `consequence` makes in the lifecycle control.
 *
 * The last sentence is the honest one and it is not decoration: mark8ly fans
 * out across the tenant's stores and each store's outcome stands alone, so an
 * operator has to expect a partial answer BEFORE they read one. Nothing pinned
 * this string until T3 — it went on saying the console could not apply what it
 * minted long enough for that to be worth a test, which now exists.
 */
function consequence(tenantName: string, mode: StripeMode | ""): string {
  const where = mode === "" ? "a Stripe account" : `the ${mode} Stripe account`;
  return (
    `A coupon with these terms will be created in ${where} and recorded against ${tenantName}, ` +
    "and mark8ly will be asked to apply it to their subscriptions. " +
    "Each of their stores is reported on separately, and some can take it while others do not."
  );
}

/** The retire dialog's counterpart of {@link consequence}, spelling out the
 *  same three steps in the order they run. The first clause is the operator's
 *  reason for being here — a correction becomes grantable — and the last is the
 *  one an operator must not close the dialog without having read: a detach that
 *  does not happen leaves the merchant paying the discounted price. */
function revokeConsequence(tenantName: string, mode: StripeMode | ""): string {
  const where = mode === "" ? "a Stripe account" : `the ${mode} Stripe account`;
  return (
    `This console's record of ${tenantName}'s override will be retired, mark8ly will be asked to take ` +
    `the coupon off their subscriptions, and the coupon will be deleted in ${where} — so a corrected ` +
    "override can be granted. Any store mark8ly cannot take it off stays discounted, and is named here."
  );
}

/* ------------------------------------------------------------------------ *
 * The form, and the pure functions over it
 * ------------------------------------------------------------------------ */

/**
 * Every choice starts UNMADE, which is why each of these unions carries `""`.
 *
 * `mode` and `duration` are the two #331 names — a `test` coupon against a
 * live tenant does nothing, and a duration nobody chose is a discount whose
 * length nobody decided — and `kind` is here for the same reason rather than a
 * different one: percent-off and amount-off are not interchangeable and a
 * defaulted one would be a discount the operator did not pick.
 *
 * The numeric and text fields are strings because that is what an input holds.
 * They are narrowed by {@link overrideDiscount}, never by the state setter, so
 * an operator part-way through typing "1" of "12" is not a validation event.
 */
export interface OverrideForm {
  readonly mode: StripeMode | "";
  readonly kind: PromoCodeDiscount["kind"] | "";
  readonly percentOff: string;
  readonly amountOff: string;
  /**
   * NOT defaulted, unlike the promo author form's `usd`.
   *
   * That form authors one code for a product-wide audience and the operator
   * picks the currency the campaign is in. This one names a single tenant, and
   * nothing in this dialog knows what currency that tenant is billed in —
   * `EstateTenant` carries an id, a name, a status, an owner and a created
   * date, and no money at all. A default here would be a guess made on one
   * named merchant's behalf.
   */
  readonly currency: string;
  readonly duration: PromoCodeDiscount["duration"] | "";
  readonly months: string;
  readonly label: string;
  readonly reason: string;
}

export const EMPTY_OVERRIDE_FORM: OverrideForm = {
  mode: "",
  kind: "",
  percentOff: "",
  amountOff: "",
  currency: "",
  duration: "",
  months: "",
  label: "",
  reason: "",
};

/**
 * A number field's value, or `undefined` for anything this form cannot answer
 * with yet — empty, or text that is not a number.
 *
 * TWO OUTCOMES, not the three `optionalNumber` draws in the promo author form.
 * That form has optional numeric fields, where "left empty" and "typo" are
 * different operator intentions and collapsing them would silently clear a cap
 * somebody set. This form has no optional numeric field: every number here is
 * required by whichever branch reveals it, so both cases mean the same thing —
 * not answerable yet, keep the button disabled.
 *
 * RANGES ARE NOT CHECKED HERE. Whether a percentage is within Stripe's bounds,
 * and whether a month count is a whole number above zero, are the seam's rules
 * (`validate`) and Stripe's; a second copy here would be free to disagree with
 * them. What this refuses is text that is not a number at all, which is a parse
 * failure rather than one of those rules.
 */
function numberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The form's discount terms, or `undefined` while any part of them is unmade.
 *
 * `durationInMonths` is `null` for every duration but `repeating`, and the
 * typed months are DISCARDED rather than carried: the seam refuses a month
 * count on a `once` or `forever` discount, so sending one an operator typed
 * before switching duration would be a round trip and a refusal for a form
 * that reads, on screen, as correct — the months input is not even rendered at
 * that point.
 */
export function overrideDiscount(form: OverrideForm): PromoCodeDiscount | undefined {
  if (form.duration === "") return undefined;

  let durationInMonths: number | null = null;
  if (form.duration === "repeating") {
    const months = numberOrUndefined(form.months);
    if (months === undefined) return undefined;
    durationInMonths = months;
  }

  const shared = { duration: form.duration, durationInMonths } as const;

  if (form.kind === "percent_off") {
    const percentOff = numberOrUndefined(form.percentOff);
    if (percentOff === undefined) return undefined;
    return { ...shared, kind: "percent_off", percentOff };
  }

  if (form.kind === "amount_off") {
    const amountOffMinor = numberOrUndefined(form.amountOff);
    const currency = form.currency.trim();
    if (amountOffMinor === undefined || currency === "") return undefined;
    return { ...shared, kind: "amount_off", amountOffMinor, currency };
  }

  // `kind` unchosen. Reached only from `""` — the union has no other arm.
  return undefined;
}

/**
 * Whether the confirm button is enabled.
 *
 * Every condition here is one the seam would refuse anyway, and that is the
 * point: an enabled button in any of these states would only ever produce a
 * round trip and a refusal — the lifecycle control's reasoning for disabling
 * on an unchosen reason code. It is NOT a second copy of `validate`: the rules
 * it does not restate (label length, whole-number months, what Stripe will
 * accept as terms) all come back as field-targeted refusals, which is why
 * {@link overrideFieldPlacement} exists.
 */
export function overrideSubmittable(form: OverrideForm): boolean {
  return (
    form.mode !== "" &&
    form.label.trim() !== "" &&
    form.reason.trim() !== "" &&
    overrideDiscount(form) !== undefined
  );
}

/**
 * The retire dialog's whole form: which account the override was minted in, and
 * why it is being retired.
 *
 * `mode` is asked rather than looked up because nothing this control holds
 * knows the answer — `EstateTenant` carries no override, and the seam reads the
 * live row itself, per mode. Unchosen for {@link OverrideForm}'s reason
 * inverted: retiring the `test` row leaves a `live` discount in place while
 * reporting a revoke, which is the seam's own argument for never defaulting it.
 */
export interface OverrideRevokeForm {
  readonly mode: StripeMode | "";
  readonly reason: string;
}

export const EMPTY_OVERRIDE_REVOKE_FORM: OverrideRevokeForm = {
  mode: "",
  reason: "",
};

/**
 * Whether the retire dialog's confirm button is enabled.
 *
 * Both conditions are ones `revokeTenantPricingOverride` would refuse anyway —
 * a mode is required by its input and `validateRevoke` refuses a blank reason —
 * so an enabled button in either state would only ever produce a round trip and
 * a refusal. {@link overrideSubmittable}'s reasoning, on a shorter form.
 */
export function overrideRevokeSubmittable(form: OverrideRevokeForm): boolean {
  return form.mode !== "" && form.reason.trim() !== "";
}

/** The `field` names the MINT dialog has an input for. Whether that input is on
 *  screen is a separate question — see {@link overrideFieldPlacement}. The
 *  retire dialog has one field and reads `field` directly; see its `reasonError`
 *  in the component. */
const OVERRIDE_FIELDS = [
  "label",
  "reason",
  "discount",
  "duration",
  "durationInMonths",
] as const;

export type OverrideField = (typeof OVERRIDE_FIELDS)[number];

/**
 * Where a refusal's message is shown.
 *
 * `field` is READ, never re-derived from the message text — the seam names the
 * input it means, and matching on wording would break the first time a
 * sentence was reworded.
 *
 * A field this dialog does not render falls back to `"form"`, so a refusal the
 * seam grows later is still shown to the operator rather than swallowed
 * silently. That is the case worth testing: a message that lands nowhere is
 * indistinguishable, on screen, from a request that succeeded.
 */
export function overrideFieldPlacement(
  field: string | undefined,
  form: OverrideForm,
): OverrideField | "form" {
  if (!(OVERRIDE_FIELDS as readonly string[]).includes(field ?? "")) return "form";
  const named = field as OverrideField;

  // TAKES THE FORM because "a field this dialog renders" is not a property of
  // the field name alone: the months input exists only while `repeating` is
  // chosen. The seam has a refusal for exactly that combination — a month
  // count on a discount that does not repeat — and `field` names an input the
  // operator cannot see, so it goes to form level with the rest.
  //
  // Unreachable from this control today, because {@link overrideDiscount}
  // discards months for every other duration and so never sends the pair that
  // refusal describes. It is handled anyway: the name is a KNOWN one, so the
  // unknown-name fallback above would not have caught it, and this control is
  // not the only thing that could ever call the seam.
  if (named === "durationInMonths" && form.duration !== "repeating") return "form";

  return named;
}

/**
 * Whether this console mints for the product that owns the tenant.
 *
 * Read from {@link CATALOG_SOURCES} rather than compared against a literal
 * `"mark8ly"`, the drift argument `source-policy.ts` makes for the constant
 * itself: a second product added there must not leave a hardcoded string here
 * refusing its tenants.
 */
function mintsFor(product: string): boolean {
  return (CATALOG_SOURCES as readonly string[]).includes(product);
}

/* ------------------------------------------------------------------------ *
 * The control
 * ------------------------------------------------------------------------ */

export interface TenantPricingOverrideActionProps {
  tenant: EstateTenant;
  /**
   * Injected so the render tests can drive every result shape the seam
   * produces. Defaults to the real server action — the same shape the
   * lifecycle control's `onSubmit` takes, for the same reason.
   */
  onSubmit?: typeof grantTenantPricingOverrideAction;
  /** The retire half's counterpart of {@link onSubmit}, injected for the same
   *  reason: the seam's revoke has two success shapes and a refusal, and the
   *  render tests drive all three. */
  onRevoke?: typeof revokeTenantPricingOverrideAction;
}

const ACTION_LABEL = "Pricing override";
const REVOKE_LABEL = "Retire override";

export function TenantPricingOverrideAction({
  tenant,
  onSubmit = grantTenantPricingOverrideAction,
  onRevoke = revokeTenantPricingOverrideAction,
}: TenantPricingOverrideActionProps) {
  const router = useRouter();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<OverrideForm>(EMPTY_OVERRIDE_FORM);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  // ONE notice for both dialogs, and that is not a shortcut: only one of them
  // can be open at a time, so the second outcome an operator sees is always
  // about the more recent act. Two would leave a stale mint line sitting under
  // a retirement of the coupon it named.
  const [notice, setNotice] = useState<string | null>(null);

  // The retire dialog's own state, kept apart from the mint's rather than
  // shared. A refusal from one dialog rendered inside the other would point at
  // an input that belongs to a different request, and `pending` is separate so
  // an in-flight mint cannot grey out a dialog it is not running in.
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeForm, setRevokeForm] = useState<OverrideRevokeForm>(EMPTY_OVERRIDE_REVOKE_FORM);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<{ message: string; field?: string } | null>(
    null,
  );

  // The PRODUCT that owns this tenant, taken from the namespaced id rather
  // than from `tenant.source`, so the product checked and the tenant id the
  // write is aimed at cannot disagree — the lifecycle control's reasoning.
  const { source } = splitTenantId(tenant.id);

  if (!mintsFor(source)) {
    // Disabled with the reason beside it, not hidden: a control that vanishes
    // for some rows reads as a rendering fault, one that explains itself reads
    // as the deliberate gap it is.
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            aria-describedby={`${fieldId}-unavailable`}
          >
            {ACTION_LABEL}
          </Button>
          {/* Disabled for the same reason and under the same notice: this
              console never minted for this product, so there is no row of its
              own to retire and no coupon of its own to delete. An enabled
              retire here could only ever refuse. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            aria-describedby={`${fieldId}-unavailable`}
          >
            {REVOKE_LABEL}
          </Button>
        </div>
        <span id={`${fieldId}-unavailable`} className="text-xs text-muted-foreground">
          {overrideUnavailableNotice(source)}
        </span>
      </div>
    );
  }

  const field = <K extends keyof OverrideForm>(key: K, value: OverrideForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const reset = () => {
    setForm(EMPTY_OVERRIDE_FORM);
    setError(null);
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const placement = error ? overrideFieldPlacement(error.field, form) : null;
  const errorFor = (name: OverrideField) =>
    placement === name && error ? error.message : undefined;
  const formError = placement === "form" && error ? error.message : null;

  const submit = async () => {
    // Narrowed before the call rather than asserted through: `overrideDiscount`
    // returning `undefined` is the same condition that disables the button, so
    // this is unreachable from the UI — it is here because the type says so and
    // an unchecked cast would be the one place a half-filled discount could
    // reach a real Stripe account.
    const discount = overrideDiscount(form);
    if (form.mode === "" || discount === undefined) return;

    setError(null);
    setPending(true);
    try {
      const result = await onSubmit({
        tenantId: tenant.id,
        mode: form.mode,
        discount,
        label: form.label,
        reason: form.reason,
      });
      if (!result.ok) {
        setError({ message: result.message, field: result.field });
        return;
      }
      setNotice(overrideMintedMessage(tenant.name, result.couponId, form.mode, result.attach));
      setOpen(false);
      reset();
      // Re-read rather than patch locally, as the lifecycle control does: the
      // directory is the products' answer, and another operator may have
      // changed this tenant while the dialog was open.
      router.refresh();
    } catch {
      setError({ message: OVERRIDE_NOT_CONFIRMED });
    } finally {
      setPending(false);
    }
  };

  const revokeReset = () => {
    setRevokeForm(EMPTY_OVERRIDE_REVOKE_FORM);
    setRevokeError(null);
  };

  const revokeClose = () => {
    setRevokeOpen(false);
    revokeReset();
  };

  // Read, never re-derived from the message text — {@link overrideFieldPlacement}'s
  // rule, applied to a dialog small enough not to need the function. `reason`
  // is the only field `validateRevoke` names; anything else goes to form level,
  // which is where a refusal the seam grows later lands rather than nowhere.
  const revokeReasonError = revokeError?.field === "reason" ? revokeError.message : undefined;
  const revokeFormError =
    revokeError && revokeError.field !== "reason" ? revokeError.message : null;

  const submitRevoke = async () => {
    // Narrowed rather than asserted through, `submit`'s reason: an unchosen
    // mode is the condition that disables the button, so this is unreachable
    // from the UI, and a cast past it would be the one place a retirement could
    // be aimed at an account nobody picked.
    if (revokeForm.mode === "") return;

    setRevokeError(null);
    setRevokePending(true);
    try {
      const result = await onRevoke({
        tenantId: tenant.id,
        mode: revokeForm.mode,
        reason: revokeForm.reason,
      });
      if (!result.ok) {
        setRevokeError({ message: result.message, field: result.field });
        return;
      }
      setNotice(
        overrideRetiredMessage(
          tenant.name,
          result.couponId,
          revokeForm.mode,
          result.couponDeleted,
          result.detach,
        ),
      );
      setRevokeOpen(false);
      revokeReset();
      router.refresh();
    } catch {
      setRevokeError({ message: OVERRIDE_REVOKE_NOT_CONFIRMED });
    } finally {
      setRevokePending(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          // Every row renders a control with the same visible text, so a query
          // by that text alone cannot address a particular tenant's — the same
          // fix the lifecycle control and `ToolsManager` apply to theirs.
          aria-label={`${ACTION_LABEL} for ${tenant.name}`}
          onClick={() => {
            // Seeded at open time, not mount time: rows are keyed on the
            // namespaced id, so this component is reconciled rather than
            // remounted and an abandoned previous open would otherwise leak in.
            reset();
            setNotice(null);
            setOpen(true);
          }}
        >
          {ACTION_LABEL}
        </Button>

        {/* Not disabled on "this tenant has no override": this control does not
            know. `EstateTenant` carries no override and nothing here reads
            0047 — the seam does, and answers with `nothingToRevoke`, which says
            more than a greyed-out button could. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Retire pricing override for ${tenant.name}`}
          onClick={() => {
            revokeReset();
            setNotice(null);
            setRevokeOpen(true);
          }}
        >
          {REVOKE_LABEL}
        </Button>
      </div>

      {notice ? (
        // A WARNING callout, not the muted confirmation line the lifecycle
        // control uses, and `role="status"` rather than `alert` because the
        // write did complete. The tone carries the one thing the operator must
        // not skim past: a coupon exists and the tenant's price has not moved.
        <Callout role="status" variant="warning" className="max-w-md">
          <CalloutDescription>{notice}</CalloutDescription>
        </Callout>
      ) : null}

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            {/* Names the tenant, so this is not a generic dialog that could
                belong to any of the rows behind it. */}
            <DialogTitle>Pricing override for {tenant.name}</DialogTitle>
            <DialogDescription>{consequence(tenant.name, form.mode)}</DialogDescription>
          </DialogHeader>

          {/* The dialog focuses the first focusable element inside its content
              and the footer is last in DOM order, so what receives focus is the
              mode select — the choice with the quietest failure on this form,
              and the first one an operator should meet. */}
          <form
            id={`${fieldId}-form`}
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-mode`}>Stripe account</Label>
              {/* Native selects throughout, matching the lifecycle control:
                  this sits inside a confirmation an operator must be able to
                  complete from the keyboard alone, and a native select is the
                  one control whose behaviour is guaranteed there. */}
              <select
                id={`${fieldId}-mode`}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={form.mode}
                disabled={pending}
                onChange={(event) => field("mode", event.target.value as StripeMode | "")}
              >
                <option value="" disabled>
                  Choose an account…
                </option>
                <option value="test">test</option>
                <option value="live">live</option>
              </select>
              <p className="text-xs text-muted-foreground">
                A coupon minted in test mode does nothing for a tenant billed in live mode.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-kind`}>Discount</Label>
              <select
                id={`${fieldId}-kind`}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={form.kind}
                disabled={pending}
                aria-invalid={errorFor("discount") ? true : undefined}
                aria-describedby={errorFor("discount") ? `${fieldId}-discount-error` : undefined}
                onChange={(event) =>
                  field("kind", event.target.value as PromoCodeDiscount["kind"] | "")
                }
              >
                <option value="" disabled>
                  Choose a discount…
                </option>
                <option value="percent_off">Percent off</option>
                <option value="amount_off">Amount off</option>
              </select>
              {errorFor("discount") ? (
                <span
                  id={`${fieldId}-discount-error`}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {errorFor("discount")}
                </span>
              ) : null}
            </div>

            {form.kind === "percent_off" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${fieldId}-percent-off`}>Percent off</Label>
                <Input
                  id={`${fieldId}-percent-off`}
                  value={form.percentOff}
                  disabled={pending}
                  onChange={(event) => field("percentOff", event.target.value)}
                />
              </div>
            ) : null}

            {form.kind === "amount_off" ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${fieldId}-amount-off`}>Amount off (minor units)</Label>
                  <Input
                    id={`${fieldId}-amount-off`}
                    value={form.amountOff}
                    disabled={pending}
                    onChange={(event) => field("amountOff", event.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${fieldId}-currency`}>Currency</Label>
                  <Input
                    id={`${fieldId}-currency`}
                    value={form.currency}
                    disabled={pending}
                    onChange={(event) => field("currency", event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    The currency this tenant is billed in. This console does not know it.
                  </p>
                </div>
              </>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-duration`}>How long it lasts</Label>
              <select
                id={`${fieldId}-duration`}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={form.duration}
                disabled={pending}
                aria-invalid={errorFor("duration") ? true : undefined}
                aria-describedby={errorFor("duration") ? `${fieldId}-duration-error` : undefined}
                onChange={(event) =>
                  field("duration", event.target.value as PromoCodeDiscount["duration"] | "")
                }
              >
                <option value="" disabled>
                  Choose a duration…
                </option>
                <option value="once">once</option>
                <option value="repeating">repeating</option>
                <option value="forever">forever</option>
              </select>
              {errorFor("duration") ? (
                <span
                  id={`${fieldId}-duration-error`}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {errorFor("duration")}
                </span>
              ) : null}
            </div>

            {/* Revealed by `repeating` and by nothing else. Rendering it
                always would offer a months box on a `forever` discount, which
                the seam refuses. */}
            {form.duration === "repeating" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${fieldId}-months`}>Months</Label>
                <Input
                  id={`${fieldId}-months`}
                  value={form.months}
                  disabled={pending}
                  aria-invalid={errorFor("durationInMonths") ? true : undefined}
                  aria-describedby={
                    errorFor("durationInMonths") ? `${fieldId}-months-error` : undefined
                  }
                  onChange={(event) => field("months", event.target.value)}
                />
                {errorFor("durationInMonths") ? (
                  <span
                    id={`${fieldId}-months-error`}
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {errorFor("durationInMonths")}
                  </span>
                ) : null}
              </div>
            ) : null}

            {/* ── The two mandatory free-text fields ──────────────────────
                They are deliberately unlike each other. One is printed on the
                tenant's invoice and one is never sent to Stripe at all, and an
                operator who typed the second into the first has published
                their private justification to the merchant. So they differ in
                control (a single-line input against a textarea), in label, and
                in a help line that names the AUDIENCE rather than describing
                the field — which is the only distinction that tells an
                operator which is which. */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-label`}>Name on the tenant&apos;s invoice</Label>
              <Input
                id={`${fieldId}-label`}
                value={form.label}
                disabled={pending}
                placeholder="Launch partner discount"
                aria-invalid={errorFor("label") ? true : undefined}
                aria-describedby={errorFor("label") ? `${fieldId}-label-error` : undefined}
                onChange={(event) => field("label", event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The tenant reads this beside the discount on their invoice.
              </p>
              {errorFor("label") ? (
                <span
                  id={`${fieldId}-label-error`}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {errorFor("label")}
                </span>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-reason`}>Why (internal)</Label>
              <Textarea
                id={`${fieldId}-reason`}
                value={form.reason}
                rows={3}
                disabled={pending}
                placeholder="Why this tenant is being given a different price."
                aria-invalid={errorFor("reason") ? true : undefined}
                aria-describedby={errorFor("reason") ? `${fieldId}-reason-error` : undefined}
                onChange={(event) => field("reason", event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Never sent to Stripe and never shown to the tenant. Recorded against the grant.
              </p>
              {errorFor("reason") ? (
                <span
                  id={`${fieldId}-reason-error`}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {errorFor("reason")}
                </span>
              ) : null}
            </div>

            {formError ? (
              <Callout role="alert" variant="destructive">
                <CalloutDescription>{formError}</CalloutDescription>
              </Callout>
            ) : null}
          </form>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={`${fieldId}-form`}
              // Not `destructive`: this does not take a merchant offline, and
              // dressing every consequential confirmation in red teaches
              // operators to ignore the colour — the lifecycle control's own
              // reason for styling only one of its two verbs.
              disabled={pending || !overrideSubmittable(form)}
            >
              {pending ? "Please wait…" : "Mint coupon"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={revokeOpen}
        onOpenChange={(next) => (next ? setRevokeOpen(true) : revokeClose())}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Retire the pricing override for {tenant.name}?</DialogTitle>
            <DialogDescription>
              {revokeConsequence(tenant.name, revokeForm.mode)}
            </DialogDescription>
          </DialogHeader>

          <form
            id={`${fieldId}-revoke-form`}
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submitRevoke();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-revoke-mode`}>
                Stripe account the override was minted in
              </Label>
              {/* Native, for the mint dialog's stated reasons. Labelled by the
                  account the coupon is IN rather than "Stripe account": the two
                  dialogs ask about different moments, and an operator who reads
                  this as "where to retire it" has been told nothing wrong, but
                  one who has a coupon in each mode needs the distinction. */}
              <select
                id={`${fieldId}-revoke-mode`}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={revokeForm.mode}
                disabled={revokePending}
                onChange={(event) =>
                  setRevokeForm((current) => ({
                    ...current,
                    mode: event.target.value as StripeMode | "",
                  }))
                }
              >
                <option value="" disabled>
                  Choose an account…
                </option>
                <option value="test">test</option>
                <option value="live">live</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Retiring the test override leaves a live one in place, and the other way round.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-revoke-reason`}>Why (internal)</Label>
              <Textarea
                id={`${fieldId}-revoke-reason`}
                value={revokeForm.reason}
                rows={3}
                disabled={revokePending}
                placeholder="Why this tenant's different price is being taken back."
                aria-invalid={revokeReasonError ? true : undefined}
                aria-describedby={
                  revokeReasonError ? `${fieldId}-revoke-reason-error` : undefined
                }
                onChange={(event) =>
                  setRevokeForm((current) => ({ ...current, reason: event.target.value }))
                }
              />
              {/* The same audience line the mint dialog's reason carries, minus
                  its last clause: this reason is recorded against nothing here.
                  The seam validates it and stores it nowhere — 0047's header —
                  and saying "recorded against the retirement" would describe a
                  row this console does not write. */}
              <p className="text-xs text-muted-foreground">
                Never sent to Stripe and never shown to the tenant.
              </p>
              {revokeReasonError ? (
                <span
                  id={`${fieldId}-revoke-reason-error`}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {revokeReasonError}
                </span>
              ) : null}
            </div>

            {revokeFormError ? (
              <Callout role="alert" variant="destructive">
                <CalloutDescription>{revokeFormError}</CalloutDescription>
              </Callout>
            ) : null}
          </form>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={revokePending}
              onClick={revokeClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form={`${fieldId}-revoke-form`}
              // Not `destructive`, the mint button's reasoning unchanged: this
              // takes no merchant offline, and it is the step that unblocks a
              // correction rather than one that ends anything.
              disabled={revokePending || !overrideRevokeSubmittable(revokeForm)}
            >
              {revokePending ? "Please wait…" : REVOKE_LABEL}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
