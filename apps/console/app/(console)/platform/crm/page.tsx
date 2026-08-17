import { cookies } from "next/headers";
import Link from "next/link";
import { ESTATE } from "@tesserix/console-core";
import { ConsolePageHeader } from "@/components/kit/page-header";
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
/** Bounds simultaneous outbound `fetchConversionSignal` calls. A handoff
 *  queue at `HANDOFF_LIMIT` is up to 100 requests fanned out at once (Task
 *  9's review, carried forward) — correct for "one hung product must not
 *  stall the others", but 100 *simultaneous* connections through the one
 *  apps/web proxy every product's conversion-status check goes through is
 *  its own kind of thundering herd. `mapWithConcurrencyLimit` keeps the
 *  "never sequential" guarantee while bounding how many are in flight at
 *  once. */
const HANDOFF_FETCH_CONCURRENCY = 10;

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
 * Runs `fn` over `items` with at most `concurrency` in flight at once.
 * Settles like `Promise.allSettled` — one item's rejection is isolated to
 * its own slot, never delaying or blanking the rest — but bounded, unlike
 * `Promise.allSettled(items.map(fn))`, which starts every call at once.
 *
 * A small worker pool, not a batch-of-N-then-wait chunking scheme: batching
 * would let one slow request in a batch hold up every other slot in that
 * same batch even though `concurrency - 1` other workers sit idle; a pool
 * immediately hands a finished worker the next item, so throughput is
 * bounded by `concurrency`, not by the slowest item in an arbitrary chunk.
 */
async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * The handoff tab's fan-out: one `fetchConversionSignal` call per row.
 *
 * Task 9's review carried its own rule into this task: never sequential
 * awaits. Against an 8s-timeout client, N leads awaited one at a time is an
 * N×8s user-visible stall on a server-rendered page, and a single hung or
 * failing product must not delay — or blank — the rest of the queue.
 * `mapWithConcurrencyLimit` keeps that guarantee while bounding how many
 * requests are ever in flight at once (`HANDOFF_FETCH_CONCURRENCY`).
 * `fetchConversionSignal` itself never throws (its whole contract is "a
 * non-answer resolves to `unknown`"), so the `rejected` branch below is
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
  const settled = await mapWithConcurrencyLimit(rows, HANDOFF_FETCH_CONCURRENCY, (row) =>
    row.primaryEmail
      ? fetchConversionSignal(row.product, row.primaryEmail, cookieHeader)
      : Promise.resolve<ConversionSignal>({ product: row.product, state: "unknown" }),
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

export type CrmTab = "work" | "handoff";

/** Which tab `?tab=` selects — anything else (including nothing) is "work",
 *  the surface's default. Same "unrecognised input reads as unfiltered"
 *  contract `readQueueFilters` applies to `stage`/`product`. */
export function readTab(searchParams: QueueSearchParams): CrmTab {
  return searchParams.tab === "handoff" ? "handoff" : "work";
}

/**
 * A tab's `href`, preserving every other search param (the Work tab's own
 * product/stage/owner filters survive a round trip through Handoff and
 * back) and setting/clearing only `tab`.
 *
 * Real navigation, not a client-side tab switch: this page's two tabs do
 * not cost the same to render. Handoff's is up to `HANDOFF_LIMIT` outbound
 * calls to apps/web; Work's is two cheap SQL reads. A `SurfaceTabs`-style
 * "render both panels once, switch instantly" (as `tickets/page.tsx` does
 * for its Queue/Analytics split) would mean loading `/platform/crm` on Work
 * always pays for the Handoff fan-out too, whether or not anyone ever
 * clicks that tab — every one of those calls a guaranteed `unknown` today,
 * and a genuine 8s stall on the WORK queue the day apps/web is slow to
 * answer rather than fast to 404. Only the active tab's data is ever read.
 */
function tabHref(searchParams: QueueSearchParams, tab: CrmTab): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "tab" || typeof value !== "string" || value === "") continue;
    params.set(key, value);
  }
  if (tab === "handoff") {
    params.set("tab", "handoff");
  }
  const qs = params.toString();
  return qs ? `/platform/crm?${qs}` : "/platform/crm";
}

function CrmTabNav({
  searchParams,
  active,
}: {
  searchParams: QueueSearchParams;
  active: CrmTab;
}) {
  const tabs: { id: CrmTab; label: string }[] = [
    { id: "work", label: "Work" },
    { id: "handoff", label: "Handoff" },
  ];
  return (
    <nav className="flex gap-1 border-b border-border" aria-label="CRM views">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tabHref(searchParams, tab.id)}
          role="tab"
          aria-selected={active === tab.id}
          className={
            active === tab.id
              ? "border-b-2 border-foreground px-3 py-2 text-sm font-medium text-foreground"
              : "border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          }
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The Work tab's content: due/drifting queues, filtered per the URL.
 *
 * A plain async function `CrmPage` calls and awaits — not a nested async
 * Server Component rendered as unawaited JSX (`<WorkTab/>`). Next.js's real
 * RSC renderer can await a nested async component fine, but this repo's
 * tests render `CrmPage`'s output through plain `@testing-library/react`
 * (`render(await CrmPage(...))`), which has no RSC runtime to resolve a
 * pending child — it would silently render an empty tree. Every data-fetching
 * page in this app (`tickets/page.tsx`, `crm/[organisation]/page.tsx`, this
 * page before this change) awaits its data as a plain function call and
 * returns already-resolved JSX for exactly this reason.
 */
async function renderWorkTab({
  filters,
  filtered,
}: {
  filters: QueueFilter;
  filtered: boolean;
}) {
  // `allSettled`, not `all`: a failure reading one group (due vs. drifting —
  // two independent queries) must not blank the other. `Promise.all` rejects
  // the whole render on the first rejection.
  //
  // `filters` is passed straight into both reads — the predicates run in
  // SQL, ahead of ORDER BY/LIMIT (Ruling 11). Filtering the returned page in
  // TypeScript instead would answer "rows matching the filter among the
  // first N overall", silently dropping a match ranked below the cut-off.
  const [dueResult, driftingResult] = await Promise.allSettled([
    dueOpportunities(filters, DUE_LIMIT),
    driftingOpportunities(filters, DRIFT_DAYS, DRIFTING_LIMIT),
  ]);

  const dueRows: QueueRow[] = dueResult.status === "fulfilled" ? dueResult.value : [];
  const dueError: unknown = dueResult.status === "rejected" ? dueResult.reason : null;

  const driftingRows: QueueRow[] =
    driftingResult.status === "fulfilled" ? driftingResult.value : [];
  const driftingError: unknown = driftingResult.status === "rejected" ? driftingResult.reason : null;

  const dueItems = dueRows.map(toQueueItem);
  const driftingItems = driftingRows.map(toQueueItem);

  const dueState = queueGroupState({ error: dueError, rows: dueItems, filtered });
  const driftingState = queueGroupState({ error: driftingError, rows: driftingItems, filtered });

  return (
    <CrmQueueView
      descriptors={QUEUE_FILTERS}
      values={toFilterValues(filters)}
      due={{ heading: "Due", items: dueItems, state: dueState, emptyMessage: DUE_EMPTY_MESSAGE }}
      drifting={{
        heading: "Drifting",
        items: driftingItems,
        state: driftingState,
        emptyMessage: DRIFTING_EMPTY_MESSAGE,
      }}
    />
  );
}

/**
 * The Handoff tab's content: won opportunities awaiting a conversion link.
 * Same "plain awaited function, not a nested async component" shape as
 * `renderWorkTab` above, for the same testability reason — and only ever
 * CALLED (so only ever reads `wonWithoutConversion`/fans out
 * `fetchConversionSignal`) while this tab is the active one; see
 * `tabHref`'s doc comment for why the Work tab must never pay for this.
 */
async function renderHandoffTab() {
  const cookieHeader = (await cookies()).toString();

  let handoffRows: HandoffRow[] = [];
  let handoffRowsError: unknown = null;
  try {
    handoffRows = await wonWithoutConversion(HANDOFF_LIMIT);
  } catch (caught) {
    handoffRowsError = caught;
  }

  // Only fanned out once the row read itself succeeded — a failed
  // `wonWithoutConversion` has no rows to fan a signal fetch out over, and
  // fanning out zero rows is a no-op either way.
  const handoffItems = handoffRowsError ? [] : await buildHandoffItems(handoffRows, cookieHeader);

  const handoffState = resolveState({
    isLoading: false,
    error: toSurfaceError(handoffRowsError),
    rows: handoffItems,
    filtered: false,
  });

  const products = ESTATE.map((product) => ({ context: product.context, name: product.name }));

  return (
    <HandoffView
      items={handoffItems}
      state={handoffState}
      emptyMessage={HANDOFF_EMPTY_MESSAGE}
      products={products}
    />
  );
}

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const filters = readQueueFilters(resolvedSearchParams);
  const filtered = Object.keys(filters).length > 0;
  const activeTab = readTab(resolvedSearchParams);

  // Only the active tab's data is ever read — see `tabHref`'s doc comment.
  // Awaited here, as a plain function call, and embedded as already-resolved
  // JSX below, not rendered as a nested `<Tab/>` async component: see
  // `renderWorkTab`'s doc comment for why.
  const content =
    activeTab === "handoff" ? await renderHandoffTab() : await renderWorkTab({ filters, filtered });

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="CRM"
        description="Leads and opportunities that need a rep's attention today."
      />

      <CrmTabNav searchParams={resolvedSearchParams} active={activeTab} />

      {content}
    </div>
  );
}
