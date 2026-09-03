"use client";

import { Fragment, useCallback, useState } from "react";
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
import { formatCreated } from "@/components/kit/entity-format";
import type { PagerLinks } from "@/components/kit/entity-page";

/**
 * The client half of Kora's food index.
 *
 * A client component because `FilterBar` takes callbacks a server component
 * cannot supply. The page stays a server component so the read happens on the
 * server and the search stays server-side — the same split as the tenant
 * directory.
 */

// Re-exported, not redefined: `formatCreated` moved to `components/kit` when
// the generic `[product]/[entity]` index became its third caller, and this
// module keeps the name so `page.test.tsx` and anything else reaching for it
// here is unaffected by where it now lives.
export { formatCreated };

/**
 * The id of the detail row a given food's trigger controls.
 *
 * Derived from the record id, which is the only thing on the row guaranteed
 * unique — an index-derived id collides the moment a page re-orders, and a
 * label-derived one collides on two foods sharing a name, which is exactly the
 * case the sublabel exists for. Record ids carry a colon (`kora:528ea893`);
 * that is legal in an HTML id and `getElementById` resolves it, so it is kept
 * verbatim rather than sanitised — a sanitiser is another way to collide.
 */
function detailRowId(recordId: string): string {
  return `food-detail-${recordId}`;
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

  /**
   * Which rows are expanded.
   *
   * Deliberately NOT in the URL: this is a peek at a row, not a location, and
   * a query param for it would collide with the pager's own params. It is also
   * per-render by design — paging away drops it, which is the honest result
   * for state that describes rows this page no longer shows.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = useCallback((recordId: string) => {
    setExpanded((current) => {
      // A NEW Set every time. Calling `.add()` on the held one hands React the
      // same reference, so it skips the re-render and the row never opens —
      // and the repo's immutability rule exists to stop exactly this.
      const next = new Set(current);
      if (next.has(recordId)) next.delete(recordId);
      else next.add(recordId);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <FilterBar descriptors={descriptors} values={values} onChange={set} onClear={clear} />

      {state.kind === "ready" ? (
        <>
          {/* A RANGE ("51–100 of 6421"), not a bare count: with a count
              alone every page reads the same and an operator cannot tell
              which one they are on. ResultPager also carries aria-live, so a
              screen-reader user hears the new position after paging.

              Above the table, matching the two CRM surfaces. */}
          <ResultPager
            label="foods"
            count={data.length}
            total={pagination.total}
            precedingCount={pager.precedingCount}
            nextHref={pager.nextHref}
            previousHref={pager.previousHref}
          />
          <Table aria-label="Foods">
            <TableHeader>
              <TableRow>
                <TableHead>Food</TableHead>
                <TableHead>Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row) => {
                const isExpanded = expanded.has(row.id);
                const detailId = detailRowId(row.id);
                return (
                  <Fragment key={row.id}>
                    <TableRow>
                      <TableCell>
                        {/* The label is the trigger, and it is a real
                            <button>: a click handler on the row is
                            unreachable by keyboard and invisible to a screen
                            reader. There is no /kora/foods/[id] to link to —
                            the contract registers a list pattern only, so a
                            detail route would be a URL with nothing behind
                            it. Expanding in place shows the rest of the
                            record without implying a page that does not
                            exist. */}
                        <button
                          type="button"
                          onClick={() => toggle(row.id)}
                          aria-expanded={isExpanded}
                          aria-controls={detailId}
                          className="text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          {row.label}
                        </button>
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
                    {/* Rendered only while expanded, so aria-controls never
                        points at a hidden row a screen reader would offer to
                        jump to. The three fields here are precisely what the
                        console holds and the table does not already show —
                        `EntityRecord` is the whole record, there is no
                        get-one to fetch more from. */}
                    {isExpanded ? (
                      <TableRow id={detailId}>
                        <TableCell colSpan={2} className="bg-muted/30">
                          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                            <dt className="text-muted-foreground">Record id</dt>
                            <dd className="font-mono">{row.id}</dd>
                            <dt className="text-muted-foreground">Source</dt>
                            <dd>{row.source}</dd>
                            <dt className="text-muted-foreground">Type</dt>
                            <dd>{row.type}</dd>
                          </dl>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
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
