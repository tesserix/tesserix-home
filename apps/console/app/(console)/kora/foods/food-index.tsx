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
import type { EntityPage } from "@/lib/entities";
import type { PagerLinks } from "../entity-page";

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
  pager: PagerLinks;
  state: SurfaceState;
  emptyMessage: string;
  scopeNote: string;
  reauthReturnTo: string;
}

export function FoodIndex({
  descriptors,
  values,
  page,
  pager,
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
                  <TableCell>
                    <div className="font-medium">{row.label}</div>
                    {/* The brand, where Kora sends one. Rendered only when
                        present: a placeholder would make "this product sends
                        no sublabel" look like "this food has no brand". */}
                    {row.sublabel ? (
                      <div className="text-xs text-muted-foreground">{row.sublabel}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                    {formatCreated(row.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {/* A RANGE ("51–100 of 6421"), not a bare count: with a count
              alone every page reads the same and an operator cannot tell
              which one they are on. ResultPager also carries aria-live, so a
              screen-reader user hears the new position after paging. */}
          <ResultPager
            label="foods"
            count={data.length}
            total={pagination.total}
            precedingCount={pager.precedingCount}
            nextHref={pager.nextHref}
            previousHref={pager.previousHref}
          />
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
