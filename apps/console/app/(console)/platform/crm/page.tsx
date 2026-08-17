import { cookies } from "next/headers";
import { ESTATE } from "@tesserix/console-core";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { SurfaceTabs } from "@/components/kit/surface-tabs";
import type { QueueItem, QueueStatus, QueueStatusTone } from "@/components/kit/queue-list";
import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
// Imported from `surface-state` and not from `states`: this is a server
// component, and `states.tsx` is a "use client" module whose exports become
// client references that throw when called on the server. See
// `tickets/page.tsx` for the incident this guards against.
import { resolveState, toSurfaceError, type SurfaceState } from "@/components/kit/surface-state";
import {
  dueOpportunities,
  driftingOpportunities,
  wonWithoutConversion,
  type QueueRow,
  type QueueFilter,
  type HandoffRow,
} from "@/lib/db/crm-repo";
import { fetchConversionSignal, type ConversionSignal } from "@/lib/crm-conversion";
import { CRM_STAGES, DRIFT_DAYS, isCrmStage, type CrmStage } from "@/lib/crm";
import { CrmQueueView } from "./queue-view";
import { HandoffView, type HandoffItem } from "./handoff-view";

export type { HandoffItem };

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
const HANDOFF_LIMIT = 100;

/** The `empty` copy for each group, exported so tests assert on the string
 *  the page ships rather than a second copy of it that could drift. */
export const DUE_EMPTY_MESSAGE = "Nothing due. Nothing needs action right now.";
export const DRIFTING_EMPTY_MESSAGE = "Nothing drifting. Every open lead is either scheduled or fresh.";
export const HANDOFF_EMPTY_MESSAGE =
  "Nothing to hand off. Every won deal is already linked to a conversion.";

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

/** Stages an operator can actually filter to. Both `dueOpportunities` and
 *  `driftingOpportunities` exclude `won`/`lost` unconditionally (terminal
 *  deals are not work) — offering them in the select would let an operator
 *  pick a filter that always renders two empty groups, with nothing telling
 *  them the choice was refused rather than simply unmatched. */
const OPEN_CRM_STAGES = CRM_STAGES.filter((stage) => stage !== "won" && stage !== "lost");

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
    options: OPEN_CRM_STAGES.map((stage) => ({ value: stage, label: STAGE_LABELS[stage] })),
  },
  {
    key: "owner",
    label: "Owner",
    type: "search",
  },
];

export type QueueSearchParams = Record<string, string | string[] | undefined>;

/**
 * Read the filters out of the URL.
 *
 * A query string is untrusted input: `stage` is only honoured when it is a
 * real `CrmStage` (an unrecognised value — e.g. `?stage=banana` — is treated
 * the same as no filter at all, not forwarded to SQL and not reported as an
 * error: a bad value in a bookmarked or hand-edited URL should read as
 * "unfiltered", not break the page), `product` only when the estate declares
 * it, and a repeated param (arrives as an array) is dropped rather than
 * guessed at.
 */
export function readQueueFilters(searchParams: QueueSearchParams): QueueFilter {
  const filters: QueueFilter = {};

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
export function toFilterValues(filters: QueueFilter): FilterValues {
  const values: FilterValues = {};
  if (filters.product) values.product = filters.product;
  if (filters.stage) values.stage = filters.stage;
  if (filters.owner) values.owner = filters.owner;
  return values;
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

/**
 * The handoff tab's fan-out: one `fetchConversionSignal` call per row.
 *
 * Task 9's review carried its own rule into this task: `Promise.allSettled`,
 * never sequential awaits. Against an 8s-timeout client, N leads awaited one
 * at a time is an N×8s user-visible stall on a server-rendered page, and a
 * single hung or failing product must not delay — or blank — the rest of the
 * queue. `fetchConversionSignal` itself never throws (its whole contract is
 * "a non-answer resolves to `unknown`"), so the `rejected` branch below is
 * belt-and-braces against a caller-side bug, not a path this module expects
 * to take in practice.
 *
 * A row with no primary contact email never calls `fetchConversionSignal` at
 * all: there is nothing to ask a product about, and the honest answer is
 * `unknown` — not a wasted network call, and not `none`.
 */
export async function buildHandoffItems(
  rows: readonly HandoffRow[],
  cookieHeader: string,
): Promise<HandoffItem[]> {
  const settled = await Promise.allSettled(
    rows.map((row) =>
      row.primaryEmail
        ? fetchConversionSignal(row.product, row.primaryEmail, cookieHeader)
        : Promise.resolve<ConversionSignal>({ product: row.product, state: "unknown" }),
    ),
  );

  return rows.map((row, index) => {
    const outcome = settled[index];
    const signal: ConversionSignal =
      outcome.status === "fulfilled" ? outcome.value : { product: row.product, state: "unknown" };
    return {
      opportunityId: row.opportunityId,
      organisationId: row.organisationId,
      organisationName: row.organisationName,
      product: row.product,
      closedAt: row.closedAt,
      signal,
    };
  });
}

/** Which tab `?tab=` selects — anything else (including nothing) is "work",
 *  the surface's default. Same "unrecognised input reads as unfiltered"
 *  contract `readQueueFilters` applies to `stage`/`product`. */
function readTab(searchParams: QueueSearchParams): "work" | "handoff" {
  return searchParams.tab === "handoff" ? "handoff" : "work";
}

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const filters = readQueueFilters(resolvedSearchParams);
  const filtered = Object.keys(filters).length > 0;
  const defaultTab = readTab(resolvedSearchParams);
  const cookieHeader = (await cookies()).toString();

  // `allSettled`, not `all`: a failure reading one group (due, drifting,
  // handoff — three independent queries) must not blank the others.
  // `Promise.all` rejects the whole render on the first rejection.
  //
  // `filters` is passed straight into the due/drifting reads — the
  // predicates run in SQL, ahead of ORDER BY/LIMIT (Ruling 11). Filtering
  // the returned page in TypeScript instead would answer "rows matching the
  // filter among the first N overall", silently dropping a match ranked
  // below the cut-off. The handoff read takes no filter — see
  // `wonWithoutConversion`.
  const [dueResult, driftingResult, handoffRowsResult] = await Promise.allSettled([
    dueOpportunities(filters, DUE_LIMIT),
    driftingOpportunities(filters, DRIFT_DAYS, DRIFTING_LIMIT),
    wonWithoutConversion(HANDOFF_LIMIT),
  ]);

  const dueRows: QueueRow[] = dueResult.status === "fulfilled" ? dueResult.value : [];
  const dueError: unknown = dueResult.status === "rejected" ? dueResult.reason : null;

  const driftingRows: QueueRow[] =
    driftingResult.status === "fulfilled" ? driftingResult.value : [];
  const driftingError: unknown = driftingResult.status === "rejected" ? driftingResult.reason : null;

  const handoffRows: HandoffRow[] =
    handoffRowsResult.status === "fulfilled" ? handoffRowsResult.value : [];
  const handoffRowsError: unknown =
    handoffRowsResult.status === "rejected" ? handoffRowsResult.reason : null;

  const dueItems = dueRows.map(toQueueItem);
  const driftingItems = driftingRows.map(toQueueItem);
  // Only fanned out once the row read itself succeeded — a failed
  // `wonWithoutConversion` has no rows to fan a signal fetch out over, and
  // fanning out zero rows is a no-op either way.
  const handoffItems = handoffRowsError ? [] : await buildHandoffItems(handoffRows, cookieHeader);

  const dueState = queueGroupState({ error: dueError, rows: dueItems, filtered });
  const driftingState = queueGroupState({ error: driftingError, rows: driftingItems, filtered });
  const handoffState = resolveState({
    isLoading: false,
    error: toSurfaceError(handoffRowsError),
    rows: handoffItems,
    filtered: false,
  });

  const products = ESTATE.map((product) => ({ context: product.context, name: product.name }));

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="CRM"
        description="Leads and opportunities that need a rep's attention today."
      />

      <SurfaceTabs
        label="CRM views"
        defaultTab={defaultTab}
        tabs={[
          {
            id: "work",
            label: "Work",
            content: (
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
            ),
          },
          {
            id: "handoff",
            label: "Handoff",
            content: (
              <HandoffView
                items={handoffItems}
                state={handoffState}
                emptyMessage={HANDOFF_EMPTY_MESSAGE}
                products={products}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
