"use client";

import {
  FilterBar,
  useUrlFilters,
  type FilterDescriptor,
  type FilterValues,
} from "@/components/kit/filter-bar";
import { QueueList, type QueueItem } from "@/components/kit/queue-list";
import { ResultPager } from "@/components/kit/result-pager";
import type { SurfaceState } from "@/components/kit/surface-state";
import { DUE_CURSOR_PARAM, DRIFT_CURSOR_PARAM } from "./cursor-params";

/**
 * A filter mutation drops BOTH queue cursors, not just the one being paged:
 * one filter bar drives both queues, so a narrowed filter invalidates every
 * position on the page at once. Leaving either cursor behind lands that queue
 * on a page of a result set that no longer has one — indistinguishable, on
 * screen, from "nothing matches".
 *
 * A module constant so the hook's memoised `push` keeps a stable identity.
 */
const QUEUE_CURSOR_PARAMS = [DUE_CURSOR_PARAM, DRIFT_CURSOR_PARAM] as const;

export interface CrmQueueGroupProps {
  heading: string;
  /** What this queue's pager calls itself, lower-case ("the due queue").
   *  Distinct per group: two pagers share this page, and a screen reader
   *  user listing links would otherwise hear "Next, Next". */
  pagerLabel: string;
  items: QueueItem[];
  state: SurfaceState;
  emptyMessage: string;
  /** Rows matching this queue's predicate and the current filters, ignoring
   *  the page limit. The number that was missing: this surface rendered 100
   *  of 259 drifting organisations and said nothing about the other 159. */
  total: number;
  /** Matching rows sorting ahead of this page; 0 on the first page. */
  precedingCount: number;
  /** Where this queue's next page lives, with the other queue's cursor and
   *  every filter carried over by `buildQueueNextHref`; `null` on the last
   *  page. */
  nextHref: string | null;
  /** The same for this queue's previous page, built by
   *  `buildQueuePreviousHref`; `null` on the first page. Required for the
   *  reason `OrganisationsViewProps.previousHref` records: a forgotten prop
   *  and a genuine first page must not look the same. */
  previousHref: string | null;
}

export interface CrmQueueViewProps {
  descriptors: FilterDescriptor[];
  /**
   * The filters the server actually applied, not what the URL happens to
   * say — see `QueueView`'s equivalent prop in the tickets surface for why
   * the two can differ.
   */
  values: FilterValues;
  due: CrmQueueGroupProps;
  drifting: CrmQueueGroupProps;
}

/**
 * One queue's rows, headed and — when there are rows — paged.
 *
 * The pager renders only in the `ready` state. In `empty` and
 * `filtered-empty` the group's own message is the whole answer, and a
 * "0–0 of 0" beside it would read as a surface that lost its rows rather
 * than one with nothing waiting; in `error` and
 * `instrumentation-unavailable` the counts describe a read that never
 * happened, so displaying them would be a fabricated number.
 */
function QueueSection({ group, onClearFilters }: { group: CrmQueueGroupProps; onClearFilters: () => void }) {
  return (
    <>
      {group.state.kind === "ready" ? (
        <ResultPager
          label={group.pagerLabel}
          count={group.items.length}
          total={group.total}
          precedingCount={group.precedingCount}
          nextHref={group.nextHref}
          previousHref={group.previousHref}
        />
      ) : null}
      <QueueList
        items={group.items}
        state={group.state}
        emptyMessage={group.emptyMessage}
        onClearFilters={onClearFilters}
      />
    </>
  );
}

/**
 * The client half of the CRM queue.
 *
 * One `FilterBar` drives both groups — Due and Drifting answer the same
 * question ("which of my leads need attention") under one set of filters, not
 * two independently-scoped ones. `FilterBar` and `QueueList` both take
 * callbacks a server component cannot supply, so this boundary exists for the
 * same reason `tickets/queue-view.tsx` does: the page stays a server
 * component, and only this file touches the URL-filter hook.
 *
 * Paging, by contrast, is per-group: each section carries its own pager,
 * inside its own `<section>` under its own heading, so which queue a "Next"
 * belongs to is never a matter of proximity.
 */
export function CrmQueueView({ descriptors, values, due, drifting }: CrmQueueViewProps) {
  const { set, clear } = useUrlFilters(descriptors, QUEUE_CURSOR_PARAMS);

  return (
    <div className="flex flex-col gap-6">
      <FilterBar descriptors={descriptors} values={values} onChange={set} onClear={clear} />

      {/* Due and Drifting are rendered as separate, separately-headed groups
          rather than merged into one list: merging them would make a
          rule-surfaced lead (drifting) indistinguishable from one an operator
          deliberately scheduled (due). */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{due.heading}</h2>
        <QueueSection group={due} onClearFilters={clear} />
      </section>

      {/* Quieter, and rendered below: this is a rule surfacing silence, not
          something anyone scheduled. */}
      <section className="flex flex-col gap-3 opacity-90">
        <h2 className="text-sm font-medium text-muted-foreground">{drifting.heading}</h2>
        <QueueSection group={drifting} onClearFilters={clear} />
      </section>
    </div>
  );
}
