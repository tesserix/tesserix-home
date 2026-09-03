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
// THE RULE: a client component taking a VALUE from a module that reaches
// `lib/platform-api` drags that chain — `lib/auth/platform-token`, `pg` — into
// the browser bundle. tsc and vitest cannot see it; only `next build` fails.
// `[product]/overview-view.tsx` states the same rule at its `kpis.ts` import.
//
// The two `import type`s below are not equally load-bearing, and it is worth
// saying which is which so a later reader does not draw the wrong conclusion
// from finding no chain:
//
//   - `lib/entities.ts` DOES reach `platform-api` — it value-imports
//     `PlatformApiError` from it — so `import type` there is the rule.
//   - `components/kit/surface-state.ts` imports NOTHING at all (its own
//     comment says it is free of `lib/` imports, and a test asserts it pulls
//     in neither React nor `@tesserix/web`). Nothing can be dragged through
//     it, so `import type` there is hygiene, not a fix.
//
// `components/kit/entity-page.ts` value-imports `ENTITIES_LIMIT` from
// `platform-api`, which is why only its TYPE is taken here.
import type { SurfaceState } from "@/components/kit/surface-state";
import type { EntityPage } from "@/lib/entities";
import type { PagerLinks } from "@/components/kit/entity-page";
import { formatCreated } from "@/components/kit/entity-format";

/**
 * The client half of the generic entity index.
 *
 * A client component because `FilterBar` takes callbacks a server component
 * cannot supply. The page stays a server component so the read happens on the
 * server and the search stays server-side — the same split Kora's two index
 * surfaces make.
 *
 * `formatCreated` is imported from `components/kit` rather than copied: every
 * §3.4 index renders the same §4.3 timestamp from the same endpoint, and a
 * second copy is a second place for the "render an unparseable date verbatim"
 * rule to drift out of. It is a five-line pure module of its own — this page
 * deliberately does not reach into Kora's food index for it, which would put
 * `FoodIndex` in this surface's client graph and leave dropping it to
 * tree-shaking.
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
