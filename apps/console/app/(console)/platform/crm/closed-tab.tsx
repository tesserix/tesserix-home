import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
// Imported from `surface-state` and not from `states`, for the reason
// `page.tsx` records: this module renders on the server.
import { resolveState } from "@/components/kit/surface-state";
import { dbReadError } from "@/lib/db-read-error";
import {
  closedOpportunities,
  type ClosedPage,
  type ClosedRow,
  type QueueFilter,
} from "@/lib/db/crm-repo";
import { CLOSED_CURSOR_PARAM } from "./cursor-params";
import { ClosedView, type ClosedItem } from "./closed-view";
import { productLabel } from "./product-label";
import {
  buildQueueNextHref,
  buildQueuePreviousHref,
  readCursor,
  type QueueSearchParams,
} from "./url";

/**
 * The Closed tab: won and lost deals, the two stages every other CRM surface
 * excludes.
 *
 * Reads Postgres directly rather than going through `lib/crm-queues.ts`. That
 * seam exists for the two work queues, which the Go platform-api serves; a
 * closed list is not among its routes, and `listOrganisations`,
 * `organisationDetail` and `wonWithoutConversion` all read Postgres directly
 * too. Adding a read to the seam would mean a wire contract on both sides for
 * a list only one side has.
 */

const CLOSED_LIMIT = 100;

/** The page a rejected read stands in for: no rows, and counts that claim
 *  nothing. The list renders its error state, so these are never displayed —
 *  they exist so the render below has one shape to read rather than a union.
 *  Same stand-in `page.tsx` keeps for the work queues. */
const NO_PAGE: ClosedPage = {
  rows: [],
  total: 0,
  precedingCount: 0,
  nextCursor: null,
  previousCursor: null,
};

/** The `empty` copy for this tab, exported so tests assert on the string the
 *  page ships rather than a second copy of it that could drift. */
export const CLOSED_EMPTY_MESSAGE =
  "Nothing closed yet. Won and lost deals will be listed here.";

/** A row as the table reads it. The stage becomes a label and a tone here,
 *  on the server, because `ClosedView` is a client component and the two
 *  admissible stages are already known. */
export function toClosedItem(row: ClosedRow): ClosedItem {
  return {
    key: row.id,
    organisationId: row.organisationId,
    organisationName: row.organisationName,
    product: productLabel(row.product),
    stageLabel: row.stage === "won" ? "Won" : "Lost",
    // The same tones `stageStatus` gives these two stages on the work
    // queues, so one deal does not change colour between surfaces.
    stageTone: row.stage === "won" ? "success" : "error",
    owner: row.owner,
    closedAt: row.closedAt,
    lostReason: row.lostReason,
  };
}

/**
 * The Closed tab's content. A plain awaited function, not a nested async
 * component — see `renderWorkTab` in `page.tsx` for the testability reason —
 * and only ever called while this tab is the active one.
 *
 * `descriptors` and `values` are passed in rather than built here: the filter
 * descriptors are the page's, with only the stage select's options differing
 * per tab, and `readQueueFilters` has already decided which of the URL's
 * values this tab admits.
 */
export async function renderClosedTab({
  searchParams,
  descriptors,
  values,
  filters,
  filtered,
  reauthReturnTo,
}: {
  searchParams: QueueSearchParams;
  descriptors: FilterDescriptor[];
  values: FilterValues;
  filters: QueueFilter;
  filtered: boolean;
  reauthReturnTo: string;
}) {
  let page: ClosedPage = NO_PAGE;
  let error: unknown = null;
  try {
    // The filters and the cursor are passed into the read, not applied to
    // its result: filtering or paging the returned page in TypeScript would
    // answer "rows matching among the first N overall" (Ruling 11), and a
    // malformed cursor is rejected by the repo — which lands here as this
    // list's error state rather than as an unhandled 500.
    page = await closedOpportunities(
      filters,
      CLOSED_LIMIT,
      readCursor(searchParams, CLOSED_CURSOR_PARAM),
    );
  } catch (caught) {
    error = caught;
  }

  const items = page.rows.map(toClosedItem);

  return (
    <ClosedView
      descriptors={descriptors}
      values={values}
      items={items}
      state={resolveState({
        // The page awaits the read before rendering; there is no client-side
        // pending window here.
        isLoading: false,
        error: dbReadError(error, "the closed list"),
        rows: items,
        filtered,
      })}
      emptyMessage={CLOSED_EMPTY_MESSAGE}
      total={page.total}
      precedingCount={page.precedingCount}
      nextHref={buildQueueNextHref(searchParams, CLOSED_CURSOR_PARAM, page.nextCursor)}
      previousHref={buildQueuePreviousHref(
        searchParams,
        CLOSED_CURSOR_PARAM,
        page.previousCursor,
      )}
      reauthReturnTo={reauthReturnTo}
    />
  );
}
