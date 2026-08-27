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
import { fetchEstateSubscriptions, fetchEstateTrials } from "@/lib/platform-api";
import type { SubscriptionPage, TrialPage } from "@/lib/billing";
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

export interface ViewStateInput {
  readonly error: unknown;
  readonly rows: readonly unknown[];
}

/**
 * Which state one view is in.
 *
 * `filtered` is false: this surface offers no filters yet, and claiming
 * otherwise renders the kit's "no results — clear filters" copy for a list
 * that is simply empty, turning a good answer into an apparent operator
 * mistake.
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

export default async function EstateBilling() {
  // Fetched together and settled independently — one endpoint failing must not
  // take the other's tab down with it. `Promise.allSettled`, not `all`, for
  // exactly that reason: `all` rejects on the first failure and would discard
  // a perfectly good second answer.
  const [subsResult, trialsResult] = await Promise.allSettled([
    fetchEstateSubscriptions(),
    fetchEstateTrials(),
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
        reauthReturnTo="/platform/billing"
      />
    </div>
  );
}
