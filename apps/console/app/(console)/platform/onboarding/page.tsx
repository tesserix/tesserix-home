import { ConsolePageHeader } from "@/components/kit/page-header";
// From `surface-state`, NOT `states`: this is a server component, and
// `states.tsx` carries a load-bearing `"use client"` that turns every export
// into a client reference — calling `resolveState` through it throws at
// runtime while tsc, `next build` and jsdom tests all pass. See
// `platform/billing/page.tsx`'s identical comment.
import {
  NOT_IMPLEMENTED,
  resolveState,
  toSurfaceError,
  type SurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import { fetchOnboardingFunnel } from "@/lib/platform-api";
import type { OnboardingFunnel } from "@/lib/onboarding-funnel";
import { FunnelView } from "./funnel-view";

/**
 * `/platform/onboarding` — where signups stall, read from the product that
 * owns the funnel (tesserix-home#404, §6 step 4).
 *
 * # Why this is on the PLATFORM rail
 *
 * §2's rule: a surface belongs here when the operator's question spans
 * products, and "where do signups stall" is one every product with onboarding
 * has. mark8ly is the first implementer, not the only conceivable one — which
 * is why platform-api's route is `/v1/onboarding/funnel?source=…` rather than
 * a mark8ly-named one, and why this page is not on mark8ly's product rail
 * beside the CSM migration queue (that queue presupposes mark8ly's migration
 * model; a funnel does not).
 *
 * # One read, and no fan-out
 *
 * The API refuses a request without a `source`, deliberately: merging two
 * products' funnels needs a third stage vocabulary that is neither
 * product's — the drift #404's first rule exists to prevent. So this page
 * asks about one product and renders THAT product's stage names back. When a
 * second product declares `onboarding` there are two real vocabularies to
 * reconcile and this becomes a picker; until then a picker would offer
 * sources the API answers 400 for.
 *
 * # The 501 is the common path today, and it is not an error
 *
 * platform-api answers 501 until `FEDERATION_MARK8LY_ENDPOINTS` includes
 * `onboarding`, which production does not yet. That is a deployment fact —
 * nothing is broken, nothing is worth retrying — so it renders as the calm
 * parked callout with copy naming THIS surface, never as an error and never
 * as a funnel of zeroes. See {@link onboardingReadError}.
 */

/**
 * The product this page asks about.
 *
 * A constant rather than a `?source=` parameter: mark8ly is the only product
 * declaring an onboarding funnel today, and a picker listing the estate's
 * other products would offer sources platform-api refuses with a 400. The
 * console has no read that says which products declare `onboarding`, so
 * offering the choice would mean inventing a list that drifts from the
 * deployment's own declarations — the second vocabulary problem again, one
 * level up.
 */
export const FUNNEL_SOURCE = "mark8ly";

/** Where this surface lives, for the sign-in-again return path. */
export const ONBOARDING_PATH = "/platform/onboarding";

/**
 * Copy for the 501, which is NOT an error.
 *
 * The generic parked-plane text points at `docs/observability-park.md`, which
 * is the wrong doc: nothing here is waiting on observability. The remedy is a
 * federation declaration, and saying so is the difference between an operator
 * who files a bug and one who knows there is nothing to file.
 */
export const ONBOARDING_UNAVAILABLE_TITLE = "Onboarding is not federated here";
export const ONBOARDING_UNAVAILABLE_MESSAGE =
  "No product on this deployment federates an onboarding funnel yet. Nothing " +
  "is broken and there is nothing to retry — this surface turns on when a " +
  "product declares the onboarding endpoint.";

/**
 * Narrows a caught read into the shape `resolveState` reads, with two changes
 * this surface is entitled to make.
 *
 * A 501 gains surface-specific parked copy (see above). Every other failure
 * keeps its status and gains the source's NAME: with one read there is no
 * partial failure to enumerate, but the page must still say WHAT could not be
 * read rather than "something went wrong" — an operator who cannot tell which
 * product went quiet cannot act on the failure.
 */
export function onboardingReadError(
  caught: unknown,
  source: string = FUNNEL_SOURCE,
): SurfaceError | null {
  const error = toSurfaceError(caught);
  if (error === null) return null;
  if (error.status === NOT_IMPLEMENTED) {
    return {
      ...error,
      unavailable: {
        title: ONBOARDING_UNAVAILABLE_TITLE,
        message: ONBOARDING_UNAVAILABLE_MESSAGE,
      },
    };
  }
  // The API's own words, prefixed with the source. They are already sanitised
  // upstream — `writeReadError` deliberately never returns a transport
  // error's text, which carries hostnames — so this adds the one fact the
  // console knows and the API does not repeat.
  return { ...error, message: `${source}: ${error.message}` };
}

export interface FunnelStateInput {
  readonly error: unknown;
  readonly funnel: OnboardingFunnel | null;
}

/**
 * Which state the page is in.
 *
 * `rows` is `[funnel]` on a successful read and `[]` otherwise — never the
 * stage list. A funnel whose every stage is zero is a real, ready answer ("we
 * measured, and nobody got through"), and resolving that to `empty` would
 * render the kit's "nothing here yet" copy over a genuine measurement. The
 * converse is what #404's second rule forbids and is enforced the same way: a
 * read that threw has no funnel, so nothing that looks like a count can reach
 * the page.
 *
 * `filtered` is false: this surface offers no filters, and claiming otherwise
 * shows "clear filters" copy for a state no filter produced.
 */
export function funnelState(input: FunnelStateInput): SurfaceState {
  return resolveState({
    isLoading: false,
    error: onboardingReadError(input.error),
    rows: input.funnel ? [input.funnel] : [],
    filtered: false,
  });
}

export default async function OnboardingFunnelPage() {
  let funnel: OnboardingFunnel | null = null;
  let error: unknown = null;
  try {
    funnel = await fetchOnboardingFunnel(FUNNEL_SOURCE);
  } catch (caught) {
    // Caught rather than thrown on to the error boundary: a 501 is the common
    // path on this deployment and is not a failure at all, and even a real
    // outage has a better answer here than a blank screen — the page can say
    // which product it could not read.
    error = caught;
  }

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Onboarding"
        description="Where merchants stall between signing up and finishing setup."
      />

      <FunnelView
        funnel={funnel}
        source={FUNNEL_SOURCE}
        state={funnelState({ error, funnel })}
        reauthReturnTo={ONBOARDING_PATH}
      />
    </div>
  );
}
