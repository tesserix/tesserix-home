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
import { formatCreated } from "../foods/food-index";
import type { EntityPage } from "@/lib/entities";
import type { PagerLinks } from "../entity-page";

/**
 * The client half of Kora's user directory.
 *
 * `formatCreated` is imported from the food index rather than copied: both
 * render the same §4.3 timestamp from the same endpoint, and a second copy is
 * a second place for the "render an unparseable date verbatim" rule to drift
 * out of.
 */

export interface UserDirectoryProps {
  descriptors: FilterDescriptor[];
  values: FilterValues;
  page: EntityPage;
  pager: PagerLinks;
  state: SurfaceState;
  emptyMessage: string;
  scopeNote: string;
  reauthReturnTo: string;
}

export function UserDirectory({
  descriptors,
  values,
  page,
  pager,
  state,
  emptyMessage,
  scopeNote,
  reauthReturnTo,
}: UserDirectoryProps) {
  const { set, clear } = useUrlFilters(descriptors);
  const { data, pagination } = page;

  return (
    <div className="flex flex-col gap-4">
      <FilterBar descriptors={descriptors} values={values} onChange={set} onClear={clear} />

      {state.kind === "ready" ? (
        <>
          <Table aria-label="Kora users">
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="font-medium">{row.label}</div>
                    {/* The handle, or the email where there is no handle.
                        THIS is why the sublabel is carried at all: display
                        names are not unique, so two users called "Mahesh"
                        render identically without it and an operator has no
                        way to tell them apart. Rendered only when present —
                        a placeholder would make "this product sends no
                        sublabel" look like "this user has no handle". */}
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
          {/* A range, not a bare count — see the food index. */}
          <ResultPager
            label="users"
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
