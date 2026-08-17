"use client";

import {
  FilterBar,
  useUrlFilters,
  type FilterDescriptor,
  type FilterValues,
} from "@/components/kit/filter-bar";
import { QueueList, type QueueItem } from "@/components/kit/queue-list";
import type { SurfaceState } from "@/components/kit/surface-state";

export interface CrmQueueGroupProps {
  heading: string;
  items: QueueItem[];
  state: SurfaceState;
  emptyMessage: string;
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
 * The client half of the CRM queue.
 *
 * One `FilterBar` drives both groups — Due and Drifting answer the same
 * question ("which of my leads need attention") under one set of filters, not
 * two independently-scoped ones. `FilterBar` and `QueueList` both take
 * callbacks a server component cannot supply, so this boundary exists for the
 * same reason `tickets/queue-view.tsx` does: the page stays a server
 * component, and only this file touches `useUrlFilters`.
 */
export function CrmQueueView({ descriptors, values, due, drifting }: CrmQueueViewProps) {
  const { set, clear } = useUrlFilters(descriptors);

  return (
    <div className="flex flex-col gap-6">
      <FilterBar descriptors={descriptors} values={values} onChange={set} onClear={clear} />

      {/* Due and Drifting are rendered as separate, separately-headed groups
          rather than merged into one list: merging them would make a
          rule-surfaced lead (drifting) indistinguishable from one an operator
          deliberately scheduled (due). */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{due.heading}</h2>
        <QueueList
          items={due.items}
          state={due.state}
          emptyMessage={due.emptyMessage}
          onClearFilters={clear}
        />
      </section>

      {/* Quieter, and rendered below: this is a rule surfacing silence, not
          something anyone scheduled. */}
      <section className="flex flex-col gap-3 opacity-90">
        <h2 className="text-sm font-medium text-muted-foreground">{drifting.heading}</h2>
        <QueueList
          items={drifting.items}
          state={drifting.state}
          emptyMessage={drifting.emptyMessage}
          onClearFilters={clear}
        />
      </section>
    </div>
  );
}
