/**
 * What the Trials view is showing, and the vocabulary for saying so.
 *
 * An operator opened Billing → Trials, saw "Nothing here yet", and knew of a
 * tenant on a trial. The list was correct; **its scope was invisible.** The
 * tab applies the product's 7-day expiry window and excludes Stripe-managed
 * trials, and said neither on screen — so a 90-day trial is absent for about
 * twelve weeks, which is right and reads exactly like a broken page.
 *
 * The narrow default earns its place: the ordering is soonest-first, there is
 * a payment-method column, and it is the same window the product's own
 * trials_expiring KPI counts — platform-api's comment calls it "a work queue,
 * not a report". What is not defensible is applying it silently. So the work
 * queue stays the default and becomes a visible, changeable scope.
 *
 * PURE, AND DELIBERATELY IMPORT-FREE. `billing-views.tsx` is a client
 * component, and a value import from `lib/billing` there pulls
 * `PlatformApiError` → `lib/platform-api` → `pg` and `node:crypto` into the
 * browser bundle — a failure `next build` catches and both tsc and jsdom miss.
 * The product's display name is therefore a PARAMETER here rather than a
 * `sourceLabel` import, since that helper has the same ancestry.
 */

/**
 * The window the product applies when a caller names none: mark8ly's
 * `DefaultExpiryWindow`, 7 days.
 *
 * Stated here so the console can recognise the default and send NOTHING for
 * it — the product's constant stays the single definition, shared with its
 * trials_expiring KPI "so the two cannot report different numbers for the same
 * word". Widening the list is a view change and must not move that counter.
 */
export const DEFAULT_TRIAL_WINDOW_DAYS = 7;

/**
 * The widest window on offer: mark8ly's `MaxExpiryWindow`, 365 days.
 *
 * NOT "every trial". The product's own comment is explicit that an
 * operator-extended trial "can end arbitrarily far in the future", so this is
 * a bound rather than a claim — which is why the label below says "up to a
 * year" and the empty copy says what it would miss.
 */
export const MAX_TRIAL_WINDOW_DAYS = 365;

/**
 * The two populations a trials list can hold, and the vocabulary for choosing
 * between them.
 *
 * `signup` is where mark8ly's `Bootstrap` leaves EVERY subscription: plan
 * `trial`, status `signup`. Exactly one writer moves a row on to `trialing` —
 * the `checkout.session.completed` webhook — so a tenant that abandons
 * checkout stays at `signup` indefinitely, and `expiry_cron` (which only
 * touches `trialing`) never ages it out either. An operator with three such
 * tenants saw an empty trials list at every window.
 *
 * `all` is the widest scope this list has, not "every status in the product":
 * these are the only two the trials endpoint can return, one of them by
 * opt-in.
 */
export const TRIAL_STATUS_BOTH = "all";
export const TRIAL_STATUS_TRIALING = "trialing";

export type TrialStatusScope = typeof TRIAL_STATUS_BOTH | typeof TRIAL_STATUS_TRIALING;

export interface TrialStatusOption {
  readonly value: TrialStatusScope;
  readonly label: string;
}

/** The statuses the Status filter offers, widest first. The labels name the
 *  populations rather than saying "All": there are two, and enumerating them
 *  is what tells an operator that a second one exists at all. */
export const TRIAL_STATUSES: readonly TrialStatusOption[] = [
  { value: TRIAL_STATUS_BOTH, label: "Trialing and signup" },
  { value: TRIAL_STATUS_TRIALING, label: "Trialing only" },
];

/** Whether a raw URL value is one of the statuses this surface offers. Same
 *  reason as `isTrialWindow`: a query string is untrusted input, and a value
 *  nobody offered must not decide what the request asks for. */
export function isTrialStatusScope(raw: string): raw is TrialStatusScope {
  return TRIAL_STATUSES.some((status) => status.value === raw);
}

export interface TrialWindowOption {
  readonly value: string;
  readonly label: string;
}

/** The windows the Expiring filter offers, narrowest first. */
export const TRIAL_WINDOWS: readonly TrialWindowOption[] = [
  { value: String(DEFAULT_TRIAL_WINDOW_DAYS), label: "Next 7 days" },
  { value: "30", label: "Next 30 days" },
  { value: String(MAX_TRIAL_WINDOW_DAYS), label: "Any (up to a year)" },
];

/** Whether a raw URL value is one of the windows this surface offers. A query
 *  string is untrusted input, and a window nobody offered must not reach the
 *  API — the platform boundary would clamp or refuse it, and either way the
 *  bar would show a scope that is not the one in effect. */
export function isTrialWindow(raw: string): boolean {
  return TRIAL_WINDOWS.some((window) => window.value === raw);
}

/**
 * The products that federate §8.2 today.
 *
 * Hardcoded, and that is the honest direction — the same call
 * `AUDIT_PRODUCT_SOURCES` makes. platform-api resolves this parameter against
 * `cfg.Federation.SlugsImplementing("billing")` and REFUSES a slug that list
 * does not hold with a 400, rather than answering an empty list, so a product
 * offered here that does not federate billing turns a filter choice into an
 * error page. That list is deployment configuration this build cannot read;
 * `cmd/server/main.go` records `FEDERATION_MARK8LY_ENDPOINTS` as
 * `outbox,onboarding,billing,inbox,conversions` in the cluster, and no other
 * product's endpoint list is named anywhere in the repository. Adding a
 * second product here is a change to that configuration first.
 */
export const BILLING_PRODUCT_SOURCES = ["mark8ly"] as const;

/** Which trials the view is asking for. `days` is always resolved — the
 *  default is a *selection*, not an absence.
 *
 *  `status` is optional for the opposite reason, and shaped like `source`: its
 *  absent state is the WIDEST scope this surface asks for, so an absent value
 *  hides nothing. Only the narrowing is worth recording. */
export interface TrialScope {
  readonly days: number;
  readonly status?: TrialStatusScope;
  readonly source?: string;
}

/** The query `fetchEstateTrials` takes. */
export interface TrialQuery {
  source?: string;
  days?: number;
  includeStripeManaged?: boolean;
  includeSignup?: boolean;
}

/**
 * The scope as a request.
 *
 * TWO decisions live here, in one place, so neither can be made differently at
 * a second call site:
 *
 *  1. The default window sends NO `days`. The request is then byte-identical
 *     to the one this surface has always made, and the product's own default
 *     remains the definition rather than a number the console re-states.
 *
 *  2. The widest window ALWAYS carries `include_stripe_managed`. A converting
 *     trial is still a trial; offering "Any" while silently excluding
 *     Stripe-managed rows would rebuild the same invisible-scope bug one level
 *     down. Narrower windows keep the work-queue exclusion — those rows
 *     convert rather than expire, so they are not what somebody acts on today.
 *
 *  3. Every scope but `Trialing only` carries `include_signup`. This CHANGES
 *     THE DEFAULT REQUEST, which decision 1 above deliberately kept
 *     byte-identical to production — and the two are not in tension, because
 *     they are about different things. Decision 1 avoids duplicating a
 *     *definition*: `DefaultExpiryWindow` is shared with the product's
 *     trials_expiring KPI, so a window restated here could make the tab and
 *     the counter disagree about the word "expiring". This is a caller
 *     choosing a scope the API already offers — no constant is copied, no KPI
 *     is touched, and the product keeps its own default for callers that do
 *     not ask.
 *
 *     Default rather than opt-in because the reported bug IS the default: an
 *     operator whose three tenants all sit at `signup` sees an empty page at
 *     every window, and a signup tenant is the stronger work-queue case, not
 *     the weaker one — nothing ages it out and nobody is chasing it.
 *
 *     `Trialing only` sends nothing rather than `include_signup=false`: the
 *     API offers a widening opt-in and no exclusion, so `false` would be a
 *     parameter that says nothing.
 */
export function trialQueryFor(scope: TrialScope): TrialQuery {
  const query: TrialQuery = {};
  if (scope.source) query.source = scope.source;
  if (scope.days !== DEFAULT_TRIAL_WINDOW_DAYS) query.days = scope.days;
  if (scope.days === MAX_TRIAL_WINDOW_DAYS) query.includeStripeManaged = true;
  if (scope.status !== TRIAL_STATUS_TRIALING) query.includeSignup = true;
  return query;
}

/** How a window reads in a sentence. */
function windowPhrase(days: number): string {
  return days === MAX_TRIAL_WINDOW_DAYS ? "next year" : `next ${days} days`;
}

/**
 * The empty state — the actual fix for the reported confusion.
 *
 * It names the scope in effect, which is the sentence that would have answered
 * "where is my tenant?" instantly. Three parts, each doing work:
 *
 *  - the active window (and product, when narrowed to one), so an empty list
 *    is read as an answer about a scope rather than about the estate;
 *  - "every product that answered", kept verbatim from the copy this replaces:
 *    it separates "there are none" from "a product did not answer", and the
 *    `failures` callout renders directly above this;
 *  - the way out. At a narrow window that is a wider one. At the widest there
 *    is none, so instead of inviting a widening that does not exist it says
 *    what this window still cannot see — an extended trial ending past a year.
 *
 * Under `Trialing only` the window is no longer the most likely reason the
 * list is empty: signup rows are in by default, so the operator has just
 * excluded the population that is usually there. That branch names the
 * narrowing AND the window — dropping the window would move the invisible
 * scope one filter along rather than fixing it.
 */
export function trialsEmptyMessage(scope: {
  days: number;
  status?: TrialStatusScope;
  sourceLabel?: string;
}): string {
  const at = scope.sourceLabel ? ` at ${scope.sourceLabel}` : "";
  if (scope.status === TRIAL_STATUS_TRIALING) {
    return (
      `No trials with a completed checkout are expiring in the ${windowPhrase(scope.days)}${at}. ` +
      `Every product that answered has none — "Trialing and signup" also shows tenants that ` +
      `signed up and never finished checkout.`
    );
  }
  const head = `No trials expiring in the ${windowPhrase(scope.days)}${at}.`;
  if (scope.days === MAX_TRIAL_WINDOW_DAYS) {
    return `${head} Every product that answered has none. A trial extended past a year would still not appear here.`;
  }
  return `${head} Every product that answered has none — a wider window may.`;
}
