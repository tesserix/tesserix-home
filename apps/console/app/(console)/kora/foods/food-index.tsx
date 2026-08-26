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
import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
import type { EntityPage } from "@/lib/entities";

/**
 * The client half of Kora's food index.
 *
 * A client component because `FilterBar` takes callbacks a server component
 * cannot supply. The page stays a server component so the read happens on the
 * server and the search stays server-side — the same split as the tenant
 * directory.
 */

/** Renders a §4.3 timestamp, falling back to the raw value.
 *
 *  Verbatim rather than "unknown" on an unparseable date: the product sent
 *  something, and showing what it sent is how someone finds out what is wrong
 *  with it. Inventing a placeholder hides a contract deviation. */
export function formatCreated(value: string | undefined): string {
  if (!value) return "—";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toISOString().slice(0, 10);
}

export interface FoodIndexProps {
  descriptors: FilterDescriptor[];
  values: FilterValues;
  page: EntityPage;
  state: SurfaceState;
  emptyMessage: string;
  scopeNote: string;
  reauthReturnTo: string;
}

export function FoodIndex({
  descriptors,
  values,
  page,
  state,
  emptyMessage,
  scopeNote,
  reauthReturnTo,
}: FoodIndexProps) {
  const { set, clear } = useUrlFilters(descriptors);
  const { data, pagination } = page;

  return (
    <div className="flex flex-col gap-4">
      <FilterBar descriptors={descriptors} values={values} onChange={set} onClear={clear} />

      {state.kind === "ready" ? (
        <>
          <Table aria-label="Foods">
            <TableHeader>
              <TableRow>
                <TableHead>Food</TableHead>
                <TableHead>Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.label}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                    {formatCreated(row.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">
            {/* The product's own count, which is far larger than a page: Kora
                reports 6421 foods. Saying "showing N of M" beats leaving
                someone to read a row count that stops at the page bound as the
                whole index. */}
            {pagination.total === data.length
              ? `${pagination.total} foods.`
              : `Showing ${data.length} of ${pagination.total} foods.`}{" "}
            {scopeNote}
          </p>
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
