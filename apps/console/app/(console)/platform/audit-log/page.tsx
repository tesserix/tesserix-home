import { cookies } from "next/headers";
import { ConsolePageHeader } from "@/components/kit/page-header";
import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
// Imported from `surface-state` and NOT from `states`: this is a server
// component, and `states.tsx` carries a load-bearing `"use client"` that turns
// every one of its exports into a client reference. Calling `resolveState`
// through that reference throws at runtime while tsc, `next build` and jsdom
// tests all pass — it 500'd the dashboard once.
import {
  NOT_IMPLEMENTED,
  resolveState,
  toSurfaceError,
  type SurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import {
  AUDIT_SOURCES,
  CONSOLE_SOURCE,
  includesConsoleSource,
  isAuditSource,
  mergeTimeline,
  sourceLabel,
  upstreamProductFor,
  withSourcePrefix,
  type AuditEntry,
  type AuditSource,
  type AuditSourceFailure,
} from "@/lib/audit";
import { AUDIT_LIMIT, PlatformApiError, fetchEstateAuditLog } from "@/lib/platform-api";
import { recentAuditEntries } from "@/lib/db/audit-repo";
import { isDatabaseConfigured } from "@/lib/db/tesserix";
import { AuditTimeline, type SourceNotice } from "./audit-timeline";

/**
 * The estate's audit timeline — every product's audit trail and the console's
 * own operator log, merged newest-first (#139).
 *
 * Two reads, deliberately unequal in kind:
 *
 *   products — apps/web's `/api/admin/apps/all/audit-logs`. ONE request, not
 *              three: the fan-out to mark8ly, kora-api and homechef-api lives
 *              behind that endpoint, along with the partial-failure semantics
 *              that make "one product is down" expressible.
 *   console  — `console_audit_log`, read straight from tesserix-postgres.
 *
 * The console's own actions are one source among several, not a separate page.
 * An operator asking "who touched this" should not have to know which system
 * happened to record the answer.
 *
 * ON FILTERING — why there is a source filter and no actor filter.
 *
 * The plan asked for product AND actor. Product shipped; actor did not, and the
 * omission is the finding rather than a shortcut.
 *
 * A source filter is exact: it changes WHICH SOURCES ARE QUERIED, upstream, so
 * every row the surface then shows is still every row that source has. An
 * actor filter cannot be exact here. kora-api's `/v1/admin/events` accepts no
 * actor parameter at all and homechef's audit endpoint accepts none either, so
 * an actor filter could only be honoured by mark8ly and by `console_audit_log`
 * — the two sources that happen to have the column. Applying it would produce a
 * timeline that reads "3 events by alice" when Kora was never asked about
 * alice at all.
 *
 * On any other surface that is a nuisance. On an audit log it is a false
 * negative, and a false negative in an audit log is evidence of absence that
 * is not evidence of anything. The alternative — post-filtering the 200 rows
 * already fetched — is worse in the same direction: it narrows the first 200
 * events rather than the first 200 matching ones, so "no results" would mean
 * "not in the recent window" while looking exactly like "never happened".
 *
 * So: filter by source, where the filter is honest, and say on the page that
 * actor filtering is not offered yet. It comes back when the upstreams take an
 * actor parameter — that is a change in kora-api and homechef-api first.
 */

/** Copy for the `empty` state. Exported so the test asserts the shipped string. */
export const TIMELINE_EMPTY_MESSAGE =
  "No audit events recorded. Nothing has been done that any source logs.";

/**
 * The honest limit of what is on screen, rendered under the list.
 *
 * Two different truncations, and they are not the same shape, which is why
 * this is stated rather than implied: the products' aggregate is asked for the
 * last 30 days (its own maximum window) capped at 200 rows, while
 * `console_audit_log` is read as "the most recent 200" with no window at all.
 * A busy source therefore reaches back less far than a quiet one. Saying so
 * costs a line; not saying so lets an operator read the oldest row on screen as
 * the oldest row that exists.
 */
export const TIMELINE_SCOPE_NOTE =
  `Most recent ${AUDIT_LIMIT} events per source — products over the last 30 days, ` +
  "the console's own log unbounded. A busy source reaches back less far than a quiet one. " +
  "Filtering by actor is not offered: two of the three product upstreams cannot filter on it, " +
  "so the result would be silently incomplete.";

/** Label for the products aggregate when it is read as a whole. */
export const ALL_PRODUCTS_LABEL = "Product audit trails";

/**
 * The one filter this surface offers.
 *
 * Options are the sources that genuinely exist, not the estate: four of
 * ESTATE's seven products have no audit source, and offering one would send a
 * product id the endpoint answers 404 for. `console` is in the same list as
 * the products on purpose — it is a source, not a mode.
 */
export const AUDIT_FILTERS: FilterDescriptor[] = [
  {
    key: "source",
    label: "Source",
    type: "select",
    options: AUDIT_SOURCES.map((source) => ({
      value: source,
      label: sourceLabel(source),
    })),
  },
];

export type AuditSearchParams = Record<string, string | string[] | undefined>;

/**
 * Read the source filter out of the URL.
 *
 * `null` means "every source". An unrecognised value is dropped rather than
 * forwarded, for the same reason the ticket queue drops one: passing it
 * upstream returns nothing and renders `filtered-empty`, which tells the
 * operator "nothing matches" when the truth is "that source does not exist".
 * A repeated param arrives as an array and is ignored likewise.
 */
export function readAuditSource(searchParams: AuditSearchParams): AuditSource | null {
  const raw = searchParams.source;
  if (typeof raw !== "string" || raw === "") return null;
  return isAuditSource(raw) ? raw : null;
}

/** The applied filter as the bar's display value. */
export function toFilterValues(source: AuditSource | null): FilterValues {
  return source === null ? {} : { source };
}

/**
 * The state of ONE source's read, used only for its notice.
 *
 * Rows are deliberately empty: this asks "could this source be read", never
 * "did it have anything to say". A source that answered with nothing is not
 * worth a banner, so `empty` is the kind the caller drops.
 */
export function sourceState(error: unknown): SurfaceState {
  return resolveState({
    isLoading: false,
    error: toSurfaceError(error),
    rows: [],
    filtered: false,
  });
}

export interface TimelineStateInput {
  /** Whatever `fetchEstateAuditLog` rejected with, or null. */
  upstreamError: unknown;
  /** Whatever the `console_audit_log` read rejected with, or null. */
  consoleError: unknown;
  rows: readonly AuditEntry[];
  filtered: boolean;
}

/**
 * Which state the merged timeline is in.
 *
 * The rule that matters: **any rows at all means the timeline renders them.**
 * A failed source is reported beside the list, never instead of it. The
 * console's own log is served by a database the products' upstreams cannot
 * touch, so a parked kora-api must not blank out rows that were read
 * successfully — that coupling is precisely what a single shared state would
 * introduce.
 *
 * With no rows and more than one failure, a GENUINE error wins over a 501.
 * "Not instrumented" is the gentler claim, and making it while something is
 * actually broken understates an outage in the one place understatement is
 * expensive.
 */
export function timelineState(input: TimelineStateInput): SurfaceState {
  if (input.rows.length > 0) {
    return resolveState({
      isLoading: false,
      error: null,
      rows: input.rows,
      filtered: input.filtered,
    });
  }

  const errors: SurfaceError[] = [input.upstreamError, input.consoleError]
    .map((caught) => (caught === null || caught === undefined ? null : toSurfaceError(caught)))
    .filter((error): error is SurfaceError => error !== null);

  const genuine = errors.find((error) => error.status !== NOT_IMPLEMENTED);

  return resolveState({
    isLoading: false,
    error: genuine ?? errors[0] ?? null,
    rows: [],
    filtered: input.filtered,
  });
}

export interface NoticeInput {
  readonly upstreamError: unknown;
  readonly consoleError: unknown;
  /** Which upstream product was asked, or null when it was not called. */
  readonly upstreamProduct: string | null;
  /** Whether the console's own log was read at all. */
  readonly consoleQueried: boolean;
}

/**
 * One notice per source whose read failed outright.
 *
 * `empty` and `ready` are dropped: a source that answered needs no banner, and
 * a source that was not queried (because the filter excluded it) has nothing to
 * report — showing "Kora unavailable" on a view filtered to the console would
 * be a warning about data the operator did not ask for.
 */
export function buildSourceNotices(input: NoticeInput): SourceNotice[] {
  const notices: SourceNotice[] = [];

  if (input.upstreamProduct !== null) {
    const state = sourceState(input.upstreamError);
    if (state.kind === "error" || state.kind === "instrumentation-unavailable") {
      notices.push({
        source: input.upstreamProduct,
        label:
          input.upstreamProduct === "all"
            ? ALL_PRODUCTS_LABEL
            : sourceLabel(input.upstreamProduct),
        state,
      });
    }
  }

  if (input.consoleQueried) {
    const state = sourceState(input.consoleError);
    if (state.kind === "error" || state.kind === "instrumentation-unavailable") {
      notices.push({ source: CONSOLE_SOURCE, label: sourceLabel(CONSOLE_SOURCE), state });
    }
  }

  return notices;
}

/**
 * Read the console's own log.
 *
 * An unconfigured database is turned into a 501 rather than allowed to throw a
 * raw connection error, so it renders as "not measured" instead of as a red
 * failure an operator would retry.
 *
 * Note this is the opposite of the rule `audit-repo` states for the audit
 * WRITE, and deliberately so. There, a missing database must never degrade
 * quietly — degrading means an operation ran unaccounted for. Here nothing is
 * being accounted for; a log is being displayed, and "we cannot show you this
 * source" is a truthful, visible outcome. The asymmetry is the point: writes
 * fail loud, reads degrade visibly.
 */
async function readConsoleEntries(): Promise<AuditEntry[]> {
  if (!isDatabaseConfigured()) {
    throw new PlatformApiError(
      "console audit log: tesserix database is not configured",
      NOT_IMPLEMENTED,
    );
  }
  return recentAuditEntries(AUDIT_LIMIT);
}

export default async function EstateAuditLog({
  searchParams,
}: {
  searchParams: Promise<AuditSearchParams>;
}) {
  const cookieHeader = (await cookies()).toString();
  const source = readAuditSource(await searchParams);
  const filtered = source !== null;

  const upstreamProduct = upstreamProductFor(source);
  const consoleQueried = includesConsoleSource(source);

  // `allSettled`, not `all`: the two sources are independent systems, and
  // `Promise.all` would reject the whole render on the first failure — taking
  // down the source that answered along with the one that did not.
  const [upstreamResult, consoleResult] = await Promise.allSettled([
    upstreamProduct === null
      ? Promise.resolve({ entries: [], failures: [] })
      : fetchEstateAuditLog(cookieHeader, upstreamProduct),
    consoleQueried ? readConsoleEntries() : Promise.resolve([]),
  ]);

  const upstream =
    upstreamResult.status === "fulfilled"
      ? upstreamResult.value
      : { entries: [] as readonly AuditEntry[], failures: [] as readonly AuditSourceFailure[] };
  const upstreamError: unknown =
    upstreamResult.status === "rejected" ? upstreamResult.reason : null;

  const consoleEntries: readonly AuditEntry[] =
    consoleResult.status === "fulfilled" ? consoleResult.value : [];
  const consoleError: unknown =
    consoleResult.status === "rejected" ? consoleResult.reason : null;

  // Prefixed before merging: `console_audit_log.id` is a plain sequence and the
  // products' ids are not guaranteed to be uuids, so without a namespace two
  // systems' primary keys collide on the viewer's React keys. See
  // `withSourcePrefix` for the part of this that the wire shape cannot fix.
  const rows = mergeTimeline(
    withSourcePrefix(upstream.entries, "product"),
    withSourcePrefix(consoleEntries, CONSOLE_SOURCE),
  );

  const state = timelineState({ upstreamError, consoleError, rows, filtered });
  const notices = buildSourceNotices({
    upstreamError,
    consoleError,
    upstreamProduct,
    consoleQueried,
  });

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Audit log"
        description="Every product's audit trail and the console's own operator actions, newest first."
      />

      <AuditTimeline
        descriptors={AUDIT_FILTERS}
        values={toFilterValues(source)}
        entries={rows}
        state={state}
        emptyMessage={TIMELINE_EMPTY_MESSAGE}
        notices={notices}
        failures={upstream.failures}
        scopeNote={TIMELINE_SCOPE_NOTE}
      />
    </div>
  );
}
