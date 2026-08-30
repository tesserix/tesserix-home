// From `surface-state`, NOT `states`: both callers are server components, and
// `states.tsx` carries a load-bearing `"use client"` that turns every export
// into a client reference — calling one from the server throws at runtime
// while tsc, `next build` and jsdom tests all pass.
import { toSurfaceError, type SurfaceError } from "@/components/kit/surface-state";

/**
 * Which product an onboarding surface is about — shared by the funnel and the
 * session list.
 *
 * # Why this is one module and not two copies
 *
 * Both surfaces ask the same question of the same read (`GET
 * /v1/platform/sources`), and both must answer it identically: an operator who
 * follows the link from the funnel to the sessions must land on the SAME
 * product, and a default that drifted between the two would show one product's
 * counts above another's rows. The estate has that failure already — two
 * near-identical filter hooks whose race guard only held in one of them — and
 * this is the same shape, so it gets the same fix in advance.
 *
 * # There is no fallback slug here, on purpose
 *
 * `/platform/onboarding` carried `FUNNEL_SOURCE = "mark8ly"` until #447 gave
 * the console a way to learn which products declare `onboarding`. Restoring
 * that literal as a fallback for a failed read would be the hardcode wearing a
 * disguise: the pages would look identical whether the declarations were read
 * or not, and nobody could tell the picker had stopped working. So a failed
 * read produces no source and no question — see {@link sourcesReadError}.
 */

/** The endpoint name a product declares to appear in these surfaces.
 *  mark8ly's `FEDERATION_MARK8LY_ENDPOINTS` value, verbatim. */
export const ONBOARDING_ENDPOINT = "onboarding";

/** The funnel — where merchants stall. */
export const ONBOARDING_PATH = "/platform/onboarding";

/**
 * The session list — which merchant to call.
 *
 * A separate route rather than a section of the funnel, and the split is by
 * question and by audience: the funnel is a glanceable measurement anyone
 * reading the estate wants, the list is a work queue for whoever is chasing
 * individual signups. It also happens to be the PII boundary — every session
 * row is a merchant's email address and no funnel tile is — so keeping them
 * apart means the page most people open carries none.
 */
export const ONBOARDING_SESSIONS_PATH = "/platform/onboarding/sessions";

/**
 * Copy for "nothing federates onboarding here", which is NOT an error.
 *
 * The kit's default parked-plane text points at `docs/observability-park.md`,
 * which is the wrong doc: nothing here is waiting on observability. The remedy
 * is a federation declaration, and saying so is the difference between an
 * operator who files a bug and one who knows there is nothing to file.
 *
 * The same words serve two arrivals at the same fact — an empty declaration
 * list, and platform-api's 501 — because they ARE the same fact, and two
 * phrasings of it would read as two different problems.
 */
export const ONBOARDING_UNAVAILABLE_TITLE = "Onboarding is not federated here";
export const ONBOARDING_UNAVAILABLE_MESSAGE =
  "No product on this deployment federates an onboarding funnel yet. Nothing " +
  "is broken and there is nothing to retry — this surface turns on when a " +
  "product declares the onboarding endpoint.";

/**
 * What a failed sources read looks like.
 *
 * It names the READ rather than a product, because there is no product: the
 * whole content of this failure is that the console does not know which
 * products to offer. "mark8ly could not be read" would be a guess about a slug
 * nobody chose — and would be indistinguishable, on screen, from the hardcode
 * this read exists to remove.
 */
export const SOURCES_UNREADABLE_MESSAGE =
  "Could not read which products federate onboarding, so there is nothing to " +
  "ask. This is a failed read, not an empty estate — retry, and if it persists " +
  "check that the console can reach the platform API.";

export type OnboardingSearchParams = Record<string, string | string[] | undefined>;

/**
 * The `?source=` a URL asked for, if it asked for one.
 *
 * Repeated params are ignored: these surfaces read one product, and honouring
 * the first of two would answer about a product the URL does not
 * unambiguously name.
 */
export function requestedSource(searchParams: OnboardingSearchParams): string | undefined {
  const raw = searchParams.source;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Which product a surface is about, or why it is about none. Three outcomes
 *  and no fourth — in particular, no fallback slug. */
export type SourceChoice =
  | { kind: "source"; source: string }
  /** The read succeeded and nobody declares `onboarding`. A fact about the
   *  estate, and the same fact platform-api reports as a 501. */
  | { kind: "none-declared" }
  /**
   * The URL named a product that does not declare `onboarding`.
   *
   * Refused rather than silently replaced with a declared one. The API answers
   * 400 for such a source, so asking would fail anyway — but the reason to
   * refuse rather than quietly correct is that answering about a DIFFERENT
   * product than the URL names is a lie an operator cannot see, on surfaces
   * whose output is the kind somebody screenshots or pastes into a ticket.
   */
  | { kind: "unknown-source"; requested: string; declared: readonly string[] };

export function chooseSource(
  declared: readonly string[],
  requested: string | undefined,
): SourceChoice {
  if (declared.length === 0) return { kind: "none-declared" };
  if (requested === undefined) {
    // The first declared product, in the API's own sorted order — so two
    // identical deployments land on the same default rather than on whichever
    // one a map iteration happened to yield first, and so the funnel and the
    // session list default to the same one.
    return { kind: "source", source: declared[0]! };
  }
  if (declared.includes(requested)) return { kind: "source", source: requested };
  return { kind: "unknown-source", requested, declared };
}

/** Copy for a `?source=` nobody declares. It names both halves — what was
 *  asked for and what is available — because either alone leaves the operator
 *  guessing which of the two is wrong. */
export function unknownSourceMessage(requested: string, declared: readonly string[]): string {
  return (
    `No product called “${requested}” federates an onboarding funnel here. ` +
    `Declared: ${declared.join(", ")}.`
  );
}

/**
 * Narrows a caught sources read.
 *
 * The message is replaced wholesale — the API's own text is about a route an
 * operator on these pages never asked for — but `reauthRequired` is carried
 * through untouched. A session with no operator token fails every read on the
 * page, and that state has a ten-second remedy the generic copy never
 * mentions; losing it here would show an outage message for something nothing
 * is wrong with.
 *
 * There is no 501 branch, because this route has no 501: it answers from the
 * deployment's own configuration and calls no product. An estate that
 * federates nothing is an empty list, which is a successful read.
 */
export function sourcesReadError(caught: unknown): SurfaceError | null {
  const error = toSurfaceError(caught);
  if (error === null) return null;
  return { ...error, message: SOURCES_UNREADABLE_MESSAGE };
}
