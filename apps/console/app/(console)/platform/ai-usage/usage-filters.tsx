"use client";

import {
  FilterBar,
  useUrlFilters,
  type FilterDescriptor,
  type FilterValues,
} from "@/components/kit/filter-bar";

/**
 * The client half of the surface: the filter bar, and nothing else.
 *
 * Same shape as the ticket queue's `QueueView` and for the same reason —
 * `FilterBar` needs callbacks, so it lives behind one boundary rather than the
 * page becoming a client component and moving six server-side reads into the
 * browser with the operator's token attached to them.
 */
export interface UsageFiltersProps {
  descriptors: FilterDescriptor[];
  /** What the server actually applied, not what the URL says — see QueueView. */
  values: FilterValues;
}

export function UsageFilters({ descriptors, values }: UsageFiltersProps) {
  const { set, clear } = useUrlFilters(descriptors);
  return <FilterBar descriptors={descriptors} values={values} onChange={set} onClear={clear} />;
}
