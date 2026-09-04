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
import { splitTenantId, type EstateTenant } from "@/lib/tenants";
import { grantTenantPricingOverrideAction } from "./actions";

/**
 * Giving one tenant a price nobody else gets, from its row in the directory —
 * tesserix-home#331, T2.
 *
 * The write lives in `lib/tenant-pricing-override-write.ts` behind
 * `./actions.ts`; this file is the affordance and the copy, on the surface
 * `tenant-lifecycle-controls.tsx` already established for "one consequential
 * change to one tenant, from its row". Everything exported besides the
 * component is a pure function, so the properties worth defending are testable
 * without driving a dialog.
 *
 * ══ A SUCCESS HERE IS NOT A GRANTED DISCOUNT ══
 *
 * `grantTenantPricingOverride` mints a Stripe Coupon and records that it did.
 * NOTHING ATTACHES IT. The Stripe customer lives in mark8ly, and applying the
 * coupon — and auditing the grant — is mark8ly's (#660), called by T3, which
 * is not built. So `ok: true` means "a coupon exists", and the tenant is still
 * being charged list price.
 *
 * That is why {@link overrideMintedMessage} says so in as many words, and why
 * the outcome renders in a warning callout rather than as the quiet
 * confirmation line the lifecycle control uses. An operator who reads
 * "20% off granted", closes the dialog, and tells the merchant the discount is
 * live is the exact failure #331 exists to prevent, inverted.
 *
 * **T3 MUST REWRITE {@link overrideMintedMessage}.** The sentence about
 * nothing applying it is true today and becomes a stale claim the moment the
 * attach lands. It is one exported, directly tested function so that changing
 * it is a deliberate edit with a failing test attached, rather than a stale
 * paragraph nobody notices.
 *
 * ══ THIS CONTROL IS NOT MOUNTED ON THE DIRECTORY YET ══
 *
 * `tenant-directory.tsx` does not render it, and that is the plan's decision
 * rather than an omission: it rejects "build console-first and let it fail at
 * the attach step" because that makes minted-but-never-applied reachable in
 * production, and this console deploys on merge. Mounting it is T3's last
 * step, alongside rewriting the message above. Until then this file is
 * complete, tested, and unreachable — the state the plan asked for.
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
 * have arrived and minted before the response was lost. That is the same
 * ambiguity `MINT_INCOMPLETE` in the seam describes, and the answer is the
 * same one — send the operator to look rather than invite a blind retry that
 * mints a second real coupon.
 */
export const OVERRIDE_NOT_CONFIRMED =
  "That request could not be confirmed. Check the Stripe dashboard for this tenant before trying again — a coupon may already have been minted.";

/**
 * What the operator is told after a mint the seam accepted.
 *
 * THREE FACTS, IN THIS ORDER, and none of them is "granted": what now exists,
 * that it is not in effect, and what is still owed. The words "granted",
 * "applied", "active" and "discounted" are absent on purpose — a test asserts
 * their absence rather than asserting the sentence, because the failure to
 * guard against is a future rewording that sounds friendlier and means
 * something untrue.
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
 *
 * THE THIRD SENTENCE IS T3's TO DELETE. See this module's header.
 */
export function overrideMintedMessage(
  tenantName: string,
  couponId: string,
  mode: StripeMode,
): string {
  return (
    `Coupon ${couponId} was minted in ${mode} mode and recorded against ${tenantName}. ` +
    `It is not yet in effect — ${tenantName} is still being charged list price. ` +
    "Attaching it to their subscription is a separate step this console cannot do yet."
  );
}

/**
 * Why the action is unavailable for a tenant belonging to a product this
 * console does not mint for.
 *
 * The coupon would be created in the Stripe account this console writes to —
 * the one mark8ly's catalog lives in ({@link CATALOG_SOURCES}) — for a tenant
 * that is not a customer in it, and the endpoint that would attach it is
 * mark8ly's (#660). So it is a real object in a real account that nothing
 * could ever use, and the only trace would be a row in `0047` pointing at it.
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

/** The dialog's plain statement of what confirming does — and, in its last
 *  sentence, of what it does not do. Consequential enough to spell out rather
 *  than leave to the button's verb, the same judgement `consequence` makes in
 *  the lifecycle control. */
function consequence(tenantName: string, mode: StripeMode | ""): string {
  const where = mode === "" ? "a Stripe account" : `the ${mode} Stripe account`;
  return (
    `A coupon with these terms will be created in ${where} and recorded against ${tenantName}. ` +
    "It is not applied to anything by this step, and this console cannot yet apply it."
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

/** The `field` names this dialog has an input for. Whether that input is on
 *  screen is a separate question — see {@link overrideFieldPlacement}. */
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
}

const ACTION_LABEL = "Pricing override";

export function TenantPricingOverrideAction({
  tenant,
  onSubmit = grantTenantPricingOverrideAction,
}: TenantPricingOverrideActionProps) {
  const router = useRouter();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<OverrideForm>(EMPTY_OVERRIDE_FORM);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          aria-describedby={`${fieldId}-unavailable`}
        >
          {ACTION_LABEL}
        </Button>
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
      setNotice(overrideMintedMessage(tenant.name, result.couponId, form.mode));
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

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        // Every row renders a control with the same visible text, so a query by
        // that text alone cannot address a particular tenant's — the same fix
        // the lifecycle control and `ToolsManager` apply to theirs.
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
    </div>
  );
}
