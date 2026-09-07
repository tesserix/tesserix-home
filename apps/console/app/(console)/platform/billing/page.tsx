import { ConsolePageHeader } from "@/components/kit/page-header";
// From `surface-state`, NOT `states`: this is a server component, and
// `states.tsx` carries a load-bearing `"use client"` that turns every export
// into a client reference — calling `resolveState` through it throws at
// runtime while tsc, `next build` and jsdom tests all pass.
import {
  NOT_IMPLEMENTED,
  resolveState,
  toSurfaceError,
  type SurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
import { fetchEstateSubscriptions, fetchEstateTrials } from "@/lib/platform-api";
import type { SubscriptionPage, TrialPage } from "@/lib/billing";
import { sourceLabel } from "@/lib/audit";
import {
  BILLING_PRODUCT_SOURCES,
  DEFAULT_TRIAL_WINDOW_DAYS,
  TRIAL_WINDOWS,
  isTrialWindow,
  trialQueryFor,
  trialsEmptyMessage,
  type TrialScope,
} from "@/lib/trial-scope";
import { BillingViews, CatalogLink } from "./billing-views";

/**
 * The estate's billing surface — contract §8.2, and the console's first
 * surface gated on the `billing` capability.
 *
 * §8.2's reason for existing, in its own words:
 *
 *   Five endpoints were enough to make a product manageable. They are not
 *   enough to make it legible as a business, and the gap is specific: a flat
 *   /admin/kpis map cannot express "which trials expire this week, with
 *   dunning state, across tenants". That is a list with per-row state, not a
 *   headline number.
 *
 * TWO READS, resolved independently — the same split the tickets page makes
 * between its queue and its analytics tab. A product outage on one endpoint
 * must not blank the other: trials and subscriptions are separate federated
 * calls, and a caller who can still see expiring trials while subscriptions
 * are unreachable is strictly better off than one who sees neither.
 */

/**
 * Copy for the 501, which is NOT an error.
 *
 * A 501 here means no product declares §8.2 — which is a real and different
 * thing from "the estate has no customers". §8.2 forbids a product returning
 * an empty list to mean "no billing" for exactly that reason, and the same
 * distinction has to survive to the page: an unconfigured console must not
 * render as a solvent estate with nobody paying.
 */
export const BILLING_UNAVAILABLE_TITLE = "Billing is not switched on";
export const BILLING_UNAVAILABLE_MESSAGE =
  "No product is federating billing to the console yet. Nothing is broken and " +
  "there is nothing to retry — this surface turns on when at least one product " +
  "declares the billing endpoints.";

export function billingReadError(caught: unknown): SurfaceError | null {
  const error = toSurfaceError(caught);
  if (error === null || error.status !== NOT_IMPLEMENTED) return error;
  return {
    ...error,
    unavailable: { title: BILLING_UNAVAILABLE_TITLE, message: BILLING_UNAVAILABLE_MESSAGE },
  };
}

/**
 * The trials tab's two filters.
 *
 * Keys are the platform API's own parameter names (`days`, `source`), so the
 * descriptor key, the URL param and the upstream param are one name — the same
 * choice the ticket queue makes.
 *
 * `days` carries a `defaultValue` because its unset state is not "no filter":
 * the product applies a 7-day expiry window whether or not anyone asked. See
 * `FilterDescriptor.defaultValue`.
 */
export const TRIAL_FILTERS: FilterDescriptor[] = [
  {
    key: "days",
    label: "Expiring",
    type: "select",
    defaultValue: String(DEFAULT_TRIAL_WINDOW_DAYS),
    options: TRIAL_WINDOWS.map((window) => ({ value: window.value, label: window.label })),
  },
  {
    key: "source",
    label: "Product",
    type: "select",
    options: BILLING_PRODUCT_SOURCES.map((source) => ({
      value: source,
      label: sourceLabel(source),
    })),
  },
];

export type BillingSearchParams = Record<string, string | string[] | undefined>;

/**
 * Read the trials scope out of the URL.
 *
 * Untrusted input, so a value survives only if this surface offers it. An
 * unrecognised window falls back to the default rather than travelling on: the
 * platform boundary would clamp or refuse it, and the bar would then display a
 * scope that is not the one in effect. A repeated param arrives as an array
 * and is ignored for the same reason — the endpoint takes one value per key.
 *
 * `days` is always resolved to a number: the default is a SELECTION, not an
 * absence. What the request omits is decided by `trialQueryFor`, not here.
 */
export function readTrialScope(searchParams: BillingSearchParams): TrialScope {
  const rawDays = searchParams.days;
  const days =
    typeof rawDays === "string" && isTrialWindow(rawDays)
      ? Number(rawDays)
      : DEFAULT_TRIAL_WINDOW_DAYS;

  const rawSource = searchParams.source;
  const source =
    typeof rawSource === "string" &&
    (BILLING_PRODUCT_SOURCES as readonly string[]).includes(rawSource)
      ? rawSource
      : undefined;

  return source ? { days, source } : { days };
}

/**
 * The applied scope as the bar's display values — what the server actually
 * asked for, never what the URL happens to say. The two differ when a URL
 * carries a value no descriptor offers, and a bar showing a filter that is not
 * in effect is the same class of lie as a scope that is invisible.
 *
 * The default window is omitted rather than written out: `FilterBar` renders
 * the descriptor's `defaultValue` for an absent value, and including it would
 * light up "Clear filters" for something nobody chose.
 */
export function toTrialFilterValues(scope: TrialScope): FilterValues {
  const values: FilterValues = {};
  if (scope.days !== DEFAULT_TRIAL_WINDOW_DAYS) values.days = String(scope.days);
  if (scope.source) values.source = scope.source;
  return values;
}

export interface ViewStateInput {
  readonly error: unknown;
  readonly rows: readonly unknown[];
}

/**
 * Which state one view is in.
 *
 * `filtered` stays false even though the trials tab now has filters, and that
 * is deliberate. `filtered-empty` renders the kit's fixed "No rows match the
 * current filters — clear them to see everything" copy, which cannot name the
 * window and offers a clearing that does not exist: the 7-day window is in
 * effect whether or not anyone chose it, so there is no unfiltered state to
 * return to. The `empty` copy this page supplies names the active scope
 * instead, which is the sentence the operator needed; the filter bar renders
 * above it either way, so the way out is still on screen.
 */
export function viewState(input: ViewStateInput): SurfaceState {
  return resolveState({
    isLoading: false,
    error: billingReadError(input.error),
    rows: input.rows,
    filtered: false,
  });
}

const EMPTY_SUBSCRIPTIONS: SubscriptionPage = { data: [], total: 0, failures: [] };
const EMPTY_TRIALS: TrialPage = { data: [], total: 0, failures: [] };

/**
 * The operator's own URL as a relative path, so signing in again returns them
 * to the scope they were looking at rather than to the default one. Same shape
 * `middleware.ts` and the ticket queue build.
 */
function currentPath(searchParams: BillingSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") {
      params.set(key, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) params.append(key, entry);
    }
  }
  const qs = params.toString();
  return qs ? `/platform/billing?${qs}` : "/platform/billing";
}

export default async function EstateBilling({
  searchParams,
}: {
  searchParams: Promise<BillingSearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const scope = readTrialScope(resolvedSearchParams);

  // Fetched together and settled independently — one endpoint failing must not
  // take the other's tab down with it. `Promise.allSettled`, not `all`, for
  // exactly that reason: `all` rejects on the first failure and would discard
  // a perfectly good second answer.
  //
  // Only the trials read is scoped. The subscriptions tab is a different
  // question with no expiry window, and it already answers "every tenant on a
  // trial" through its own `plan` filter.
  const [subsResult, trialsResult] = await Promise.allSettled([
    fetchEstateSubscriptions(),
    fetchEstateTrials(trialQueryFor(scope)),
  ]);

  const subscriptions =
    subsResult.status === "fulfilled" ? subsResult.value : EMPTY_SUBSCRIPTIONS;
  const trials = trialsResult.status === "fulfilled" ? trialsResult.value : EMPTY_TRIALS;

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Billing"
        description="Every product's recurring revenue and expiring trials, in one place."
        actions={<CatalogLink />}
      />

      <BillingViews
        subscriptions={subscriptions}
        trials={trials}
        subscriptionsState={viewState({
          error: subsResult.status === "rejected" ? subsResult.reason : null,
          rows: subscriptions.data,
        })}
        trialsState={viewState({
          error: trialsResult.status === "rejected" ? trialsResult.reason : null,
          rows: trials.data,
        })}
        trialFilters={TRIAL_FILTERS}
        trialFilterValues={toTrialFilterValues(scope)}
        trialsEmptyMessage={trialsEmptyMessage({
          days: scope.days,
          sourceLabel: scope.source ? sourceLabel(scope.source) : undefined,
        })}
        reauthReturnTo={currentPath(resolvedSearchParams)}
      />
    </div>
  );
}
