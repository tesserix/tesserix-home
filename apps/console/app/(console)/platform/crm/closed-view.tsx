"use client";

import Link from "next/link";
import {
  StatusBadge,
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
// `states`, not `surface-state`: this module carries a "use client"
// directive, so `SurfaceStateView` resolves to the real component here.
import { SurfaceStateView, type SurfaceState } from "@/components/kit/states";
import { ALL_CURSOR_PARAMS } from "./cursor-params";

export interface ClosedItem {
  key: string;
  organisationId: string;
  organisationName: string;
  /** The estate's name for the deal's product, or "Unassigned" for a
   *  migrated deal that was never matched to one. Resolved by the page, which
   *  is where `ESTATE` is already in scope. */
  product: string;
  /** "Won" or "Lost". */
  stageLabel: string;
  stageTone: "success" | "error";
  owner: string | null;
  closedAt: string | null;
  lostReason: string | null;
}

export interface ClosedViewProps {
  descriptors: FilterDescriptor[];
  /** The filters the server actually applied, not what the URL happens to
   *  say — the two differ whenever a value was out of range for this tab. */
  values: FilterValues;
  items: readonly ClosedItem[];
  state: SurfaceState;
  emptyMessage: string;
  total: number;
  precedingCount: number;
  nextHref: string | null;
  previousHref: string | null;
  /** Where to send the operator back to after re-authenticating, carrying
   *  the exact URL they were on — see `SurfaceStateView`'s own prop. */
  reauthReturnTo?: string;
}

/** An em dash for a cell with nothing in it — the same muted empty-state
 *  idiom `organisations-view.tsx` uses in its own table cells. */
function Blank() {
  return <span className="text-muted-foreground">—</span>;
}

/**
 * Closed deals, as a table.
 *
 * A table and not a `QueueList`, which is what the two work queues render:
 * that component states its own contract ("Not a table: queue rows are read
 * as units") and renders every row as "waiting {duration}", which is the one
 * thing a finished deal is not doing. A closed deal is read by comparing
 * columns across rows — when it closed, which product, why it was lost — and
 * that is what a table is for.
 */
export function ClosedView({
  descriptors,
  values,
  items,
  state,
  emptyMessage,
  total,
  precedingCount,
  nextHref,
  previousHref,
  reauthReturnTo,
}: ClosedViewProps) {
  const { set, clear } = useUrlFilters(descriptors, ALL_CURSOR_PARAMS);

  return (
    <div className="flex flex-col gap-6">
      <FilterBar descriptors={descriptors} values={values} onChange={set} onClear={clear} />

      {state.kind === "ready" ? (
        <div className="flex flex-col gap-3">
          <ResultPager
            label="closed deals"
            count={items.length}
            total={total}
            precedingCount={precedingCount}
            nextHref={nextHref}
            previousHref={previousHref}
          />
          <Table aria-label="Closed deals">
            <TableHeader>
              <TableRow>
                <TableHead>Organisation</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Closed</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.key}>
                  <TableCell>
                    <Link
                      href={`/platform/crm/${item.organisationId}`}
                      className="font-medium hover:underline"
                    >
                      {item.organisationName}
                    </Link>
                  </TableCell>
                  <TableCell>{item.product}</TableCell>
                  <TableCell>
                    <StatusBadge status={item.stageTone} size="sm">
                      {item.stageLabel}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {/* Null only for a terminal row whose close date was
                        never written (see `ClosedRow.closedAt`). The list
                        still orders it — by the last write to the row — so
                        the blank cell says "we don't know when", not "this
                        row is out of order". */}
                    {item.closedAt ? new Date(item.closedAt).toLocaleDateString() : <Blank />}
                  </TableCell>
                  <TableCell>{item.owner ?? <Blank />}</TableCell>
                  <TableCell>{item.lostReason ?? <Blank />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
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
