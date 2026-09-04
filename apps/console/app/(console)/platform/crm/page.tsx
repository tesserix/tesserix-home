import Link from "next/link";
import { ESTATE } from "@tesserix/console-core";
import { ConsolePageHeader } from "@/components/kit/page-header";
import type { QueueItem, QueueStatus, QueueStatusTone } from "@/components/kit/queue-list";
import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
// Imported from `surface-state` and not from `states`: this is a server
// component, and `states.tsx` is a "use client" module whose exports become
// client references that throw when called on the server. See
// `tickets/page.tsx` for the incident this guards against.
import { resolveState, type SurfaceState } from "@/components/kit/surface-state";
// Not `toSurfaceError`: these rejections come straight off `pg`, and its
// verbatim `.message` would render a Postgres error to an operator. See
// `@/lib/db-read-error`.
import { dbReadError } from "@/lib/db-read-error";
import { type QueuePage, type QueueRow, type QueueFilter } from "@/lib/db/crm-repo";
import { fetchDriftingQueue, fetchDueQueue } from "@/lib/crm-queues";
import { CRM_STAGES, DRIFT_DAYS, isCrmStage, isOpenStage, type CrmStage } from "@/lib/crm";
import {
  FOLLOWER_BANDS,
  UNASSIGNED_PRODUCT,
  UNKNOWN_COUNTRY,
  UNKNOWN_FOLLOWERS,
  UNKNOWN_LABEL,
  isFollowerFilter,
} from "@/lib/db/crm-filters";
import { COUNTRY_LABELS } from "@/lib/db/crm-country";
import { DUE_CURSOR_PARAM, DRIFT_CURSOR_PARAM } from "./cursor-params";
import { productLabel } from "./product-label";
import { CrmQueueView } from "./queue-view";
import { renderHandoffTab } from "./handoff-tab";
import { renderClosedTab } from "./closed-tab";
import {
  buildQueueNextHref,
  buildQueuePreviousHref,
  currentPath,
  readCursor,
  readTab,
  tabHref,
  type CrmTab,
  type QueueSearchParams,
} from "./url";

/**
 * The CRM follow-up queue — everything a sales rep should look at today.
 *
 * Due and Drifting are two separate reads (Task 4) and stay two separate
 * groups here: a lead surfaced by the drift rule (nobody scheduled anything,
 * and the org has gone quiet) reads very differently from one an operator
 * deliberately booked a next action for, and merging them into one list would
 * erase that distinction.
 *
 * The two other tabs are reads of what this one deliberately excludes, and
 * each lives in its own module: `handoff-tab.tsx` (won, not yet linked to a
 * conversion) and `closed-tab.tsx` (won or lost, the terminal stages both
 * queues filter out).
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

/** Stages an operator can actually filter to on the Work tab. Both
 *  `dueOpportunities` and `driftingOpportunities` exclude `won`/`lost`
 *  unconditionally (terminal deals are not work) — offering them in the
 *  select would let an operator pick a filter that always renders two empty
 *  groups, with nothing telling them the choice was refused rather than
 *  simply unmatched. Those deals have a tab of their own instead. */
const OPEN_CRM_STAGES = CRM_STAGES.filter(isOpenStage);

/** And the complement, for the Closed tab: exactly the stages
 *  `closedOpportunities` can return. */
const CLOSED_CRM_STAGES = CRM_STAGES.filter((stage) => !isOpenStage(stage));

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
    // "Unassigned" is last, not alphabetised in with the estate: every
    // import and every migrated lead has a null product (the bug #213
    // fixes), so this option answers a different question ("show me the
    // rows nothing has been assigned to yet") than picking a product does.
    options: [
      ...ESTATE.map((product) => ({ value: product.context, label: product.name })),
      { value: UNASSIGNED_PRODUCT, label: "Unassigned" },
    ],
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
  {
    key: "country",
    label: "Country",
    type: "select",
    // The closed set the derived `crm_organisations.country` column can
    // hold, plus "Unknown" — same options as the browse surface's `country`
    // filter. "Unknown" is last rather than alphabetised in, like
    // "Unassigned" above: it answers "show me the rows no market could be
    // derived for" (208 of 259 today), not "show me a market".
    options: [
      ...Object.entries(COUNTRY_LABELS).map(([code, label]) => ({ value: code, label })),
      { value: UNKNOWN_COUNTRY, label: UNKNOWN_LABEL },
    ],
  },
  {
    key: "followers",
    label: "Followers",
    type: "select",
    // Same bands, in the same order, as the browse surface's `followers`
    // filter — this queue's own qualification signal (see the module doc).
    // "Unknown" closes the set: a NULL follower count matches no band, so
    // without it those rows are reachable from no value of this filter.
    options: [
      ...Object.entries(FOLLOWER_BANDS).map(([value, band]) => ({ value, label: band.label })),
      { value: UNKNOWN_FOLLOWERS, label: UNKNOWN_LABEL },
    ],
  },
];

/** The Closed tab's filters: the same axes, because the same
 *  `filterClause` applies them to the same join, with the stage select
 *  offering the two stages that list CAN return instead of the three it
 *  cannot. Derived from `QUEUE_FILTERS` rather than restated, so a new axis
 *  is added once. */
export const CLOSED_FILTERS: FilterDescriptor[] = QUEUE_FILTERS.map((descriptor) =>
  descriptor.key === "stage"
    ? {
        ...descriptor,
        options: CLOSED_CRM_STAGES.map((stage) => ({
          value: stage,
          label: STAGE_LABELS[stage],
        })),
      }
    : descriptor,
);

/**
 * Which stages a tab's read can actually return.
 *
 * The Work tab's two queries exclude `won`/`lost` in SQL and the Closed
 * tab's includes only those, so a stage outside a tab's own set is not a
 * narrower filter — it is a contradiction. Forwarded, `?stage=won` on the
 * Work tab produced `stage NOT IN ('won','lost') AND o.stage = 'won'`: zero
 * rows, no error, rendered as "filtered, matched nothing". Dropping it
 * instead is what `readQueueFilters` documents for every other out-of-range
 * value.
 *
 * The Handoff tab renders no filter bar and passes no filters to its read,
 * so which set it takes is unobservable there; it shares the Work tab's
 * rather than inventing a third.
 */
function admitsStage(tab: CrmTab, stage: CrmStage): boolean {
  return tab === "closed" ? !isOpenStage(stage) : isOpenStage(stage);
}

/**
 * Read the filters out of the URL.
 *
 * A query string is untrusted input: `stage` is only honoured when it is a
 * real `CrmStage` the active tab can return (an unrecognised value — e.g.
 * `?stage=banana` — or one this tab's query excludes is treated the same as
 * no filter at all, not forwarded to SQL and not reported as an error: a bad
 * value in a bookmarked or hand-edited URL should read as "unfiltered", not
 * break the page), `product` only when the estate declares it, and a repeated
 * param (arrives as an array) is dropped rather than guessed at.
 */
export function readQueueFilters(
  searchParams: QueueSearchParams,
  tab: CrmTab = "work",
): QueueFilter {
  const filters: QueueFilter = {};

  const rawProduct = searchParams.product;
  if (typeof rawProduct === "string" && rawProduct !== "") {
    // The sentinel isn't a real product's context, so it fails the ESTATE
    // check below by design — checked first, or "Unassigned" would round-trip
    // through the URL as if it were an unrecognised value and silently drop.
    if (rawProduct === UNASSIGNED_PRODUCT || ESTATE.some((product) => product.context === rawProduct)) {
      filters.product = rawProduct;
    }
  }

  const rawStage = searchParams.stage;
  if (
    typeof rawStage === "string" &&
    rawStage !== "" &&
    isCrmStage(rawStage) &&
    admitsStage(tab, rawStage)
  ) {
    filters.stage = rawStage;
  }

  const rawOwner = searchParams.owner;
  if (typeof rawOwner === "string" && rawOwner !== "") {
    filters.owner = rawOwner;
  }

  const rawCountry = searchParams.country;
  // `Object.hasOwn`, not `in` — `in` walks the prototype chain, so
  // `?country=__proto__` would read as a recognised code. Same guard the
  // organisations page uses. The unknown sentinel is admitted alongside,
  // because it is not a COUNTRY_LABELS key and would otherwise be dropped as
  // an unrecognised code — the "Unknown" option would silently do nothing.
  if (
    typeof rawCountry === "string" &&
    (rawCountry === UNKNOWN_COUNTRY || Object.hasOwn(COUNTRY_LABELS, rawCountry))
  ) {
    filters.country = rawCountry;
  }

  const rawFollowers = searchParams.followers;
  if (typeof rawFollowers === "string" && isFollowerFilter(rawFollowers)) {
    filters.followers = rawFollowers;
  }

  return filters;
}

/** The applied filters as the bar's display values. */
export function toFilterValues(filters: QueueFilter): FilterValues {
  const values: FilterValues = {};
  if (filters.product) values.product = filters.product;
  if (filters.stage) values.stage = filters.stage;
  if (filters.owner) values.owner = filters.owner;
  if (filters.country) values.country = filters.country;
  if (filters.followers) values.followers = filters.followers;
  return values;
}

export interface QueueGroupStateInput {
  error: unknown;
  rows: readonly QueueItem[];
  filtered: boolean;
  /** Named in the operator-facing failure copy ("Could not load the Due
   *  queue"), so a failed group says WHICH group failed — the other one is
   *  still rendering its own rows beside it. */
  surface: string;
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
    error: dbReadError(input.error, input.surface),
    rows: input.rows,
    filtered: input.filtered,
  });
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
    { id: "closed", label: "Closed" },
  ];
  return (
    // Plain page links, not ARIA tabs: `role="tab"` with no `role="tablist"`
    // parent is an orphan-role violation, and `aria-selected` is the wrong
    // semantic for an element that navigates rather than toggling a panel
    // in place — `aria-current="page"` is the correct affordance for "which
    // page, among these links, is the current one".
    <nav className="flex gap-1 border-b border-border" aria-label="CRM views">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tabHref(searchParams, tab.id)}
          aria-current={active === tab.id ? "page" : undefined}
          // Explicit, not relying on Next's own heuristics for a fully
          // dynamic route: prefetching Handoff would fire its fan-out the
          // moment this link scrolls into view on the Work tab, which is
          // exactly the load this whole fix exists to avoid paying for
          // unless the operator actually clicks it. Only Handoff: the other
          // two tabs each cost one or two queue reads, not a fan-out of up
          // to a hundred outbound calls.
          prefetch={tab.id === "handoff" ? false : undefined}
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

/** The page a rejected read stands in for: no rows, and counts that claim
 *  nothing. The group renders its error state, so these are never displayed
 *  — they exist so the caller has one shape to read rather than a union. */
const NO_PAGE: QueuePage = {
  rows: [],
  total: 0,
  precedingCount: 0,
  nextCursor: null,
  previousCursor: null,
};

/** A settled queue read as a page plus the rejection, if any. */
function settledPage(result: PromiseSettledResult<QueuePage>): {
  page: QueuePage;
  error: unknown;
} {
  return result.status === "fulfilled"
    ? { page: result.value, error: null }
    : { page: NO_PAGE, error: result.reason };
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
 * returns already-resolved JSX for exactly this reason. The other two tabs'
 * renderers are the same shape, for the same reason.
 */
async function renderWorkTab({
  searchParams,
  filters,
  filtered,
  reauthReturnTo,
}: {
  searchParams: QueueSearchParams;
  filters: QueueFilter;
  filtered: boolean;
  reauthReturnTo: string;
}) {
  // `allSettled`, not `all`: a failure reading one group (due vs. drifting —
  // two independent queries) must not blank the other. `Promise.all` rejects
  // the whole render on the first rejection. This is also what contains a
  // malformed cursor: the repo REJECTS one rather than quietly serving page
  // one, and that rejection lands here as this group's error state — never
  // as an unhandled 500 for the page, and never as the other queue going
  // blank alongside it.
  //
  // `filters` is passed straight into both reads — the predicates run in
  // SQL, ahead of ORDER BY/LIMIT (Ruling 11). Filtering the returned page in
  // TypeScript instead would answer "rows matching the filter among the
  // first N overall", silently dropping a match ranked below the cut-off.
  // The cursors are passed for the same reason: paging in SQL is the only
  // way page two can contain rows page one never fetched.
  const [dueResult, driftingResult] = await Promise.allSettled([
    fetchDueQueue(filters, DUE_LIMIT, readCursor(searchParams, DUE_CURSOR_PARAM)),
    fetchDriftingQueue(
      filters,
      DRIFT_DAYS,
      DRIFTING_LIMIT,
      readCursor(searchParams, DRIFT_CURSOR_PARAM),
    ),
  ]);

  const due = settledPage(dueResult);
  const drifting = settledPage(driftingResult);

  const dueItems = due.page.rows.map(toQueueItem);
  const driftingItems = drifting.page.rows.map(toQueueItem);

  const dueState = queueGroupState({
    error: due.error,
    rows: dueItems,
    filtered,
    surface: "the Due queue",
  });
  const driftingState = queueGroupState({
    error: drifting.error,
    rows: driftingItems,
    filtered,
    surface: "the Drifting queue",
  });

  return (
    <CrmQueueView
      descriptors={QUEUE_FILTERS}
      values={toFilterValues(filters)}
      reauthReturnTo={reauthReturnTo}
      due={{
        heading: "Due",
        // Lower-case and read as a noun phrase: the pager builds
        // "Next page of {label}" and "{label} pagination" out of it.
        pagerLabel: "the due queue",
        items: dueItems,
        state: dueState,
        emptyMessage: DUE_EMPTY_MESSAGE,
        total: due.page.total,
        precedingCount: due.page.precedingCount,
        nextHref: buildQueueNextHref(searchParams, DUE_CURSOR_PARAM, due.page.nextCursor),
        previousHref: buildQueuePreviousHref(
          searchParams,
          DUE_CURSOR_PARAM,
          due.page.previousCursor,
        ),
      }}
      drifting={{
        heading: "Drifting",
        pagerLabel: "the drifting queue",
        items: driftingItems,
        state: driftingState,
        emptyMessage: DRIFTING_EMPTY_MESSAGE,
        total: drifting.page.total,
        precedingCount: drifting.page.precedingCount,
        nextHref: buildQueueNextHref(
          searchParams,
          DRIFT_CURSOR_PARAM,
          drifting.page.nextCursor,
        ),
        previousHref: buildQueuePreviousHref(
          searchParams,
          DRIFT_CURSOR_PARAM,
          drifting.page.previousCursor,
        ),
      }}
    />
  );
}

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const activeTab = readTab(resolvedSearchParams);
  // Read against the active tab: which stages are admissible differs between
  // the Work and Closed tabs, and a stage neither can return is dropped
  // rather than forwarded (see `admitsStage`).
  const filters = readQueueFilters(resolvedSearchParams, activeTab);
  const filtered = Object.keys(filters).length > 0;
  // Computed once, ahead of the tab split: the query string it carries
  // (including `tab` itself) already answers "which tab, with which
  // filters" for both branches below, so signing in again lands the
  // operator back on whichever tab and filters they left.
  const reauthReturnTo = currentPath(resolvedSearchParams);

  // Only the active tab's data is ever read — see `tabHref`'s doc comment.
  // Awaited here, as a plain function call, and embedded as already-resolved
  // JSX below, not rendered as a nested `<Tab/>` async component: see
  // `renderWorkTab`'s doc comment for why.
  let content;
  if (activeTab === "handoff") {
    content = await renderHandoffTab(reauthReturnTo);
  } else if (activeTab === "closed") {
    content = await renderClosedTab({
      searchParams: resolvedSearchParams,
      descriptors: CLOSED_FILTERS,
      values: toFilterValues(filters),
      filters,
      filtered,
      reauthReturnTo,
    });
  } else {
    content = await renderWorkTab({
      searchParams: resolvedSearchParams,
      filters,
      filtered,
      reauthReturnTo,
    });
  }

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
