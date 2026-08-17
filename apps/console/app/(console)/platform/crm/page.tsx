import { ESTATE } from "@tesserix/console-core";
import { ConsolePageHeader } from "@/components/kit/page-header";
import type { QueueItem, QueueStatus, QueueStatusTone } from "@/components/kit/queue-list";
import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
// Imported from `surface-state` and not from `states`: this is a server
// component, and `states.tsx` is a "use client" module whose exports become
// client references that throw when called on the server. See
// `tickets/page.tsx` for the incident this guards against.
import { resolveState, toSurfaceError, type SurfaceState } from "@/components/kit/surface-state";
import { dueOpportunities, driftingOpportunities, type QueueRow } from "@/lib/db/crm-repo";
import { CRM_STAGES, DRIFT_DAYS, isCrmStage, type CrmStage } from "@/lib/crm";
import { CrmQueueView } from "./queue-view";

/**
 * The CRM follow-up queue — everything a sales rep should look at today.
 *
 * Due and Drifting are two separate reads (Task 4) and stay two separate
 * groups here: a lead surfaced by the drift rule (nobody scheduled anything,
 * and the org has gone quiet) reads very differently from one an operator
 * deliberately booked a next action for, and merging them into one list would
 * erase that distinction.
 */

const DUE_LIMIT = 100;
const DRIFTING_LIMIT = 100;

/** The `empty` copy for each group, exported so tests assert on the string
 *  the page ships rather than a second copy of it that could drift. */
export const DUE_EMPTY_MESSAGE = "Nothing due. Nothing needs action right now.";
export const DRIFTING_EMPTY_MESSAGE = "Nothing drifting. Every open lead is either scheduled or fresh.";

const STAGE_LABELS: Record<CrmStage, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  won: "Won",
  lost: "Lost",
};

const STAGE_TONES: Record<CrmStage, QueueStatusTone> = {
  new: "neutral",
  contacted: "info",
  qualified: "info",
  won: "success",
  lost: "error",
};

/** Status badge for a row: the stage, not the severity. */
export function stageStatus(stage: CrmStage): QueueStatus {
  return { label: STAGE_LABELS[stage], tone: STAGE_TONES[stage] };
}

/** The estate's product name for a row's raw context, falling back to the
 *  raw value (or "Unassigned") for a row with no product set yet — `product`
 *  is only required from `qualified` onward. */
function productLabel(product: string | null): string {
  if (!product) return "Unassigned";
  return ESTATE.find((entry) => entry.context === product)?.name ?? product;
}

function subtitleOf(row: QueueRow): string | undefined {
  const parts = [row.owner ? `Owner: ${row.owner}` : null, row.nextActionNote].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * A row's identity is opaque to `QueueList` — this is where a `QueueRow`
 * becomes a `QueueItem`.
 *
 * `waitingSince` is `quietSince`, never `lastContactedAt`: the latter is
 * null for a never-contacted opportunity, while `quietSince` falls back to
 * its creation date in SQL (crm-repo.ts) — the value the drifting query is
 * actually ordered by. Recomputing the fallback here would risk the two
 * copies disagreeing.
 */
export function toQueueItem(row: QueueRow): QueueItem {
  return {
    key: row.id,
    title: row.organisationName,
    subtitle: subtitleOf(row),
    product: productLabel(row.product),
    waitingSince: row.quietSince,
    dueAt: row.nextActionAt ?? undefined,
    // A starred opportunity is one an operator flagged as important; it
    // outranks the group's baseline urgency either way.
    severity: row.isStarred ? "critical" : "normal",
    status: stageStatus(row.stage),
    href: `/platform/crm/${row.organisationId}`,
  };
}

/**
 * The queue's filters.
 *
 * Product options come from the estate, not from whatever rows happen to be
 * on the current page — deriving them from rows would only ever offer the
 * products that already have opportunities, which is the one thing an
 * operator can't already see.
 *
 * Owner is free text: there is no fixed roster to draw a `select` from here.
 */
export const QUEUE_FILTERS: FilterDescriptor[] = [
  {
    key: "product",
    label: "Product",
    type: "select",
    options: ESTATE.map((product) => ({ value: product.context, label: product.name })),
  },
  {
    key: "stage",
    label: "Stage",
    type: "select",
    options: CRM_STAGES.map((stage) => ({ value: stage, label: STAGE_LABELS[stage] })),
  },
  {
    key: "owner",
    label: "Owner",
    type: "search",
  },
];

export type QueueSearchParams = Record<string, string | string[] | undefined>;

export interface QueueFilters {
  product?: string;
  stage?: CrmStage;
  owner?: string;
}

/**
 * Read the filters out of the URL.
 *
 * A query string is untrusted input: `stage` is only honoured when it is a
 * real `CrmStage`, `product` only when the estate declares it, and a
 * repeated param (arrives as an array) is dropped rather than guessed at.
 */
export function readQueueFilters(searchParams: QueueSearchParams): QueueFilters {
  const filters: QueueFilters = {};

  const rawProduct = searchParams.product;
  if (typeof rawProduct === "string" && rawProduct !== "") {
    if (ESTATE.some((product) => product.context === rawProduct)) {
      filters.product = rawProduct;
    }
  }

  const rawStage = searchParams.stage;
  if (typeof rawStage === "string" && rawStage !== "" && isCrmStage(rawStage)) {
    filters.stage = rawStage;
  }

  const rawOwner = searchParams.owner;
  if (typeof rawOwner === "string" && rawOwner !== "") {
    filters.owner = rawOwner;
  }

  return filters;
}

/** The applied filters as the bar's display values. */
export function toFilterValues(filters: QueueFilters): FilterValues {
  const values: FilterValues = {};
  if (filters.product) values.product = filters.product;
  if (filters.stage) values.stage = filters.stage;
  if (filters.owner) values.owner = filters.owner;
  return values;
}

/**
 * Applied in TypeScript, not SQL: `dueOpportunities`/`driftingOpportunities`
 * take only a limit (and, for drifting, `staleDays`) — Task 4 built no filter
 * predicates into either query. Both reads are small (the drifting query's
 * own comment puts the whole table at ~259 rows), so filtering the returned
 * page here costs nothing today.
 */
export function filterRows(rows: readonly QueueRow[], filters: QueueFilters): QueueRow[] {
  return rows.filter((row) => {
    if (filters.product && row.product !== filters.product) return false;
    if (filters.stage && row.stage !== filters.stage) return false;
    if (filters.owner && !(row.owner ?? "").toLowerCase().includes(filters.owner.toLowerCase())) {
      return false;
    }
    return true;
  });
}

export interface QueueGroupStateInput {
  error: unknown;
  rows: readonly QueueItem[];
  filtered: boolean;
}

/**
 * Which of the six states a group is in — `resolveState`, not
 * `triageState`, which can never return `empty` and would leave
 * `DUE_EMPTY_MESSAGE`/`DRIFTING_EMPTY_MESSAGE` unreachable. See #133.
 */
export function queueGroupState(input: QueueGroupStateInput): SurfaceState {
  return resolveState({
    // The page awaits both reads before rendering; there is no client-side
    // pending window here.
    isLoading: false,
    error: toSurfaceError(input.error),
    rows: input.rows,
    filtered: input.filtered,
  });
}

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams>;
}) {
  const filters = readQueueFilters(await searchParams);
  const filtered = Object.keys(filters).length > 0;

  // `allSettled`, not `all`: a failure reading one group (due vs. drifting —
  // two independent queries) must not blank the other. `Promise.all` rejects
  // the whole render on the first rejection.
  const [dueResult, driftingResult] = await Promise.allSettled([
    dueOpportunities(DUE_LIMIT),
    driftingOpportunities(DRIFT_DAYS, DRIFTING_LIMIT),
  ]);

  const dueRows: QueueRow[] = dueResult.status === "fulfilled" ? dueResult.value : [];
  const dueError: unknown = dueResult.status === "rejected" ? dueResult.reason : null;

  const driftingRows: QueueRow[] =
    driftingResult.status === "fulfilled" ? driftingResult.value : [];
  const driftingError: unknown = driftingResult.status === "rejected" ? driftingResult.reason : null;

  const dueItems = filterRows(dueRows, filters).map(toQueueItem);
  const driftingItems = filterRows(driftingRows, filters).map(toQueueItem);

  const dueState = queueGroupState({ error: dueError, rows: dueItems, filtered });
  const driftingState = queueGroupState({ error: driftingError, rows: driftingItems, filtered });

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="CRM"
        description="Leads and opportunities that need a rep's attention today."
      />

      <CrmQueueView
        descriptors={QUEUE_FILTERS}
        values={toFilterValues(filters)}
        due={{
          heading: "Due",
          items: dueItems,
          state: dueState,
          emptyMessage: DUE_EMPTY_MESSAGE,
        }}
        drifting={{
          heading: "Drifting",
          items: driftingItems,
          state: driftingState,
          emptyMessage: DRIFTING_EMPTY_MESSAGE,
        }}
      />
    </div>
  );
}
