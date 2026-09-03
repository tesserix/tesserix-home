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
// `import type` only — never a value import. `surface-state.ts` is reachable
// from server-only modules, and a client component importing a VALUE from it
// would drag that chain into the browser bundle. tsc and vitest cannot see
// this; only `next build` fails — see `[product]/overview-view.tsx`'s note.
import type { SurfaceState } from "@/components/kit/surface-state";
import type { EntityPage } from "@/lib/entities";
import type { PagerLinks } from "../../kora/entity-page";
import { formatCreated } from "../../kora/foods/food-index";

/**
 * The client half of the generic entity index.
 *
 * A client component because `FilterBar` takes callbacks a server component
 * cannot supply. The page stays a server component so the read happens on the
 * server and the search stays server-side — the same split Kora's two index
 * surfaces make.
 *
 * `formatCreated` is imported rather than copied, for the reason Kora's user
 * directory gives at its own import of it: every §3.4 index renders the same
 * §4.3 timestamp from the same endpoint, and a second copy is a second place
 * for the "render an unparseable date verbatim" rule to drift out of.
 *
 * # No per-product or per-type columns
 *
 * `EntityRecord` is normalized by contract §3.4 — the same fields arrive for
 * every product and every type — so the two columns below are all there are.
 * The heading over the first is the type's name so an operator can tell which
 * index they are on; nothing else varies.
 */

export interface EntityIndexProps {
  descriptors: FilterDescriptor[];
  values: FilterValues;
  /** The table's accessible name, e.g. "Mark8ly tenants". */
  tableLabel: string;
  /** The first column's heading — the entity type as a heading reads it. */
  recordHeading: string;
  page: EntityPage;
  pager: PagerLinks;
  state: SurfaceState;
  emptyMessage: string;
  scopeNote: string;
  /** Where to send the operator back to after re-authenticating. */
  reauthReturnTo: string;
}

export function EntityIndex({
  descriptors,
  values,
  tableLabel,
  recordHeading,
  page,
  pager,
  state,
  emptyMessage,
  scopeNote,
  reauthReturnTo,
}: EntityIndexProps) {
  const { set, clear } = useUrlFilters(descriptors);
  const { data, pagination } = page;

  return (
    <div className="flex flex-col gap-4">
      <FilterBar descriptors={descriptors} values={values} onChange={set} onClear={clear} />

      {state.kind === "ready" ? (
        <>
          {/* A range, not a bare count — see the food index. Above the table,
              matching every other index in the console. */}
          <ResultPager
            label="records"
            count={data.length}
            total={pagination.total}
            precedingCount={pager.precedingCount}
            nextHref={pager.nextHref}
            previousHref={pager.previousHref}
          />
          <Table aria-label={tableLabel}>
            <TableHeader>
              <TableRow>
                <TableHead>{recordHeading}</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="font-medium">{row.label}</div>
                    {/* Rendered only when present. §3.4 never defines this
                        field and mark8ly emits none, so a placeholder would
                        make "this product sends no sublabel" look like "this
                        record has none". */}
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
