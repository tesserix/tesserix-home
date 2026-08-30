// See page-header.tsx: `@tesserix/web`'s barrel is "use client", so its
// exports are `undefined` inside a server component. `FilterBar` also takes
// callbacks a server component cannot supply. This file carries its own
// directive for both reasons.
"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import {
  FilterBar,
  useUrlFilters,
  type FilterDescriptor,
  type FilterValues,
} from "@/components/kit/filter-bar";
import { ResultPager } from "@/components/kit/result-pager";
import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
// `import type` only: `onboarding-sessions.ts` imports `PlatformApiError`, and
// a VALUE import of that class from a client component is how `pg` reached the
// browser bundle once already (see `lib/platform-api-error.ts`'s header).
import type { OnboardingSession } from "@/lib/onboarding-sessions";
import type { SessionsPager } from "./pager";

/**
 * The client half of the onboarding session queue.
 *
 * # Nothing here logs a row
 *
 * Every row is a merchant's email address. platform-api keeps PII out of every
 * failure path and this surface holds the same line: there is no console
 * logging on this component, no row in a `title` or `data-` attribute beyond
 * the id, and no analytics call. The addresses are rendered, which is the
 * point of the surface, and they go nowhere else.
 *
 * # The product's own words
 *
 * `status` is printed verbatim. There is no console-side lookup translating
 * mark8ly's statuses into friendlier copy, for the reason the funnel's stage
 * names are left alone: a table here is a second vocabulary that drifts from
 * the product's the first time the product changes what a status means.
 */

export interface SessionsViewProps {
  descriptors: FilterDescriptor[];
  values: FilterValues;
  /** The product whose queue this is; `null` when none was chosen, in which
   *  case there are no rows either. */
  source: string | null;
  rows: readonly OnboardingSession[];
  total: number;
  pager: SessionsPager;
  state: SurfaceState;
  emptyMessage: string;
  scopeNote: string;
  reauthReturnTo: string;
}

/**
 * An instant, rendered to the minute.
 *
 * Verbatim rather than "unknown" on an unparseable value: the product sent
 * something, and showing what it sent is how somebody finds out what is wrong
 * with it. Inventing a placeholder hides a contract deviation — the same call
 * Kora's `formatCreated` makes, at a finer resolution because this queue is
 * worked within a day rather than browsed by month.
 */
export function formatInstant(value: string | null): string {
  if (!value) return "—";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Idle time, as the product measured it.
 *
 * mark8ly sends fractional hours and this rounds for display only — the number
 * is not recomputed from the timestamps, because the product's own clock
 * decided it and a console-side subtraction would disagree with the
 * `abandoned` flag that was derived from it.
 */
export function formatIdle(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * What became of a session, in one word.
 *
 * Read off the fields the product sent rather than inferred: `completedAt`
 * present means completed, `abandoned` is mark8ly's own judgement, and
 * everything else is still in flight. The order matters — a completed session
 * that was once abandoned is completed, and reporting it as abandoned would
 * put a converted merchant on a chase list.
 */
export function outcomeLabel(row: OnboardingSession): string {
  if (row.completedAt !== null) return "Completed";
  if (row.abandoned) return "Abandoned";
  return "In flight";
}

export function SessionsView({
  descriptors,
  values,
  source,
  rows,
  total,
  pager,
  state,
  emptyMessage,
  scopeNote,
  reauthReturnTo,
}: SessionsViewProps) {
  const { set, clear } = useUrlFilters(descriptors);

  return (
    <div className="flex flex-col gap-4">
      {/* Outside the state branches: when a filter returns nothing readable,
          the way out is to change the filter, so the bar must survive the
          state it caused. */}
      <FilterBar descriptors={descriptors} values={values} onChange={set} onClear={clear} />

      {state.kind === "ready" ? (
        <>
          <ResultPager
            label="onboarding sessions"
            count={rows.length}
            total={total}
            precedingCount={pager.precedingCount}
            nextHref={pager.nextHref}
            previousHref={pager.previousHref}
          />
          <Table aria-label={source ? `${source} onboarding sessions` : "Onboarding sessions"}>
            <TableHeader>
              <TableRow>
                <TableHead>Merchant</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last activity</TableHead>
                <TableHead>Idle</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} data-testid="session-row">
                  <TableCell>
                    <div className="font-medium">{row.email}</div>
                    {/* The tenant this signup became, where it became one. THIS
                        is what turns the queue into an answer: a row with a
                        tenant id converted and needs no chasing. Rendered only
                        when present — a placeholder would make "still a
                        session" look like "the product sent nothing". */}
                    {row.tenantId ? (
                      <div className="text-xs text-muted-foreground">
                        tenant {row.tenantId}
                      </div>
                    ) : null}
                  </TableCell>
                  {/* mark8ly's own word, untranslated. */}
                  <TableCell className="whitespace-nowrap">{row.status}</TableCell>
                  <TableCell className="whitespace-nowrap">{outcomeLabel(row)}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                    {formatInstant(row.createdAt)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                    {formatInstant(row.lastActivityAt)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                    {formatIdle(row.idleHours)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {/* Last, because it describes the result set rather than the
              controls that shape it. */}
          <p className="text-xs text-muted-foreground">{scopeNote}</p>
        </>
      ) : (
        <SurfaceStateView
          state={state}
          emptyMessage={emptyMessage}
          onClearFilters={clear}
          reauthReturnTo={reauthReturnTo}
        />
      )}
    </div>
  );
}
