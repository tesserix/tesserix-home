"use client";

import {
  FilterBar,
  useUrlFilters,
  type FilterDescriptor,
  type FilterValues,
} from "@/components/kit/filter-bar";
import { QueueList, type QueueItem } from "@/components/kit/queue-list";
import type { SurfaceState } from "@/components/kit/surface-state";

export interface QueueViewProps {
  descriptors: FilterDescriptor[];
  /**
   * The filters the server actually applied, not what the URL happens to say.
   * The two differ when a URL carries a value no descriptor offers: the page
   * ignores it when fetching, so the bar must show it as unset too. Reading
   * the URL again here would render a filter that is not in effect.
   */
  values: FilterValues;
  items: QueueItem[];
  state: SurfaceState;
  emptyMessage: string;
}

/**
 * The client half of the queue.
 *
 * `FilterBar` and `QueueList` both take callbacks, which a server component
 * cannot supply, so the two live behind this one boundary rather than the page
 * becoming a client component to get a filter bar — that would move the fetch
 * to the browser and cost the server-side filtering the whole design relies on.
 *
 * Values come down as props; only the mutations use `useUrlFilters`, whose job
 * here is to write the URL. The navigation re-runs the server component, which
 * re-fetches with the new query.
 */
export function QueueView({
  descriptors,
  values,
  items,
  state,
  emptyMessage,
}: QueueViewProps) {
  const { set, clear } = useUrlFilters(descriptors);

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        descriptors={descriptors}
        values={values}
        onChange={set}
        onClear={clear}
      />
      <QueueList
        items={items}
        state={state}
        emptyMessage={emptyMessage}
        onClearFilters={clear}
      />
    </div>
  );
}
