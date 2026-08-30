import Link from "next/link";
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
import { fetchOnboardingFunnel, fetchPlatformSources } from "@/lib/platform-api";
import { slugsDeclaring, type PlatformSources } from "@/lib/platform-sources";
import {
  chooseSource,
  ONBOARDING_ENDPOINT,
  ONBOARDING_PATH,
  ONBOARDING_SESSIONS_PATH,
  ONBOARDING_UNAVAILABLE_MESSAGE,
  ONBOARDING_UNAVAILABLE_TITLE,
  requestedSource,
  sourcesReadError,
  unknownSourceMessage,
  type OnboardingSearchParams,
  type SourceChoice,
} from "./source-choice";
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
 * # One read per product, and no fan-out
 *
 * The API refuses a request without a `source`, deliberately: merging two
 * products' funnels needs a third stage vocabulary that is neither product's —
 * the drift #404's first rule exists to prevent. So this page asks about ONE
 * product and renders THAT product's stage names back.
 *
 * # Which product is a read, not a literal
 *
 * This page used to carry `FUNNEL_SOURCE = "mark8ly"`, because the console had
 * no way to learn which products declare `onboarding` and a picker would have
 * offered sources the API answers 400 for. `GET /v1/platform/sources` (#447)
 * closes that gap, so the list now comes from the deployment's own federation
 * declarations: a second product appears without a console change, and a
 * product that stops declaring disappears without one.
 *
 * Only mark8ly declares `onboarding` today, so there is one source and the
 * picker renders no chips — see {@link FunnelView}. That is the list being
 * short, not the list being absent.
 *
 * # A sources read that fails is NOT mark8ly
 *
 * {@link onboardingPageState} has no branch that falls back to a slug. A
 * default here would be the hardcode wearing a disguise: the page would look
 * identical whether the picker worked or not, and an operator would have no
 * way to tell that the estate's declarations went unread. Without that read
 * there is no source to ask about, so the page says which read failed and asks
 * nothing — one honest failure instead of a confident answer about a product
 * nobody chose.
 *
 * # The 501 is the common path today, and it is not an error
 *
 * platform-api answers 501 until `FEDERATION_MARK8LY_ENDPOINTS` includes
 * `onboarding`. That is a deployment fact — nothing is broken, nothing is
 * worth retrying — so it renders as the calm parked callout with copy naming
 * THIS surface, never as an error and never as a funnel of zeroes. An empty
 * declaration list says exactly the same thing one layer earlier, and is
 * rendered with the same copy rather than as a second way of saying it.
 */

/**
 * Narrows a caught funnel read into the shape `resolveState` reads, with two
 * changes this surface is entitled to make.
 *
 * A 501 gains surface-specific parked copy (see above). Every other failure
 * keeps its status and gains the source's NAME: with one read there is no
 * partial failure to enumerate, but the page must still say WHAT could not be
 * read rather than "something went wrong" — an operator who cannot tell which
 * product went quiet cannot act on the failure.
 */
export function onboardingReadError(caught: unknown, source: string): SurfaceError | null {
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

export interface OnboardingStateInput {
  readonly sourcesError: unknown;
  readonly choice: SourceChoice | null;
  readonly funnelError: unknown;
  readonly funnel: OnboardingFunnel | null;
}

/**
 * Which state the page is in.
 *
 * The sources read is checked FIRST and short-circuits, because without it
 * there is no question to ask and every later branch would be about a product
 * nobody chose.
 *
 * `rows` on the funnel branch is `[funnel]` on a successful read and `[]`
 * otherwise — never the stage list. A funnel whose every stage is zero is a
 * real, ready answer ("we measured, and nobody got through"), and resolving
 * that to `empty` would render the kit's "nothing here yet" copy over a
 * genuine measurement. The converse is what #404's second rule forbids and is
 * enforced the same way: a read that threw has no funnel, so nothing that
 * looks like a count can reach the page.
 *
 * `filtered` is false throughout: the source picker chooses WHICH funnel to
 * read, it does not narrow one, so "clear filters" copy would offer an action
 * that does not exist here.
 */
export function onboardingPageState(input: OnboardingStateInput): SurfaceState {
  if (input.sourcesError) {
    return resolveState({
      isLoading: false,
      error: sourcesReadError(input.sourcesError),
      rows: [],
      filtered: false,
    });
  }
  if (input.choice === null || input.choice.kind === "none-declared") {
    // The same answer platform-api's 501 gives, reached one layer earlier and
    // rendered with the same words rather than a second phrasing of it.
    return {
      kind: "instrumentation-unavailable",
      title: ONBOARDING_UNAVAILABLE_TITLE,
      message: ONBOARDING_UNAVAILABLE_MESSAGE,
    };
  }
  if (input.choice.kind === "unknown-source") {
    return {
      kind: "error",
      message: unknownSourceMessage(input.choice.requested, input.choice.declared),
    };
  }
  return resolveState({
    isLoading: false,
    error: onboardingReadError(input.funnelError, input.choice.source),
    rows: input.funnel ? [input.funnel] : [],
    filtered: false,
  });
}

/** This surface's own URL, preserved for the sign-in-again return path so an
 *  operator lands back on the source they were looking at. */
export function currentPath(searchParams: OnboardingSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
  }
  const query = params.toString();
  return query ? `${ONBOARDING_PATH}?${query}` : ONBOARDING_PATH;
}

export default async function OnboardingFunnelPage({
  searchParams,
}: {
  searchParams: Promise<OnboardingSearchParams>;
}) {
  const resolved = await searchParams;

  // Two independent reads, narrowed separately. The sources read comes first
  // because the funnel read cannot be made without its answer — but a funnel
  // that fails leaves the picker intact, so an operator can try the other
  // product rather than losing the page.
  let sources: PlatformSources | null = null;
  let sourcesError: unknown = null;
  try {
    sources = await fetchPlatformSources();
  } catch (caught) {
    sourcesError = caught;
  }

  const declared = sources ? slugsDeclaring(sources, ONBOARDING_ENDPOINT) : [];
  const choice = sources ? chooseSource(declared, requestedSource(resolved)) : null;

  let funnel: OnboardingFunnel | null = null;
  let funnelError: unknown = null;
  if (choice?.kind === "source") {
    try {
      funnel = await fetchOnboardingFunnel(choice.source);
    } catch (caught) {
      // Caught rather than thrown on to the error boundary: a 501 is the
      // common path on this deployment and is not a failure at all, and even a
      // real outage has a better answer here than a blank screen — the page
      // can say which product it could not read.
      funnelError = caught;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Onboarding"
        description="Where merchants stall between signing up and finishing setup."
      />

      <FunnelView
        funnel={funnel}
        source={choice?.kind === "source" ? choice.source : null}
        sources={declared}
        basePath={ONBOARDING_PATH}
        state={onboardingPageState({ sourcesError, choice, funnelError, funnel })}
        reauthReturnTo={currentPath(resolved)}
      />

      {/* Outside the view, and outside every `state.kind` branch: the rows
          behind the counts are worth reaching even when the counts could not
          be read, and especially then — a funnel that will not load is exactly
          when an operator wants the list. It is a separate page rather than a
          section because it carries merchant email addresses and this one does
          not. */}
      <p className="text-sm">
        <Link className="underline underline-offset-4" href={sessionsLink(choice)}>
          Sessions behind these counts
        </Link>
      </p>
    </div>
  );
}

/** The session list, carrying the chosen source across so the two surfaces
 *  agree about which product they are describing. Without a source the link
 *  goes bare and that page picks its own default — it makes the same choice
 *  from the same read. */
export function sessionsLink(choice: SourceChoice | null): string {
  if (choice?.kind !== "source") return ONBOARDING_SESSIONS_PATH;
  const query = new URLSearchParams({ source: choice.source });
  return `${ONBOARDING_SESSIONS_PATH}?${query.toString()}`;
}
