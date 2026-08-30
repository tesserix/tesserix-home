import Link from "next/link";
import { ConsolePageHeader } from "@/components/kit/page-header";
import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
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
import {
  fetchOnboardingSessions,
  fetchPlatformSources,
  ONBOARDING_SESSIONS_LIMIT,
  type OnboardingSessionFilters,
} from "@/lib/platform-api";
import { slugsDeclaring, type PlatformSources } from "@/lib/platform-sources";
import type { OnboardingSessionList } from "@/lib/onboarding-sessions";
import {
  chooseSource,
  ONBOARDING_ENDPOINT,
  ONBOARDING_PATH,
  ONBOARDING_UNAVAILABLE_MESSAGE,
  ONBOARDING_UNAVAILABLE_TITLE,
  requestedSource,
  sourcesReadError,
  unknownSourceMessage,
  type OnboardingSearchParams,
  type SourceChoice,
} from "../source-choice";
import { pageHref, readPage, sessionsPager } from "./pager";
import { SessionsView } from "./sessions-view";

/**
 * `/platform/onboarding/sessions` — the rows behind the funnel's counts
 * (tesserix-home#448).
 *
 * # Why this is its own route
 *
 * The funnel answers "where do merchants stall"; this answers "which merchant
 * do I call". Different questions, different audiences, and different working
 * shapes — one is a glance, the other is a queue with filters and paging.
 *
 * The split is also where the PII boundary falls. Every row here is a
 * merchant's email address and no funnel tile is one, so the page most people
 * open carries none. That is worth the extra click.
 *
 * # PII discipline, matching platform-api's
 *
 * platform-api keeps merchant addresses out of every failure path: no email
 * reaches a log line, an error message, or a truncated body. This surface
 * holds the same line. Nothing here logs a row, and every message below is
 * built from this file's own strings plus the API's — which are its own
 * sanitised sentences, never a quoted body. `lib/onboarding-sessions.ts`
 * carries the same rule for parse failures, which name a field path and never
 * a value.
 *
 * # Empty and unreadable are different answers
 *
 * The funnel's rule inverts here: an empty list IS a valid answer — nobody
 * matched the filter — while a list that could not be read is not. They are
 * kept apart the whole way down. platform-api answers 503 rather than an empty
 * 200 for a body it will not call a session list; `parseOnboardingSessions`
 * throws rather than degrading a non-array to `[]`; and this page renders a
 * read that threw as an error state, which has no rows in it at all.
 *
 * # Independent reads
 *
 * The declarations and the sessions are separate reads with separate
 * narrowing. A failed sessions read leaves the source picker and the link back
 * to the funnel intact, and the funnel lives on another route entirely, so
 * neither read can take the other's surface down.
 */

/**
 * The queue's filters, in the order an operator narrows by.
 *
 * `status` is a SEARCH BOX, not a select, and that is the load-bearing choice
 * here. The statuses are mark8ly's own words, held by an upstream service this
 * deployment cannot see or version, so any list the console offered would be a
 * second vocabulary that drifts — and one an operator could never see past,
 * because a status missing from a dropdown cannot be asked for at all.
 * platform-api forwards `status` unvalidated for the same reason: a mistyped
 * one is applied faithfully to a value nothing matches and comes back as a
 * visibly empty list, which is the truthful answer to what was asked.
 *
 * `abandoned` IS a select, and the asymmetry is not an inconsistency: it is a
 * boolean the API itself validates, with exactly two values that cannot drift.
 *
 * The window pair are text: they are RFC 3339 instants rather than dates, and
 * a date picker would offer a shape the API refuses. A malformed one is a 400
 * naming the parameter — see {@link sessionsReadError}.
 */
export const SESSION_FILTERS: FilterDescriptor[] = [
  { key: "status", label: "Status", type: "search" },
  {
    key: "abandoned",
    label: "Abandoned",
    type: "select",
    // The API's own spelling. Sent verbatim, because `abandoned=yes` is
    // dropped upstream and a dropped filter answers a different question
    // without saying so — which is why platform-api refuses it.
    options: [
      { value: "true", label: "Abandoned only" },
      { value: "false", label: "Still in flight" },
    ],
  },
  { key: "created_from", label: "Created from", type: "search" },
  { key: "created_to", label: "Created to", type: "search" },
];

/** The one param the filter bar must not touch: it chooses WHICH product's
 *  queue this is, not how it is narrowed. `mergeFiltersIntoQuery` preserves
 *  every param that is not a descriptor, so this is a statement of what is
 *  relied on rather than a mechanism. */
export const SOURCE_PARAM = "source";

export const SESSIONS_EMPTY_MESSAGE = "No onboarding sessions match this view.";

export const SESSIONS_SCOPE_NOTE =
  "Times are RFC 3339 instants — 2026-08-01T00:00:00Z. Status is the product's " +
  "own word: an unrecognised one returns an empty list rather than an error.";

/**
 * Read the filters out of the URL.
 *
 * A blank value is dropped rather than carried: a blank filter is no filter,
 * and sending `status=` would filter on the empty string. Repeated params are
 * ignored for the reason the source is — the endpoint takes one value per key.
 *
 * Nothing is validated here beyond emptiness. The window and `abandoned` are
 * checked by platform-api, which refuses what mark8ly would silently drop, and
 * duplicating that check console-side would put a second definition of "a
 * valid window" in the estate — one that starts refusing values the product
 * would have honoured the moment either end changes.
 */
export function readSessionFilters(searchParams: OnboardingSearchParams): OnboardingSessionFilters {
  const one = (key: string): string | undefined => {
    const raw = searchParams[key];
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  return {
    status: one("status"),
    createdFrom: one("created_from"),
    createdTo: one("created_to"),
    abandoned: one("abandoned"),
  };
}

/** The filter bar's view of the same values. */
export function toFilterValues(filters: OnboardingSessionFilters): FilterValues {
  const values: FilterValues = {};
  if (filters.status) values.status = filters.status;
  if (filters.abandoned) values.abandoned = filters.abandoned;
  if (filters.createdFrom) values.created_from = filters.createdFrom;
  if (filters.createdTo) values.created_to = filters.createdTo;
  return values;
}

/** True when any filter is narrowing the queue — what separates "nothing is
 *  waiting" from "nothing matches what you asked for". */
export function isFiltered(filters: OnboardingSessionFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined);
}

/**
 * Strip the label and error code the client's envelope prefixes onto an API
 * message, leaving the sentence a human wrote.
 *
 * `unwrapEnvelope` formats a failure as `onboarding sessions: BAD_REQUEST — …`,
 * which is the right shape for a log and the wrong one for a callout: the
 * operator mistyped a date, and `BAD_REQUEST` in front of the explanation
 * makes an ordinary correction look like a system fault. The sentence itself
 * is worth keeping verbatim — platform-api's window refusal names the
 * parameter AND gives a valid example, which is more than this page could say
 * about a value it deliberately does not validate.
 *
 * Left alone when the shape does not match, so a message from anywhere else
 * survives intact rather than being trimmed by a regex that guessed.
 */
export function withoutErrorCode(message: string): string {
  return message.replace(/^[^:]+: [A-Z][A-Z_]* — /, "");
}

/**
 * Narrows a caught sessions read.
 *
 * Three shapes, because they are three different situations for the operator:
 *
 *   - 400: they mistyped a filter. The API's own sentence says which one and
 *     what a valid value looks like, so it is surfaced rather than replaced
 *     with generic failure copy. Nothing is broken.
 *   - 501: nothing federates onboarding, or the product declines. The calm
 *     parked callout, with the same words the funnel uses for the same fact.
 *   - anything else: a real failure, named with the product it was about — an
 *     operator who cannot tell which product went quiet cannot act on it.
 *
 * No branch of this function can carry a merchant's address: platform-api's
 * failures are its own strings (it deliberately never quotes a body on this
 * route), and the parser's name a field path.
 */
export function sessionsReadError(caught: unknown, source: string): SurfaceError | null {
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
  if (error.status === 400) {
    return { ...error, message: withoutErrorCode(error.message ?? "") };
  }
  return { ...error, message: `${source}: ${error.message}` };
}

export interface SessionsStateInput {
  readonly sourcesError: unknown;
  readonly choice: SourceChoice | null;
  readonly sessionsError: unknown;
  readonly page: OnboardingSessionList | null;
  readonly filtered: boolean;
}

/**
 * Which state the page is in.
 *
 * The sources read is checked first and short-circuits: without it there is no
 * product to ask about, and every later branch would be about one nobody
 * chose. There is no fallback slug on any path — see `source-choice.ts`.
 *
 * On the sessions branch `rows` is the parsed list, so an empty one resolves
 * to `empty` or `filtered-empty` — both of which are TRUE, because a read that
 * failed never produces a list at all. That is the whole of the
 * empty-versus-unreadable rule on this surface, and it holds because
 * `parseOnboardingSessions` refuses to turn an unreadable body into `[]`.
 */
export function sessionsPageState(input: SessionsStateInput): SurfaceState {
  if (input.sourcesError) {
    return resolveState({
      isLoading: false,
      error: sourcesReadError(input.sourcesError),
      rows: [],
      filtered: false,
    });
  }
  if (input.choice === null || input.choice.kind === "none-declared") {
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
    error: sessionsReadError(input.sessionsError, input.choice.source),
    rows: input.page?.rows ?? [],
    filtered: input.filtered,
  });
}

/** This surface's own URL, for the sign-in-again return path, so an operator
 *  lands back on the queue they were working. */
export function currentPath(searchParams: OnboardingSearchParams): string {
  return pageHref(searchParams, readPage(searchParams));
}

/** The funnel for the product being listed, carrying the source across so the
 *  two surfaces agree about which product they describe. */
export function funnelLink(choice: SourceChoice | null): string {
  if (choice?.kind !== "source") return ONBOARDING_PATH;
  return `${ONBOARDING_PATH}?${new URLSearchParams({ [SOURCE_PARAM]: choice.source }).toString()}`;
}

export default async function OnboardingSessionsPage({
  searchParams,
}: {
  searchParams: Promise<OnboardingSearchParams>;
}) {
  const resolved = await searchParams;
  const filters = readSessionFilters(resolved);
  const pageNumber = readPage(resolved);

  let sources: PlatformSources | null = null;
  let sourcesError: unknown = null;
  try {
    sources = await fetchPlatformSources();
  } catch (caught) {
    sourcesError = caught;
  }

  const declared = sources ? slugsDeclaring(sources, ONBOARDING_ENDPOINT) : [];
  const choice = sources ? chooseSource(declared, requestedSource(resolved)) : null;

  let sessions: OnboardingSessionList | null = null;
  let sessionsError: unknown = null;
  if (choice?.kind === "source") {
    try {
      sessions = await fetchOnboardingSessions(choice.source, filters, pageNumber);
    } catch (caught) {
      // Caught rather than thrown on to the error boundary: a 400 from a
      // mistyped date and a 501 from an unfederated estate are both states
      // this page renders, and neither deserves a blank screen.
      sessionsError = caught;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Onboarding sessions"
        description="Every signup behind the funnel's counts, newest activity first."
      />

      <p className="text-sm">
        <Link className="underline underline-offset-4" href={funnelLink(choice)}>
          Back to the funnel
        </Link>
      </p>

      <SessionsView
        descriptors={SESSION_FILTERS}
        values={toFilterValues(filters)}
        source={choice?.kind === "source" ? choice.source : null}
        rows={sessions?.rows ?? []}
        total={sessions?.total ?? 0}
        pager={sessionsPager(
          resolved,
          pageNumber,
          sessions?.rows.length ?? 0,
          sessions?.total ?? 0,
          sessions?.limit ?? null,
          ONBOARDING_SESSIONS_LIMIT,
        )}
        state={sessionsPageState({
          sourcesError,
          choice,
          sessionsError,
          page: sessions,
          filtered: isFiltered(filters),
        })}
        emptyMessage={SESSIONS_EMPTY_MESSAGE}
        scopeNote={SESSIONS_SCOPE_NOTE}
        reauthReturnTo={currentPath(resolved)}
      />
    </div>
  );
}
