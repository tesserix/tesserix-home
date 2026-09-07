// Load-bearing, exactly as `catalog-surface.tsx`'s is: everything below
// reaches `@tesserix/web`, whose barrel is `"use client"`, and its exports are
// `undefined` in a server component (#539). It is also what lets this file
// hold form state and call server actions.
// `lib/server-component-web-import.guard.test.ts` holds the line.
"use client";

import { useRef, useState, useTransition } from "react";
import {
  Badge,
  Button,
  Callout,
  CalloutDescription,
  CalloutTitle,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
// Type-only, the discipline every client module on this surface keeps:
// `promo-codes-repo.ts` carries `import "server-only"`, so a VALUE import
// would drag `pg` into this bundle. The rows arrive as plain props.
import type { PromoCodeDiscount, PromoCodePlan } from "@/lib/db/promo-codes-repo";
import type { StripeMode } from "@/lib/billing/stripe-read";
import {
  createPromoCodeAction,
  deactivatePromoCodeAction,
  mintCouponAction,
  updatePromoCodeAction,
} from "./promo-actions";

/**
 * The promo-code authoring surface (tesserix-home#521, T4) — the console's
 * half of a code a merchant types during mark8ly onboarding.
 *
 * # Three things this surface deliberately does NOT offer
 *
 * 1. **An edit control for the discount terms.** A Stripe Coupon's
 *    `percent_off`, `amount_off`, `currency` and `duration` are immutable
 *    after creation, so an "edit terms" control could not work under a minted
 *    coupon: the row would describe one discount and Stripe would apply
 *    another, invisibly, with both sides still working. `UpdatePromoCodeInput`
 *    excludes them for that reason and this surface does not smuggle them back
 *    in. What it offers instead is {@link ReplaceButton} — "Replace this
 *    code", which loads the same terms into the author form for a NEW code, so
 *    "change the discount" is a signposted path rather than a control that
 *    silently fails.
 *
 * 2. **A redemption count.** mark8ly owns that ledger — redemption is
 *    transactional and tenant-scoped and the exact cap can only be counted
 *    where redemptions happen — and as of this writing mark8ly serves no
 *    endpoint for it (verified: nothing in `mark8ly/` reads a promo catalog
 *    at all yet). So the column says {@link REDEMPTIONS_UNREPORTED} and never
 *    a `0`: a zero would be a claim — "nobody has redeemed this" — that
 *    nothing here is in a position to make.
 *
 * 3. **A second mint in a mode that already has one.** See
 *    `recordStripeCoupon`: the first coupon is a real, still-redeemable object
 *    in a real Stripe account, and a second row would orphan it. The button is
 *    replaced by the minted id once a mode is minted.
 */

/* ------------------------------------------------------------------------ *
 * Decision 3 — the warning this whole feature was planned around
 * ------------------------------------------------------------------------ */

/**
 * A `repeating` discount on a code that also extends the trial.
 *
 * Stripe starts a `repeating` coupon's clock at the FIRST CHARGE, not at
 * signup — and a trial extension is precisely a thing that moves the first
 * charge later. So "3 months half price" on a code that also adds 30 trial
 * days does not discount the first three months of anything an operator was
 * thinking about; it discounts three months that begin a month later than
 * they otherwise would.
 *
 * ALLOWED, NOT REFUSED (plan decision 3): it is sometimes exactly what is
 * wanted, and a surface that refused it would send an operator to author two
 * codes that cannot be typed together.
 *
 * The arithmetic is stated with the numbers the operator just typed, and
 * DELIBERATELY WITHOUT A BASE TRIAL LENGTH. mark8ly owns the base trial;
 * nothing in this console names it, and a warning that said "so it begins on
 * day 120" would be quoting a constant this codebase does not have. The delay
 * — which is the operator's own number — is the part that is true here.
 *
 * Returns `null` when the combination is absent, so a caller renders nothing
 * rather than an empty callout.
 */
export function describeTrialRepeatingConflict(
  trialExtensionDays: number | null,
  discount: PromoCodeDiscount | null,
): string | null {
  if (discount === null || discount.duration !== "repeating") return null;
  if (trialExtensionDays === null || trialExtensionDays <= 0) return null;

  const months = discount.durationInMonths;
  const span = months === null ? "The repeating discount" : `The ${months} discounted months`;
  return (
    `This code adds ${trialExtensionDays} trial days AND repeats. ` +
    `Stripe starts a repeating discount at the first charge, and the extra trial days move that charge ${trialExtensionDays} days later — ` +
    `so ${span.toLowerCase()} begin ${trialExtensionDays} days after the trial would otherwise have ended, not at signup. ` +
    `That is allowed and is sometimes what is wanted; it is not what "${months === null ? "a repeating discount" : `${months} months off`}" reads like.`
  );
}

/** Said in place of a count, never instead of one. See this module's header. */
export const REDEMPTIONS_UNREPORTED = "Not reported by mark8ly yet";

/* ------------------------------------------------------------------------ *
 * Campaign scope (tesserix-home#593)
 * ------------------------------------------------------------------------ */

/**
 * The three plans, with the label each gets on screen.
 *
 * A `Record` OVER THE UNION rather than a hand-written array, and that is the
 * whole point of the shape: `PromoCodePlan` is 0051's closed vocabulary, so a
 * fourth plan added to it makes this object incomplete and fails the build
 * here. An array of three literals would have compiled happily while silently
 * offering an operator two thirds of the plans.
 *
 * NOT `PROMO_CODE_PLANS` ITSELF, which is the same list one file away. That
 * constant lives in `promo-codes-repo.ts`, which carries `import "server-only"`
 * — a VALUE import of it from this client module would drag `pg` into the
 * browser bundle, which is the trap the type-only import above exists to avoid
 * (#539). The type is what crosses; the labels are display copy and belong on
 * the display side anyway.
 */
const PLAN_LABELS: Record<PromoCodePlan, string> = {
  starter: "Starter",
  studio: "Studio",
  pro: "Pro",
};

/** Insertion order, which is the order 0051, mark8ly's catalog and the price
 *  ladder all use — cheapest first. */
const PLANS = Object.keys(PLAN_LABELS) as readonly PromoCodePlan[];

/**
 * What the scope an operator has selected actually MEANS, in a sentence.
 *
 * Written for the empty selection first, because that is the default, the
 * common case and the one an empty control describes worst: three unticked
 * boxes look like a decision not yet made, and this is what says out loud that
 * they are a decision — every plan, both billing periods. Decision 3 of #593
 * is that unscoped has exactly one spelling; this is that spelling in prose.
 *
 * Takes `readonly PromoCodePlan[] | null` so the row's stored value (`null` for
 * unscoped) and the form's working value (`[]` for the same thing) both go
 * through one function. The two spellings exist only inside this component —
 * see `promo-actions.ts` for where `[]` becomes the `null` that is stored.
 */
export function describeScope(
  allowedPlans: readonly PromoCodePlan[] | null,
  annualOnly: boolean,
): string {
  const plans =
    allowedPlans === null || allowedPlans.length === 0
      ? "This code applies to every plan"
      : `This code applies to ${allowedPlans.map((plan) => PLAN_LABELS[plan]).join(", ")} only`;
  const period = annualOnly
    ? "only to annual billing"
    : "to both monthly and annual billing";
  return `${plans}, and ${period}.`;
}

/** The same fact in a table cell's worth of words. */
export function summariseScope(
  allowedPlans: readonly PromoCodePlan[] | null,
  annualOnly: boolean,
): string {
  const plans =
    allowedPlans === null || allowedPlans.length === 0
      ? "Every plan"
      : allowedPlans.map((plan) => PLAN_LABELS[plan]).join(", ");
  return `${plans} · ${annualOnly ? "annual only" : "any period"}`;
}

/**
 * There is no "monthly only", and the absence has to be stated.
 *
 * A lone "Annual billing only" box reads like one half of a pair, so an
 * operator can reasonably infer that unticking it means monthly — it does not;
 * it means both. The reason there is no counterpart is mark8ly's: its redeemer
 * has an `AnnualOnly` branch and no monthly one and no reject reason for one,
 * so a monthly-only control would author a restriction nothing applies. 0051's
 * header carries the long form; this is the sentence an operator gets.
 */
const NO_MONTHLY_ONLY_NOTE =
  "There is no monthly-only option: mark8ly can enforce annual-only and has no monthly counterpart, so a monthly-only restriction would render as a rule and never be applied. Leaving this unticked means both periods.";

/** Set equality over a closed three-element vocabulary — order-insensitive,
 *  because `{pro,studio}` and `{studio,pro}` are the same scope and 0051
 *  refuses duplicates, so counting plus membership is sufficient. */
function samePlans(
  a: readonly PromoCodePlan[] | null,
  b: readonly PromoCodePlan[] | null,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((plan) => right.includes(plan));
}

/**
 * THE CROSS-REPO LIMIT, met where an operator can act on it.
 *
 * mark8ly's re-sync overwrites a column only if it is in `upsertColumns`
 * (`services/marketplace-api/internal/billing/consolepromo/store.go`), and
 * `allowed_plans` and `annual_only` are deliberately absent from that list —
 * they sit there beside the two abuse controls the console cannot author,
 * under a comment calling all four "mark8ly policy the console cannot express".
 * That was true when it was written. It stops being true here, and mark8ly#795
 * is the change that moves these two into the list.
 *
 * Until it lands, a re-scope of a code MARK8LY HAS ALREADY INGESTED reaches the
 * published contract and stops: the row keeps the scope it was first ingested
 * with, and the console shows a narrowed code that still redeems wide. Nothing
 * in this repo can observe that — there is no read of mark8ly's promo rows from
 * here — and a newly authored code is unaffected, because an insert has no
 * existing row to preserve anything from.
 *
 * WARNED AND NOT REFUSED, which is #521 decision 3's shape one object over: the
 * edit is not wrong and it is not lost. It is stored, it is served, and the
 * first sync after mark8ly#795 applies it. What the operator cannot have is the
 * TIMING, so the warning says that and names the path that does take effect
 * today — a replacement code inserts, and deactivating this one withdraws it
 * from the served catalog, which mark8ly honours through `ExpireCodesNotIn`.
 *
 * A flag or a version negotiation was considered and rejected: this is a
 * cross-repo ordering condition with a known end, not a capability the two
 * sides will keep differing on, and either mechanism would outlive it.
 *
 * Returns `null` when the scope is unchanged, so an amendment that only moves
 * the validity window renders no callout.
 */
export function describeScopeSyncGap(
  current: { allowedPlans: readonly PromoCodePlan[] | null; annualOnly: boolean },
  next: { allowedPlans: readonly PromoCodePlan[] | null; annualOnly: boolean },
): string | null {
  if (samePlans(current.allowedPlans, next.allowedPlans) && current.annualOnly === next.annualOnly) {
    return null;
  }
  return (
    "Saving this stores the new scope here and publishes it, but mark8ly keeps the scope it first ingested for a code it already has — " +
    "so this code can go on redeeming at its old scope, and nothing in this console can tell whether mark8ly has ingested it. " +
    "The change is not lost: the first sync after mark8ly starts reading these two fields will apply it. " +
    "If the new scope has to take effect now, author a replacement code with it and deactivate this one — a new code is ingested as a new row, and a deactivated code is withdrawn from the published catalog, which mark8ly does honour."
  );
}

/* ------------------------------------------------------------------------ *
 * Props
 * ------------------------------------------------------------------------ */

export interface PromoCodeCouponView {
  readonly mode: StripeMode;
  readonly stripeCouponId: string;
}

/** One definition, flattened for rendering — `PromoCodeRow` plus what was
 *  minted for it, which lives in a second table. */
export interface PromoCodeView {
  readonly id: string;
  readonly code: string;
  readonly trialExtensionDays: number | null;
  readonly discount: PromoCodeDiscount | null;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly maxRedemptions: number | null;
  /** `null` is unscoped — every plan — and is the ONLY spelling of it that
   *  reaches this component from the database. See {@link describeScope}. */
  readonly allowedPlans: readonly PromoCodePlan[] | null;
  readonly annualOnly: boolean;
  readonly isActive: boolean;
  readonly coupons: readonly PromoCodeCouponView[];
}

export interface PromoCodesPanelProps {
  /** The surface's Stripe mode — which account a mint would write to. */
  readonly mode: StripeMode;
  readonly codes: readonly PromoCodeView[];
  readonly codesState: SurfaceState;
  /**
   * `billing`. Gates authoring, amending and retiring a DEFINITION — none of
   * which Stripe ever sees.
   *
   * Read-only here: every action re-checks the identical capability itself
   * (`promo-actions.ts`), and this only decides which controls are offered.
   */
  readonly canAuthor: boolean;
  /** `publish-catalog`, checked independently of {@link canAuthor} and never
   *  nested inside it — the same shape `page.tsx` uses for `canDraft` /
   *  `canPublish`, because the server checks the two independently too. */
  readonly canMint: boolean;
}

/* ------------------------------------------------------------------------ *
 * Small rendering helpers
 * ------------------------------------------------------------------------ */

function formatDiscount(discount: PromoCodeDiscount | null): string {
  if (discount === null) return "No discount";
  const amount =
    discount.kind === "percent_off"
      ? `${discount.percentOff}% off`
      : `${discount.amountOffMinor} ${discount.currency.toUpperCase()} (minor units) off`;
  const duration =
    discount.duration === "repeating"
      ? `repeating for ${discount.durationInMonths ?? "?"} months`
      : discount.duration;
  return `${amount}, ${duration}`;
}

function formatEffects(row: PromoCodeView): string {
  const trial =
    row.trialExtensionDays === null ? null : `+${row.trialExtensionDays} trial days`;
  const discount = row.discount === null ? null : formatDiscount(row.discount);
  return [trial, discount].filter((part) => part !== null).join(" · ");
}

/** `2026-09-04T00:00:00.000Z` -> `2026-09-04`, the value an `input[type=date]`
 *  takes. Not a locale format: this is a form value, not display copy. */
function toDateInput(iso: string | null): string {
  return iso === null ? "" : iso.slice(0, 10);
}

/**
 * A number field's value, or `null` for an empty one — with `undefined` for
 * text that is not a number at all.
 *
 * THREE OUTCOMES, not two. `null` (left empty) and "not a number" are
 * different operator intentions, and collapsing them would send `null` for a
 * typo and silently clear a cap the operator meant to set. 0046's rules
 * (positivity, ranges) are NOT re-checked here — see `promo-actions.ts`'s
 * header on why the database keeps them.
 */
function optionalNumber(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

const NUMBER_MESSAGE = "Enter a number, or leave the field empty.";

/* ------------------------------------------------------------------------ *
 * The author form
 * ------------------------------------------------------------------------ */

type DiscountKind = "none" | "percent_off" | "amount_off";

interface AuthorFormState {
  code: string;
  trialDays: string;
  kind: DiscountKind;
  percentOff: string;
  amountOff: string;
  currency: string;
  duration: PromoCodeDiscount["duration"];
  months: string;
  validFrom: string;
  validUntil: string;
  maxRedemptions: string;
  /**
   * The ticked plans. `[]` HERE MEANS UNSCOPED, and it is the only place that
   * spelling is allowed to exist: a checkbox group has no third state, so the
   * form has to hold "nothing ticked" as an empty list. `promo-actions.ts`
   * turns it into the `null` the database stores, which is why this component
   * never sends the empty array on.
   */
  allowedPlans: readonly PromoCodePlan[];
  annualOnly: boolean;
}

const EMPTY_FORM: AuthorFormState = {
  code: "",
  trialDays: "",
  kind: "none",
  percentOff: "",
  amountOff: "",
  currency: "usd",
  duration: "once",
  months: "",
  validFrom: "",
  validUntil: "",
  maxRedemptions: "",
  // Unscoped by default, which is what an operator who did not think about
  // scoping meant — and what the sentence under the controls says out loud.
  allowedPlans: [],
  annualOnly: false,
};

/** The form's discount, or `undefined` when a numeric field is unparseable —
 *  the one thing this component refuses locally, because it is a parse
 *  failure rather than one of 0046's rules. */
function formDiscount(form: AuthorFormState): PromoCodeDiscount | null | undefined {
  if (form.kind === "none") return null;

  const months = optionalNumber(form.months);
  if (months === undefined) return undefined;
  const shared = { duration: form.duration, durationInMonths: months } as const;

  if (form.kind === "percent_off") {
    const percentOff = optionalNumber(form.percentOff);
    if (percentOff === undefined || percentOff === null) return undefined;
    return { ...shared, kind: "percent_off", percentOff };
  }

  const amountOffMinor = optionalNumber(form.amountOff);
  if (amountOffMinor === undefined || amountOffMinor === null) return undefined;
  return { ...shared, kind: "amount_off", amountOffMinor, currency: form.currency.trim() };
}

interface ScopeFieldsProps {
  /** Ids have to be unique across the page — the author form renders one of
   *  these and every amendable row renders another. */
  readonly idPrefix: string;
  readonly allowedPlans: readonly PromoCodePlan[];
  readonly annualOnly: boolean;
  readonly onChange: (next: {
    allowedPlans: readonly PromoCodePlan[];
    annualOnly: boolean;
  }) => void;
}

/**
 * The two scoping controls, shared by the author form and every row's
 * amendment — one component because they are one concept, and because a second
 * copy is where the two would drift into describing the same scope differently.
 *
 * A `fieldset`/`legend` and not three loose checkboxes with a heading: the
 * plans are one multi-valued answer, and the grouping is what tells assistive
 * tech that "Studio" is an option within "Plans" rather than a question of its
 * own.
 *
 * The design system's `Checkbox` (a Radix one, a `<button role="checkbox">`)
 * rather than `<input type="checkbox">`, on the same grounds the Discount
 * picker gives for `Select`: a native control renders unthemed. It is a
 * `<button>`, so it is labelable and `<Label htmlFor>` is a real association —
 * no `aria-label`, which would override the visible label rather than add to
 * it.
 */
function ScopeFields({ idPrefix, allowedPlans, annualOnly, onChange }: ScopeFieldsProps) {
  const togglePlan = (plan: PromoCodePlan, ticked: boolean) =>
    onChange({
      // Rebuilt from `PLANS` rather than appended to, so the stored order is
      // always the ladder's and never the order the operator happened to click
      // in. `{studio,pro}` and `{pro,studio}` are the same scope, and one
      // spelling of it keeps every rendering of it identical.
      allowedPlans: PLANS.filter((candidate) =>
        candidate === plan ? ticked : allowedPlans.includes(candidate),
      ),
      annualOnly,
    });

  return (
    <fieldset className="flex flex-col gap-2 border-none p-0">
      <legend className="text-sm font-medium">Who this code is for</legend>

      <div className="flex flex-wrap items-center gap-4">
        {PLANS.map((plan) => (
          <div key={plan} className="flex items-center gap-2">
            <Checkbox
              id={`${idPrefix}-plan-${plan}`}
              checked={allowedPlans.includes(plan)}
              onCheckedChange={(checked) => togglePlan(plan, checked === true)}
            />
            <Label htmlFor={`${idPrefix}-plan-${plan}`}>{PLAN_LABELS[plan]}</Label>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id={`${idPrefix}-annual-only`}
          checked={annualOnly}
          onCheckedChange={(checked) => onChange({ allowedPlans, annualOnly: checked === true })}
        />
        <Label htmlFor={`${idPrefix}-annual-only`}>Annual billing only</Label>
      </div>

      {/* The default said in words. An empty control is not a statement, and
          "no plans ticked" is the most consequential answer on this form. */}
      <p className="text-xs text-muted-foreground">{describeScope(allowedPlans, annualOnly)}</p>
      <p className="text-xs text-muted-foreground">{NO_MONTHLY_ONLY_NOTE}</p>
    </fieldset>
  );
}

interface AuthorFormProps {
  readonly form: AuthorFormState;
  readonly setForm: (next: AuthorFormState) => void;
  readonly replacing: string | null;
  readonly codeRef: React.RefObject<HTMLInputElement | null>;
  readonly onCreated: () => void;
}

function AuthorForm({ form, setForm, replacing, codeRef, onCreated }: AuthorFormProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const field = <K extends keyof AuthorFormState>(key: K, value: AuthorFormState[K]) =>
    setForm({ ...form, [key]: value });

  const discount = formDiscount(form);
  const trialDays = optionalNumber(form.trialDays);
  // Computed from the form as it is typed, so the operator meets decision 3
  // AT AUTHORING TIME — which is the whole point of it being a warning rather
  // than a note in a runbook.
  const conflict =
    discount === undefined || trialDays === undefined
      ? null
      : describeTrialRepeatingConflict(trialDays, discount);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const maxRedemptions = optionalNumber(form.maxRedemptions);
    if (discount === undefined || trialDays === undefined || maxRedemptions === undefined) {
      setMessage(NUMBER_MESSAGE);
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const result = await createPromoCodeAction({
        code: form.code,
        trialExtensionDays: trialDays,
        discount,
        validFrom: form.validFrom.length > 0 ? form.validFrom : null,
        validUntil: form.validUntil.length > 0 ? form.validUntil : null,
        maxRedemptions,
        // Sent as ticked — including the empty list. The action owns the
        // translation to `null`, because it is the layer that knows this form's
        // empty selection means "unscoped"; see its `authoredScope`.
        allowedPlans: form.allowedPlans,
        annualOnly: form.annualOnly,
      });
      if (result.ok) {
        setForm(EMPTY_FORM);
        onCreated();
        return;
      }
      setMessage(result.message);
    });
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} aria-label="Author a promo code">
      <h3 className="text-sm font-semibold">New promo code</h3>

      {replacing === null ? null : (
        <Callout variant="info">
          <CalloutTitle>{`Replacing ${replacing}`}</CalloutTitle>
          <CalloutDescription>
            {`${replacing}'s discount terms are copied below. A Stripe coupon's terms cannot be changed once it exists, so a different discount is a different code: give this one a new code, then deactivate ${replacing}.`}
          </CalloutDescription>
        </Callout>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="promo-code">Code</Label>
          <Input
            id="promo-code"
            ref={codeRef}
            value={form.code}
            onChange={(event) => field("code", event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Stored upper-case with no spaces, so a merchant can type it in any case.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="promo-trial-days">Trial extension (days)</Label>
          <Input
            id="promo-trial-days"
            value={form.trialDays}
            onChange={(event) => field("trialDays", event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Leave empty for a discount-only code. Applied by mark8ly, not by Stripe.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="promo-discount-kind">Discount</Label>
          {/* The design system's `Select`, not a native `<select>`: a native
           *  one renders an OS-drawn popup that ignores the console's theme,
           *  which is what was rejected on the live page (#592). The same
           *  reasoning `create-secret-form.tsx` records.
           *
           *  `id` on the trigger, and NO `aria-label`: the trigger is a
           *  `<button>`, which is labelable, so `<Label htmlFor>` above is a
           *  real association. An `aria-label` would OVERRIDE that visible
           *  label rather than add to it.
           *
           *  "none" stays a sentinel rather than becoming `value=""` — Radix
           *  forbids an empty `SelectItem` value, and this option is a real
           *  choice (a trial-extension-only code), not an absent one. */}
          <Select
            value={form.kind}
            onValueChange={(next) => field("kind", next as DiscountKind)}
          >
            <SelectTrigger id="promo-discount-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No discount (trial extension only)</SelectItem>
              <SelectItem value="percent_off">Percent off</SelectItem>
              <SelectItem value="amount_off">Amount off</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {form.kind === "percent_off" ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="promo-percent-off">Percent off</Label>
            <Input
              id="promo-percent-off"
              value={form.percentOff}
              onChange={(event) => field("percentOff", event.target.value)}
            />
          </div>
        ) : null}

        {form.kind === "amount_off" ? (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="promo-amount-off">Amount off (minor units)</Label>
              <Input
                id="promo-amount-off"
                value={form.amountOff}
                onChange={(event) => field("amountOff", event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="promo-currency">Currency</Label>
              <Input
                id="promo-currency"
                value={form.currency}
                onChange={(event) => field("currency", event.target.value)}
              />
            </div>
          </>
        ) : null}

        {form.kind === "none" ? null : (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="promo-duration">Duration</Label>
              {/* Design system `Select` — see the Discount picker above. */}
              <Select
                value={form.duration}
                onValueChange={(next) =>
                  field("duration", next as PromoCodeDiscount["duration"])
                }
              >
                <SelectTrigger id="promo-duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="once">once</SelectItem>
                  <SelectItem value="repeating">repeating</SelectItem>
                  <SelectItem value="forever">forever</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.duration === "repeating" ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="promo-months">Months</Label>
                <Input
                  id="promo-months"
                  value={form.months}
                  onChange={(event) => field("months", event.target.value)}
                />
              </div>
            ) : null}
          </>
        )}

        <div className="flex flex-col gap-1">
          <Label htmlFor="promo-valid-from">Valid from</Label>
          <Input
            id="promo-valid-from"
            type="date"
            value={form.validFrom}
            onChange={(event) => field("validFrom", event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="promo-valid-until">Valid until</Label>
          <Input
            id="promo-valid-until"
            type="date"
            value={form.validUntil}
            onChange={(event) => field("validUntil", event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="promo-max-redemptions">Redemption cap</Label>
          <Input
            id="promo-max-redemptions"
            value={form.maxRedemptions}
            onChange={(event) => field("maxRedemptions", event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Counted by mark8ly, the only redeemer. Leave empty for uncapped.
          </p>
        </div>
      </div>

      {/* No sync warning here, unlike the amendment below: a new code is
          INSERTED into mark8ly rather than merged into an existing row, so its
          scope arrives intact. See {@link describeScopeSyncGap}. */}
      <ScopeFields
        idPrefix="promo-new"
        allowedPlans={form.allowedPlans}
        annualOnly={form.annualOnly}
        onChange={(scope) => setForm({ ...form, ...scope })}
      />

      {conflict === null ? null : (
        <Callout variant="warning">
          <CalloutTitle>A repeating discount starts after the extended trial</CalloutTitle>
          <CalloutDescription>{conflict}</CalloutDescription>
        </Callout>
      )}

      {message === null ? null : (
        <Callout variant="destructive">
          <CalloutDescription>{message}</CalloutDescription>
        </Callout>
      )}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Create promo code"}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------ *
 * One row's controls
 * ------------------------------------------------------------------------ */

interface RowControlsProps {
  readonly row: PromoCodeView;
  readonly mode: StripeMode;
  readonly canAuthor: boolean;
  readonly canMint: boolean;
  readonly onReplace: (row: PromoCodeView) => void;
}

function RowControls({ row, mode, canAuthor, canMint, onReplace }: RowControlsProps) {
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [amendment, setAmendment] = useState({
    trialDays: row.trialExtensionDays === null ? "" : String(row.trialExtensionDays),
    validFrom: toDateInput(row.validFrom),
    validUntil: toDateInput(row.validUntil),
    maxRedemptions: row.maxRedemptions === null ? "" : String(row.maxRedemptions),
    // `null` (unscoped, as stored) flattens to the empty selection the
    // checkbox group can hold. `ScopeFields`' doc has the two spellings.
    allowedPlans: row.allowedPlans ?? [],
    annualOnly: row.annualOnly,
  });
  const [pending, startTransition] = useTransition();

  // Computed as the boxes are ticked, so the operator meets the cross-repo
  // limit BEFORE saving rather than in a runbook — the same reasoning the
  // author form's trial/repeating warning is built on.
  const scopeGap = describeScopeSyncGap(row, amendment);

  const mintedHere = row.coupons.find((coupon) => coupon.mode === mode) ?? null;

  function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setMessage(result.message ?? "That did not work.");
      else setEditing(false);
    });
  }

  function saveAmendment(event: React.FormEvent) {
    event.preventDefault();
    const trialDays = optionalNumber(amendment.trialDays);
    const maxRedemptions = optionalNumber(amendment.maxRedemptions);
    if (trialDays === undefined || maxRedemptions === undefined) {
      setMessage(NUMBER_MESSAGE);
      return;
    }
    run(() =>
      updatePromoCodeAction(row.id, row.code, {
        trialExtensionDays: trialDays,
        validFrom: amendment.validFrom,
        validUntil: amendment.validUntil.length > 0 ? amendment.validUntil : null,
        maxRedemptions,
        // Unlike the discount terms, scope IS amendable: Stripe holds no copy
        // of it to diverge from — a Coupon knows about money and nothing about
        // plans. What it does not do is reach mark8ly today; see `scopeGap`.
        allowedPlans: amendment.allowedPlans,
        annualOnly: amendment.annualOnly,
      }),
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {canAuthor ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditing((open) => !open)}
          >
            {editing ? "Cancel" : "Amend"}
          </Button>
        ) : null}

        {canAuthor && row.isActive ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => run(() => deactivatePromoCodeAction(row.id, row.code))}
          >
            Deactivate
          </Button>
        ) : null}

        {/* The path out of the immutable-terms dead end, offered on every row
            that HAS terms — see this module's header. */}
        {canAuthor && row.discount !== null ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onReplace(row)}>
            Replace this code
          </Button>
        ) : null}

        {canMint && row.discount !== null && mintedHere === null ? (
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => run(() => mintCouponAction(row.code, mode))}
          >
            {`Mint coupon in ${mode}`}
          </Button>
        ) : null}
      </div>

      {editing ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={saveAmendment}
          aria-label={`Amend ${row.code}`}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={`amend-trial-${row.id}`}>Trial days</Label>
            <Input
              id={`amend-trial-${row.id}`}
              value={amendment.trialDays}
              onChange={(event) =>
                setAmendment({ ...amendment, trialDays: event.target.value })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`amend-from-${row.id}`}>Valid from</Label>
            <Input
              id={`amend-from-${row.id}`}
              type="date"
              value={amendment.validFrom}
              onChange={(event) =>
                setAmendment({ ...amendment, validFrom: event.target.value })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`amend-until-${row.id}`}>Valid until</Label>
            <Input
              id={`amend-until-${row.id}`}
              type="date"
              value={amendment.validUntil}
              onChange={(event) =>
                setAmendment({ ...amendment, validUntil: event.target.value })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`amend-cap-${row.id}`}>Redemption cap</Label>
            <Input
              id={`amend-cap-${row.id}`}
              value={amendment.maxRedemptions}
              onChange={(event) =>
                setAmendment({ ...amendment, maxRedemptions: event.target.value })
              }
            />
          </div>
          <div className="w-full">
            <ScopeFields
              idPrefix={`amend-scope-${row.id}`}
              allowedPlans={amendment.allowedPlans}
              annualOnly={amendment.annualOnly}
              onChange={(scope) => setAmendment({ ...amendment, ...scope })}
            />
          </div>

          {scopeGap === null ? null : (
            <div className="w-full">
              <Callout variant="warning">
                <CalloutTitle>A scope change may not reach mark8ly yet</CalloutTitle>
                <CalloutDescription>{scopeGap}</CalloutDescription>
              </Callout>
            </div>
          )}

          <Button type="submit" size="sm" disabled={pending}>
            Save
          </Button>
          {/* Not a disabled input labelled "discount": a control that looks
              editable and is not teaches an operator to distrust the form.
              The sentence, and the button beside it, say what to do instead. */}
          <p className="w-full text-xs text-muted-foreground">
            {`Discount terms cannot be amended — Stripe fixes a coupon's terms when it is created. Use "Replace this code" for a different discount.`}
          </p>
        </form>
      ) : null}

      {message === null ? null : (
        <Callout variant="destructive">
          <CalloutDescription>{message}</CalloutDescription>
        </Callout>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------------ */

export function PromoCodesPanel({
  mode,
  codes,
  codesState,
  canAuthor,
  canMint,
}: PromoCodesPanelProps) {
  const [form, setForm] = useState<AuthorFormState>(EMPTY_FORM);
  const [replacing, setReplacing] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);

  function replace(row: PromoCodeView) {
    const discount = row.discount;
    setForm({
      ...EMPTY_FORM,
      // The code is deliberately BLANK: the replacement is a different code,
      // and pre-filling the old one would invite an operator to submit it and
      // meet `promo_codes_code_unique` for a reason the form implied was fine.
      code: "",
      trialDays: row.trialExtensionDays === null ? "" : String(row.trialExtensionDays),
      kind: discount === null ? "none" : discount.kind,
      percentOff: discount?.kind === "percent_off" ? String(discount.percentOff) : "",
      amountOff: discount?.kind === "amount_off" ? String(discount.amountOffMinor) : "",
      currency: discount?.kind === "amount_off" ? discount.currency : EMPTY_FORM.currency,
      duration: discount?.duration ?? "once",
      months: discount?.durationInMonths === null || discount === null ? "" : String(discount.durationInMonths),
      maxRedemptions: row.maxRedemptions === null ? "" : String(row.maxRedemptions),
      // Carried over with the terms, because a replacement is the SAME
      // campaign with a different discount — and because this is the path an
      // operator is sent down when a re-scope has to reach mark8ly today, so
      // dropping the scope here would lose the very thing they came to change.
      allowedPlans: row.allowedPlans ?? [],
      annualOnly: row.annualOnly,
    });
    setReplacing(row.code);
    codeRef.current?.focus();
  }

  return (
    <section className="flex flex-col gap-6" aria-label="Promo codes">
      {canAuthor ? null : (
        <Callout variant="info">
          <CalloutDescription>
            You can see promo codes here. Authoring and retiring them needs the billing
            capability.
          </CalloutDescription>
        </Callout>
      )}

      {canAuthor ? (
        <AuthorForm
          form={form}
          setForm={setForm}
          replacing={replacing}
          codeRef={codeRef}
          onCreated={() => setReplacing(null)}
        />
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Promo codes</h3>
        <SurfaceStateView
          state={codesState}
          emptyMessage="No promo codes have been authored yet."
          reauthReturnTo="/platform/billing/catalog"
        />
        {codesState.kind === "ready" ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Effects</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Window</TableHead>
                <TableHead>Cap</TableHead>
                <TableHead>Redeemed</TableHead>
                <TableHead>Minted</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {codes.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <span className="font-medium">{row.code}</span>
                    {row.isActive ? null : (
                      <Badge variant="neutral" className="ml-2">
                        Inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{formatEffects(row)}</TableCell>
                  {/* Never blank for an unscoped code: "Every plan" is a fact
                      about it, and an empty cell would read as unknown. */}
                  <TableCell>{summariseScope(row.allowedPlans, row.annualOnly)}</TableCell>
                  <TableCell className="tabular-nums">
                    {`${toDateInput(row.validFrom)} → ${row.validUntil === null ? "no expiry" : toDateInput(row.validUntil)}`}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.maxRedemptions === null ? "Uncapped" : row.maxRedemptions}
                  </TableCell>
                  {/* Never a 0 — see this module's header. */}
                  <TableCell className="text-muted-foreground">
                    {REDEMPTIONS_UNREPORTED}
                  </TableCell>
                  <TableCell>
                    {row.coupons.length === 0
                      ? "Not minted"
                      : row.coupons
                          .map((coupon) => `${coupon.mode}: ${coupon.stripeCouponId}`)
                          .join(", ")}
                  </TableCell>
                  <TableCell>
                    <RowControls
                      row={row}
                      mode={mode}
                      canAuthor={canAuthor}
                      canMint={canMint}
                      onReplace={replace}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </div>
    </section>
  );
}
