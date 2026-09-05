// `server-only`: this reads the operator's session and holds the path to a
// Stripe credential that can WRITE to a real billing account. The row control
// is a client component; a client component that reaches this must fail the
// build, naming the import chain.
import "server-only";

import { CapabilityError, getCurrentSession } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
import {
  StripeCouponTermsError,
  StripeWriteUnavailableError,
  WRITE_KEY_ENV,
  stripeCatalogWriter,
} from "@/lib/billing/mark8ly/stripe-write";
import type { StripeMode } from "@/lib/billing/stripe-read";
import { auditedOperation } from "@/lib/db/audit-repo";
import {
  readLiveTenantOverrideCoupon,
  recordTenantOverrideCoupon,
  retireTenantOverrideCoupon,
} from "@/lib/db/tenant-pricing-overrides-repo";
// TYPE-ONLY, and that is what keeps it cheap: `promo-codes-repo` is
// `server-only` and reaches `pg`, and this module has no business dragging the
// driver in for a shape. Same import `stripe-write.ts` makes, for the same
// reason. See THE DISCOUNT TYPE below for why it is this type and not a new one.
import type { PromoCodeDiscount } from "@/lib/db/promo-codes-repo";

/**
 * Granting one tenant a pricing override — the console's half (tesserix-home
 * #331, T1).
 *
 * # What this seam does, and the one thing it does not
 *
 * It mints a customer-scoped Stripe Coupon and records that it did. It does
 * NOT attach the coupon to anything: the Stripe customer lives in mark8ly, and
 * applying the coupon (and auditing the grant) is #660's, called by T3. So a
 * successful return from here means "a coupon exists"; it does not mean the
 * tenant is being charged less, and no message below says it does.
 *
 * # THE AUDIT ROW FOR THE GRANT IS NOT WRITTEN HERE
 *
 * `tenant-lifecycle-write.ts` states the estate's position on a federated
 * write, on the console's first one:
 *
 *   > the audit row for this change is written by the PRODUCT, inside its own
 *   > transaction, bound to the state change it describes … a console-side
 *   > audit row would put a second, less trustworthy account of the same event
 *   > in a different database — and the two would disagree the first time a
 *   > write half-succeeded.
 *
 * mark8ly records the grant, from the operator and reason T3 passes through —
 * exactly as lifecycle already passes `reasonCode` and `reason`. #331's body
 * says the console records the decision; that was reversed for the reason
 * above, and the reason is not stored here either (0047's header).
 *
 * What {@link auditedOperation} wraps below is the console's OWN act: it minted
 * a Stripe object. That row describes a thing only this service did, and it is
 * here for the ordering guarantee `auditedOperation` exists to give — no
 * database, no mint; no audit row, no result.
 *
 * # THE DISCOUNT TYPE
 *
 * `CreateCouponSpec.discount` is typed `PromoCodeDiscount`, so a caller of
 * `createCoupon` produces one of those or does not compile. It is reused here
 * unchanged rather than re-declared: `stripe-write.ts`'s own import comment
 * says the type "is already the exact shape a Stripe Coupon's discount takes"
 * and that a parallel declaration would be a second copy of the rules 0046
 * states as CHECK constraints. That argument does not weaken because a second
 * caller arrives — it strengthens.
 *
 * The name is wrong for this caller, and the honest fix is to rename the type
 * to something Stripe-shaped and let both callers import it. That is a change
 * to `stripe-write.ts` and `promo-codes-repo.ts`, which #331 is explicitly told
 * not to make; it is worth doing on its own, and nothing here is widened in the
 * meantime. This module NEVER widens `PromoCodeDiscount` to mean two things —
 * it uses it to mean exactly what it already means, a set of Stripe coupon
 * terms.
 */

/**
 * What the control renders. `couponId` is what T3 hands to mark8ly.
 *
 * Deliberately not carrying the error's cause, a status code, or which internal
 * threw: the control shows `message` and highlights `field`, and adding a
 * discriminant would invite it to branch on how this module is built.
 */
export type PricingOverrideWriteResult =
  | { readonly ok: true; readonly couponId: string }
  | { readonly ok: false; readonly message: string; readonly field?: string };

/** What a grant needs. Every field is required and none is defaulted — see
 *  {@link validate}. */
export interface TenantPricingOverrideInput {
  /** The NAMESPACED tenant id the directory renders (`<source>:<id>`), the
   *  same string `setTenantLifecycle` takes. Stored whole and passed whole; a
   *  bare product id is refused by 0047 rather than silently aimed at a
   *  default product. */
  readonly tenantId: string;
  /** Which Stripe account to mint in. NEVER defaulted, for the reason
   *  `mintCouponAction` takes it as a parameter: a `test` coupon against a
   *  live tenant is a discount that silently does nothing. */
  readonly mode: StripeMode;
  /** The terms. See THE DISCOUNT TYPE in this module's header. */
  readonly discount: PromoCodeDiscount;
  /**
   * The discount's CUSTOMER-VISIBLE name, mandatory.
   *
   * Not the reason, and not derived from the tenant id — see
   * {@link MAX_LABEL_LENGTH} and `couponName`. A short human phrase: it is what
   * the tenant reads beside the discount on their invoice.
   */
  readonly label: string;
  /** Free text, mandatory. Passed to mark8ly by T3, which audits it. Not
   *  stored here — 0047's header. Never sent to Stripe: an operator's private
   *  justification is not something to print on the tenant's invoice. */
  readonly reason: string;
}

const NO_PERMISSION =
  "You don't have permission to grant a tenant a pricing override.";

/**
 * Deliberately does NOT say "nothing happened".
 *
 * `MINT_INCOMPLETE_MESSAGE` in `promo-actions.ts` is the shape and the
 * reasoning is copied rather than re-derived: `auditedOperation` raises before
 * the operation and after it, and a failure between `createCoupon` and
 * `recordTenantOverrideCoupon` leaves a live coupon in a Stripe account this
 * database does not name. So this points at the dashboard instead of inviting a
 * blind retry that would mint a second one.
 */
const MINT_INCOMPLETE =
  "The coupon could not be minted. Check the Stripe dashboard for this tenant before retrying — a coupon may already exist there.";

/**
 * The message a second grant produces, and the reason
 * `recordTenantOverrideCoupon` carries no `ON CONFLICT`.
 *
 * Built from the existing row so it names the coupon, because the state it most
 * often describes is the recoverable one: minted here and never attached by
 * mark8ly. An operator told only "this tenant already has an override" has
 * nothing to look up.
 */
function alreadyGranted(couponId: string, mode: StripeMode): string {
  return (
    `This tenant already has a coupon minted in ${mode} mode (${couponId}). ` +
    "A second one is not minted, because the first is a real object in a real " +
    "Stripe account. If that coupon was never applied, apply it; to change the " +
    "terms, remove the override and grant a new one."
  );
}

/** Which mode has no write credential, in the operator's terms —
 *  `promo-actions.ts`'s `unavailableMessage`, with this surface's closing
 *  sentence: nothing here is saved first, so there is nothing to mint later. */
function unavailableMessage(mode: StripeMode): string {
  return (
    `${mode} mode has no usable Stripe write credential (${WRITE_KEY_ENV[mode]} is unset, ` +
    `or holds a key for the other account), so nothing was minted in ${mode} and ` +
    "this tenant's pricing is unchanged."
  );
}

/** A refusal this seam decided itself, with text written to be shown verbatim —
 *  the same split `MintRefused` draws in `promo-actions.ts`. `field` is what
 *  the control highlights. */
class OverrideRefused extends Error {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "OverrideRefused";
    this.field = field;
  }
}

/**
 * The three durations, spelled as a runtime list so {@link validate} can refuse
 * a fourth.
 *
 * The type already forbids one, and the type is not the whole story here: the
 * value arrives from a client component through a server action, where it is
 * whatever was serialised. #331 requires the duration be chosen explicitly and
 * never defaulted, and "never defaulted" is only enforceable against a value
 * that might not be one of these.
 */
const DURATIONS: readonly PromoCodeDiscount["duration"][] = ["once", "repeating", "forever"];

/**
 * Everything refusable without touching Stripe or the database.
 *
 * BEFORE the mint, all of it, because every failure after `createCoupon` costs
 * a real object in a real account. The rules are the ones #331 states — a
 * mandatory reason, an explicitly chosen duration, months iff `repeating` —
 * and the last of those is `checkedDiscount`'s rule in `stripe-write.ts` too.
 * Restated here rather than left to it: that function throws
 * `StripeCouponTermsError`, whose text is written for a run log and names no
 * field, and an operator who mis-set a duration should be told which control to
 * fix rather than read a sentence about `durationInMonths`.
 */
/**
 * The ceiling this console puts on a customer-visible coupon name.
 *
 * OURS, not Stripe's. Stripe does cap `Coupon.name` and this file does not
 * claim to know the number: nothing in this repo records it, and it has not
 * been exercised against the API from here. The cap below is chosen for the
 * job the string does — one phrase on one invoice line — where 60 characters is
 * already generous, and it is enforced at this boundary so that whatever
 * Stripe's limit turns out to be, a length refusal reaches the operator as a
 * field error on the control they typed into rather than as a thrown request.
 *
 * That distinction is the whole point of checking here. A name Stripe rejects
 * arrives as an exception out of `createCoupon`, which this module cannot
 * distinguish from a lost response, so it falls to {@link MINT_INCOMPLETE} —
 * sending an operator to hunt the dashboard for a coupon that was never
 * created. That is the exact false alarm that message exists to prevent, and it
 * would fire on every grant until someone changed this file.
 */
const MAX_LABEL_LENGTH = 60;

/**
 * What Stripe puts on the tenant's invoice beside the discount.
 *
 * NOT BUILT FROM THE TENANT ID, and the length is the smaller half of why.
 * `Coupon.name` is customer-visible — it renders on the invoice line and in the
 * dashboard — and a namespaced internal id (`mark8ly:<uuid>`) serves neither
 * audience it reaches: the tenant reads an opaque identifier for themselves,
 * and an operator hunting a half-finished grant already has the `co_…` this
 * console recorded and the message that names it. Stripping the prefix and
 * using the bare product id changes nothing about that — it is the same UUID
 * one colon shorter.
 *
 * So the label comes from the caller, who is the only party that knows what the
 * tenant should read, and it is trimmed and length-checked before it is sent.
 */
function couponName(label: string): string {
  return label.trim();
}

function validate(input: TenantPricingOverrideInput): void {
  const label = couponName(input.label);
  if (label === "") {
    throw new OverrideRefused(
      "Give the discount a short name. The tenant sees it on their invoice.",
      "label",
    );
  }
  if (label.length > MAX_LABEL_LENGTH) {
    throw new OverrideRefused(
      `That name is too long for an invoice line — keep it to ${MAX_LABEL_LENGTH} characters or fewer.`,
      "label",
    );
  }

  if (input.reason.trim() === "") {
    throw new OverrideRefused(
      "Say why this tenant is being given a different price. The reason is recorded against the grant.",
      "reason",
    );
  }

  const { discount } = input;
  // A cast past the type reaches here as `undefined` just as easily as `null`,
  // which is why this is a falsiness test and not `=== null` —
  // `checkedDiscount`'s reasoning for the identical guard.
  if (!discount) {
    throw new OverrideRefused(
      "Choose a discount: either a percentage off or a fixed amount off.",
      "discount",
    );
  }
  if (!DURATIONS.includes(discount.duration)) {
    throw new OverrideRefused(
      "Choose how long the discount lasts: once, for a number of months, or forever.",
      "duration",
    );
  }

  const repeating = discount.duration === "repeating";
  const months = discount.durationInMonths !== null && discount.durationInMonths !== undefined;
  if (repeating && !months) {
    throw new OverrideRefused(
      "A discount that repeats needs a number of months.",
      "durationInMonths",
    );
  }
  if (!repeating && months) {
    throw new OverrideRefused(
      `A '${discount.duration}' discount must not carry a month count.`,
      "durationInMonths",
    );
  }
  if (months && !(Number.isInteger(discount.durationInMonths) && (discount.durationInMonths ?? 0) > 0)) {
    throw new OverrideRefused(
      "The month count has to be a whole number above zero.",
      "durationInMonths",
    );
  }
}

/**
 * Deterministic per (tenant, mode, terms, label), and namespaced by this caller
 * the way `mintKey` in `promo-actions.ts` is.
 *
 * DETERMINISTIC IS THE POINT, and it is the same point: a retry after a timeout
 * — where the coupon may already exist in Stripe and the response was lost —
 * replays the key and gets the same coupon back rather than minting a second.
 *
 * THE KEY COVERS EVERY FIELD SENT TO STRIPE — the terms and the label — and
 * nothing else. That is the rule, and both halves of it are load-bearing.
 *
 * The first half is what makes a retry safe. Stripe refuses a repeated key
 * whose parameters differ, so a key that omitted a field it sends alongside
 * would turn a corrected retry — a tenant moved from 10% to 20%, or a fixed
 * typo in the label, inside Stripe's 24-hour window — into a
 * "same key, different parameters" error this module cannot tell from a lost
 * response. It would be reported as {@link MINT_INCOMPLETE}.
 *
 * The second half is why `reason` is NOT in the key, and it is deliberate
 * rather than an omission. The reason never reaches Stripe: it goes to mark8ly,
 * which audits it (0047's header). Adding it would give an operator who
 * reworded their justification a NEW key for a byte-identical Stripe request,
 * and so a SECOND live coupon for a tenant who should have exactly one. Read
 * the rule as "every field of the input" and that is the change you would make;
 * `keeps the reason OUT of the key` is the test that stops you.
 *
 * `promo-actions.ts` keys on (definition, mode) rather than on terms because a
 * definition's terms are fixed once authored, so the definition id already
 * stands for them. That contrast is intact — here the terms arrive with the
 * request and nothing else stands for them, which is why they are spelled out.
 *
 * Spelled field by field rather than serialised: `JSON.stringify` would put key
 * order into the key, so a caller building the object differently would mint a
 * second coupon for terms that are identical.
 */
/**
 * Bumped when the key's SHAPE changes, so a key minted under an older shape can
 * never collide with a newer one inside Stripe's 24-hour window. `v2` because
 * the label joined the key after `v1` was written. Nothing had shipped under
 * `v1`, so this bump buys nothing today — it is done anyway, because "did
 * anything ship yet" is a judgement the next person to change the shape should
 * not have to re-make correctly.
 */
const MINT_KEY_VERSION = "v2";

function mintKey(input: TenantPricingOverrideInput): string {
  const { discount } = input;
  const terms =
    discount.kind === "percent_off"
      ? `percent_off:${discount.percentOff}`
      : `amount_off:${discount.amountOffMinor}:${discount.currency}`;
  const months = discount.durationInMonths ?? "";
  // The label goes LAST, and it is the only free-text field here. Trailing
  // position means an operator's phrase cannot be mistaken for a field
  // separator's worth of some other value, however it is punctuated.
  return `tenant-override:${MINT_KEY_VERSION}:${input.tenantId}:${input.mode}:${terms}:${discount.duration}:${months}:${couponName(input.label)}`;
}

/**
 * Mint one tenant's pricing override and record it.
 *
 * The capability checks run INSIDE `auditedOperation`, so a refusal is written
 * as a `capability.refused` row rather than reaching no log at all —
 * `promo-actions.ts`'s argument, and the reason this seam does not call
 * `recordDeniedAttempt` the way `tenant-lifecycle-write.ts` does. That function
 * exists for a seam with no `auditedOperation` around its check (its own
 * comment says so); calling it here would record the same refusal twice, in the
 * same table.
 *
 * BOTH capabilities, independently. `billing` is the surface — this is a
 * decision about what a customer is charged. `publish-catalog` IN ADDITION
 * because this creates a real, immediately-usable object in a real Stripe
 * account, which is the same class of act as publishing a price and is gated by
 * the same risk verb: `mintCouponAction`'s pairing exactly. Neither is
 * `platform`, the capability the tenant directory itself is gated on — an
 * operator who can reach the row already holds that, and requiring it again
 * would state the route's own precondition as if it were a second control.
 */
export async function grantTenantPricingOverride(
  input: TenantPricingOverrideInput,
): Promise<PricingOverrideWriteResult> {
  try {
    const session = await getCurrentSession();
    const actor = session?.sub ?? "unknown";

    const recorded = await auditedOperation({
      actor,
      target: `${input.tenantId} (${input.mode})`,
      operation: async () => {
        await checkOperatorCapabilityLive(session, "billing");
        await checkOperatorCapabilityLive(session, "publish-catalog");

        validate(input);

        // The pre-check that keeps a duplicate from becoming a real object.
        // 0047's partial unique index is the backstop for the race this read
        // cannot close; reaching Stripe first would create a second live coupon
        // and only THEN fail, orphaning it.
        //
        // It is the CHEAP HALF of the at-most-one rule and not the
        // authoritative one, which is mark8ly's (#660): only mark8ly can see
        // the customer's actual discounts, so only mark8ly can refuse a tenant
        // that acquired one some other way.
        const existing = await readLiveTenantOverrideCoupon(input.tenantId, input.mode);
        if (existing !== null) {
          throw new OverrideRefused(
            alreadyGranted(existing.stripeCouponId, input.mode),
          );
        }

        const created = await stripeCatalogWriter.createCoupon(
          input.mode,
          {
            discount: input.discount,
            // The operator's label, trimmed and already length-checked by
            // `validate`. `stripe-write.ts` cannot derive it — that module does
            // not know what a tenant is — and without one the coupon shows in
            // the dashboard as a bare `co_…`. See `couponName` for why this is
            // NOT the tenant id.
            name: couponName(input.label),
            // `maxRedemptions` is DELIBERATELY NOT FORWARDED, and this surface
            // offers no control for it. Stripe's cap counts redemptions of the
            // Coupon across the account; this coupon is scoped to one customer
            // by being attached to one customer (#660), which is a stronger
            // rule than any number here and one that cannot be off by one. A
            // cap would be a second, weaker statement of the same intent, and
            // the direction it fails in is silent — a repeating discount that
            // stops applying mid-term with nothing in this console to say why.
          },
          mintKey(input),
        );

        return recordTenantOverrideCoupon({
          tenantId: input.tenantId,
          mode: input.mode,
          stripeCouponId: created.id,
          grantedBy: actor,
        });
      },
      describe: (coupon) => ({
        action: "billing.tenant.override.mint",
        summary: { minted: 1, [`mode_${input.mode}`]: 1 },
        target: `${input.tenantId} (${input.mode}) ${coupon.stripeCouponId}`,
      }),
    });

    return { ok: true, couponId: recorded.stripeCouponId };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_PERMISSION };
    }
    if (cause instanceof OverrideRefused) {
      return { ok: false, message: cause.message, field: cause.field };
    }
    if (cause instanceof StripeWriteUnavailableError) {
      // Reached before any request is sent — `createCoupon` asks for the client
      // after it has checked the spec — so this one CAN say nothing was minted.
      return { ok: false, message: unavailableMessage(input.mode) };
    }
    if (cause instanceof StripeCouponTermsError) {
      // `validate` should have caught every case this covers. If it did not,
      // the terms still never reached Stripe: `createCoupon` checks them before
      // it asks for a client. So this is safe to report as nothing-happened,
      // and it is kept as its own branch because a message about a coupon that
      // "may already exist" would be false here and would send an operator
      // looking for one.
      return {
        ok: false,
        message:
          "These discount terms are not something Stripe can mint a coupon from. Check the amount and the duration.",
        field: "discount",
      };
    }
    return { ok: false, message: MINT_INCOMPLETE };
  }
}

/**
 * What the revoke half returns.
 *
 * ITS OWN TYPE, and not {@link PricingOverrideWriteResult}, because the success
 * side of a revoke has two shapes and that one cannot say which happened: the
 * row is retired and the Coupon is gone, or the row is retired and the Coupon
 * is still live in Stripe. Both are successes — the retirement is the state
 * change that unblocks a correction — and the operator-facing sentence for them
 * differs, so the control has to be able to tell them apart.
 *
 * `couponId` is on BOTH success arms deliberately. In the first it is what was
 * deleted; in the second it is the one object left over, and an operator told
 * only "the coupon is still there" has nothing to look up.
 *
 * The grant's result comment warns against a discriminant that would invite the
 * control to branch on how this module is built. `couponDeleted` is not that:
 * it is a fact about the Stripe account, not about which internal threw, and
 * the control branches on it to choose between two true sentences.
 */
export type PricingOverrideRevokeResult =
  | { readonly ok: true; readonly couponId: string; readonly couponDeleted: boolean }
  | { readonly ok: false; readonly message: string; readonly field?: string };

/** What a revoke needs. Every field is required and none is defaulted. */
export interface TenantPricingOverrideRevokeInput {
  /** The NAMESPACED tenant id (`<source>:<id>`), the same string the grant
   *  takes and 0047 stores whole. */
  readonly tenantId: string;
  /** Which Stripe account the override was minted in. NEVER defaulted, for
   *  the grant's reason inverted: retiring the `test` row leaves a `live`
   *  discount in place while reporting a revoke. */
  readonly mode: StripeMode;
  /**
   * Free text, mandatory.
   *
   * SAME DESTINATION AS THE GRANT'S, and today that destination is nowhere:
   * {@link TenantPricingOverrideInput.reason} is passed to mark8ly by a T3 that
   * does not exist yet, and this one belongs to that federated call's detach
   * counterpart (#660), which does not exist either. Taken and validated here,
   * stored by nothing — 0047's header keeps the decision record on mark8ly's
   * side, and giving the revoke a console-side home for its reason would make
   * the two halves asymmetric on the way to contradicting it. Never sent to
   * Stripe: `deleteCoupon` has nowhere to put it and an operator's private
   * justification is not something to hand a billing account.
   */
  readonly reason: string;
}

const NO_PERMISSION_REVOKE =
  "You don't have permission to remove a tenant's pricing override.";

/**
 * Deliberately does NOT say "nothing happened", for {@link MINT_INCOMPLETE}'s
 * reason read in the other direction.
 *
 * This is the message for a failure of the RETIREMENT — the first of the two
 * steps. `retireTenantOverrideCoupon` returning normally is the only signal
 * this module gets that the UPDATE committed; a thrown connection error leaves
 * the row in a state this process cannot read back, so claiming the override is
 * untouched would be a guess. The retry it points at is safe either way: if the
 * retirement did commit, the next attempt finds no live row and refuses with
 * {@link nothingToRevoke}, which names that outcome exactly.
 */
const RETIRE_INCOMPLETE =
  "The override could not be retired. Check this tenant's override before retrying — it may already have been retired, and its coupon may still be live in Stripe.";

/**
 * The refusal for a tenant with nothing live to retire.
 *
 * Two paths reach it and both are legitimate rather than exceptional: the read
 * found no live row, or the read found one and the UPDATE's `removed_at IS
 * NULL` did not, because a concurrent revoke won. The second is the case that
 * makes this a refusal and not an error — `retireTenantOverrideCoupon`'s
 * "NULL IS AN ANSWER, NOT AN ERROR" — and the message covers both without
 * claiming to know which, since from the operator's seat the outcome is the
 * same: this console holds no live override for this tenant in this mode.
 */
function nothingToRevoke(mode: StripeMode): string {
  return (
    `This tenant has no live pricing override in ${mode} mode, so nothing was retired. ` +
    "It may already have been revoked, or the coupon may have been minted in the other mode."
  );
}

function validateRevoke(input: TenantPricingOverrideRevokeInput): void {
  if (input.reason.trim() === "") {
    throw new OverrideRefused(
      "Say why this tenant's pricing override is being removed.",
      "reason",
    );
  }
}

/**
 * Retire this console's record of a tenant's pricing override, and delete the
 * Coupon it minted.
 *
 * # WHAT A SUCCESS HERE MEANS, AND WHAT IT DOES NOT
 *
 * The mirror of this module's header. A success means: this console no longer
 * counts the override, so a corrected one can be granted, and the Coupon can
 * never be redeemed again. It does NOT mean the tenant stopped being charged
 * less. Per Stripe's own reference, quoted in full on `deleteCoupon`, deleting
 * a Coupon "does not affect any customers who have already applied" it;
 * detaching an applied discount is a customer-scoped call only mark8ly can make
 * (#660). Nothing returned from here says otherwise, and the copy built on it
 * must not either.
 *
 * # RETIRE FIRST, DELETE SECOND
 *
 * Both steps can fail, and the order picks which residue an operator is left
 * with. Deleting first and failing before the retirement would leave a live row
 * naming a deleted coupon — 0047's partial unique index still blocking the
 * correction, which is precisely the condition #581 exists to remove. Retiring
 * first and failing before the delete leaves one unattached Coupon in Stripe,
 * named by a retired row and by the result below. That residue is recoverable
 * and nameable; the other is not.
 *
 * The capability checks and BOTH capabilities are the grant's, unchanged and
 * for its stated reason — see `grantTenantPricingOverride`. Checked inside
 * `auditedOperation` so a refusal is a `capability.refused` row.
 */
export async function revokeTenantPricingOverride(
  input: TenantPricingOverrideRevokeInput,
): Promise<PricingOverrideRevokeResult> {
  try {
    const session = await getCurrentSession();
    const actor = session?.sub ?? "unknown";

    const retired = await auditedOperation({
      actor,
      target: `${input.tenantId} (${input.mode})`,
      operation: async () => {
        await checkOperatorCapabilityLive(session, "billing");
        await checkOperatorCapabilityLive(session, "publish-catalog");

        validateRevoke(input);

        // Read before the UPDATE rather than relying on it returning null.
        // The UPDATE alone would answer this correctly — that is what its null
        // means — and the read is kept because the two nulls say different
        // things: no live row at all, versus a live row another revoke retired
        // between these two statements. They share a message today, and this is
        // the branch to change on the day they should not.
        const live = await readLiveTenantOverrideCoupon(input.tenantId, input.mode);
        if (live === null) {
          throw new OverrideRefused(nothingToRevoke(input.mode));
        }

        const row = await retireTenantOverrideCoupon({
          tenantId: input.tenantId,
          mode: input.mode,
          removedBy: actor,
        });
        // Null here means the read above raced a concurrent revoke and lost.
        // Refused rather than treated as done: the winner's retirement is the
        // one on record, and this call has no coupon of its own to delete.
        if (row === null) {
          throw new OverrideRefused(nothingToRevoke(input.mode));
        }
        return row;
      },
      describe: (row) => ({
        // `.retire`, not `.revoke`. What this service did is retire its record
        // and delete its object; removing the discount from the customer is
        // mark8ly's act and mark8ly's row. `.mint` is the sibling, named on the
        // same principle.
        action: "billing.tenant.override.retire",
        summary: { retired: 1, [`mode_${input.mode}`]: 1 },
        target: `${input.tenantId} (${input.mode}) ${row.stripeCouponId}`,
      }),
    });

    // ═══ THE DELETE IS OUTSIDE `auditedOperation`, ON PURPOSE ═══
    //
    // Do not tidy it back inside. `auditedOperation` writes its row only after
    // `operation()` returns, and propagates anything that is not a recognised
    // refusal while writing NOTHING. A `deleteCoupon` failure inside it would
    // therefore throw past the audit write and destroy the record of a
    // retirement that genuinely happened and is genuinely committed — the one
    // fact in this operation that most needs accounting for.
    //
    // Out here the row is already written, so a Stripe failure costs the delete
    // and nothing else.
    try {
      await stripeCatalogWriter.deleteCoupon(input.mode, retired.stripeCouponId);
    } catch {
      // EVERY failure of this call, including `StripeWriteUnavailableError`,
      // which is fatal on the mint path because nothing had happened yet and is
      // not fatal here because the retirement is committed and audited. The
      // cause is deliberately not inspected: from the operator's seat there is
      // one outcome — the Coupon may still be live — and one next step, which
      // the result below carries by naming it.
      //
      // Not a failure result. The correction this revoke exists to unblock is
      // now grantable, and reporting `ok: false` would deny a state change this
      // console made and invite a retry that can only ever refuse.
      return { ok: true, couponId: retired.stripeCouponId, couponDeleted: false };
    }

    // Includes Stripe's already-deleted case, which `deleteCoupon` resolves
    // rather than raising: the goal state holds, so nothing here re-handles it.
    return { ok: true, couponId: retired.stripeCouponId, couponDeleted: true };
  } catch (cause) {
    if (cause instanceof CapabilityError) {
      return { ok: false, message: NO_PERMISSION_REVOKE };
    }
    if (cause instanceof OverrideRefused) {
      return { ok: false, message: cause.message, field: cause.field };
    }
    // No `StripeWriteUnavailableError` branch, and no `StripeCouponTermsError`
    // one: the only Stripe call this function makes is the delete above, whose
    // own catch absorbs everything it can throw. A branch here would be
    // unreachable code claiming to handle a case it never sees.
    return { ok: false, message: RETIRE_INCOMPLETE };
  }
}
