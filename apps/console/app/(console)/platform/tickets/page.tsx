import { cookies } from "next/headers";
import { ESTATE } from "@tesserix/console-core";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { StatTile } from "@/components/kit/stat-tile";
import { SurfaceTabs } from "@/components/kit/surface-tabs";
import type { QueueItem, QueueStatus } from "@/components/kit/queue-list";
import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
// Imported from `surface-state` and not from `states`: this is a server
// component, and `states.tsx` is a "use client" module whose exports become
// client references that throw when called on the server.
import { resolveState, toSurfaceError, type SurfaceState } from "@/components/kit/surface-state";
import { fetchSupportAnalytics, fetchTickets, type TicketFilters } from "@/lib/platform-api";
import type { SupportAnalytics } from "@/lib/support-analytics";
import {
  severityOf,
  ticketKey,
  ticketStatusLabel,
  ticketStatusTone,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Ticket,
  type TicketsPage,
} from "@/lib/tickets";
import { QueueView } from "./queue-view";
import { AnalyticsPanel } from "./analytics-panel";

/**
 * The cross-product ticket queue — the console's inbound half.
 *
 * Mixed rather than grouped by product (spec open question 1): a support person
 * does not know which product an email concerns until they read it, so triage
 * order is "what has waited longest and shouts loudest", with the product as a
 * column rather than a partition.
 */

/** Status badge for a row. Distinct from severity, which is priority-derived. */
export function statusOf(ticket: Ticket): QueueStatus {
  return {
    label: ticketStatusLabel(ticket.status),
    tone: ticketStatusTone(ticket.status),
  };
}

export function toQueueItems(page: TicketsPage): QueueItem[] {
  return page.rows.map((ticket: Ticket) => ({
    // Composite, not the UUID: a human identifies a ticket by product and
    // number, and a duplicate is invisible in a list keyed by UUID.
    key: ticketKey(ticket),
    title: ticket.subject,
    subtitle: ticket.submittedByName
      ? `${ticket.submittedByName} · ${ticket.submittedByEmail}`
      : ticket.submittedByEmail,
    product: ticket.productId,
    waitingSince: ticket.createdAt,
    // No `dueAt`. platform_tickets has no deadline column and no agreed
    // response target, so an SLA badge here would be invented — and a queue
    // that shows a made-up "overdue" trains people to ignore the real ones.
    severity: severityOf(ticket.priority),
    // Where the ticket sits in its own workflow. An urgent ticket already in
    // progress reads very differently from an urgent one nobody has touched,
    // and severity alone cannot say which is which.
    status: statusOf(ticket),
    // The UUID, not the number: the detail API supports only id lookup.
    href: `/platform/tickets/${ticket.id}`,
  }));
}

/** The `empty` copy, exported so the test asserts on the string the page ships
 *  rather than on a second copy of it that could drift. */
export const QUEUE_EMPTY_MESSAGE = "Nothing waiting. Every ticket is answered.";

/**
 * The queue's filters.
 *
 * Keys are apps/web's query params verbatim (`status`, `priority`, `product`),
 * so the descriptor key, the URL param and the upstream param are one name.
 * The endpoint has accepted all three since it shipped and no caller has ever
 * sent them.
 *
 * Product options come from the estate rather than from the rows on screen:
 * options derived from the current page can only ever offer the products that
 * already have tickets, so the one filter an operator reaches for — "does
 * Dwellm8 have anything waiting?" — is the one that would be missing.
 *
 * Known gap: `platform_tickets` also carries `fanzone` rows, and FanZone is
 * deliberately outside the estate's first cut (see estate.ts). Those tickets
 * still appear unfiltered; there is simply no option to isolate them until
 * FanZone joins the estate.
 */
export const QUEUE_FILTERS: FilterDescriptor[] = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: TICKET_STATUSES.map((status) => ({
      value: status,
      label: ticketStatusLabel(status),
    })),
  },
  {
    key: "priority",
    label: "Priority",
    type: "select",
    options: TICKET_PRIORITIES.map((priority) => ({
      value: priority,
      label: priority.charAt(0).toUpperCase() + priority.slice(1),
    })),
  },
  {
    key: "product",
    label: "Product",
    type: "select",
    options: ESTATE.map((product) => ({
      value: product.context,
      label: product.name,
    })),
  },
];

export type QueueSearchParams = Record<string, string | string[] | undefined>;

/**
 * Read the filters out of the URL.
 *
 * A query string is untrusted input, so a value is only honoured when it is
 * one of the options this surface actually offers. An unrecognised value is
 * dropped rather than forwarded: passing it upstream would return zero rows
 * and render `filtered-empty`, which tells the operator "nothing matches" when
 * the truth is "that filter does not exist". Repeated params (`?status=a&
 * status=b`) arrive as an array and are ignored for the same reason — the
 * endpoint takes one value per key.
 */
export function readQueueFilters(searchParams: QueueSearchParams): TicketFilters {
  const filters: Record<string, string> = {};
  for (const descriptor of QUEUE_FILTERS) {
    const raw = searchParams[descriptor.key];
    if (typeof raw !== "string" || raw === "") {
      continue;
    }
    if ((descriptor.options ?? []).some((option) => option.value === raw)) {
      filters[descriptor.key] = raw;
    }
  }
  return filters;
}

/** The applied filters as the bar's display values — see QueueView's `values`. */
export function toFilterValues(filters: TicketFilters): FilterValues {
  const values: FilterValues = {};
  for (const descriptor of QUEUE_FILTERS) {
    const value = filters[descriptor.key as keyof TicketFilters];
    if (value) {
      values[descriptor.key] = value;
    }
  }
  return values;
}

export interface QueueStateInput {
  /** Whatever `fetchTickets` rejected with, or null. */
  error: unknown;
  rows: readonly QueueItem[];
  /** True when any filter is narrowing the queue. */
  filtered: boolean;
}

/**
 * Which of the six states the queue is in.
 *
 * This used to be `triageState(error, null)`, which can only ever return
 * `instrumentation-unavailable | error | ready` — so a queue with zero rows
 * reported `ready` and rendered an empty `<ul>`, and the `emptyMessage` below
 * was unreachable. `triageState` is right for the dashboard tiles it was
 * written for, where a 200 can carry `available: false` and there is no row
 * count to consider; it is the wrong helper for a list.
 */
export function queueState(input: QueueStateInput): SurfaceState {
  return resolveState({
    // The page awaits its fetch before rendering, so there is no client-side
    // pending window. Suspense fallbacks, not this state, cover the wait.
    isLoading: false,
    error: toSurfaceError(input.error),
    rows: input.rows,
    filtered: input.filtered,
  });
}

/**
 * The analytics tab's state, resolved independently of the queue's.
 *
 * Two reads, two states, on purpose: otto being parked (501) must park the
 * analytics tab and leave the queue — which is served by an entirely different
 * database — working. A single shared state would take the whole surface down
 * with the weaker dependency.
 */
export function analyticsState(input: {
  error: unknown;
  data: SupportAnalytics | null;
}): SurfaceState {
  return resolveState({
    isLoading: false,
    error: toSurfaceError(input.error),
    rows: input.data ? [input.data] : [],
    filtered: false,
  });
}

/**
 * The operator's exact URL as a relative path — every query param the
 * browser had, not only the three this surface reads as filters — so
 * signing in again returns them exactly where they were. Same shape
 * `middleware.ts`'s `unauthorized` builds (`${pathname}${search}`) and
 * `crm/page.tsx`'s `currentPath`, for the identical reason.
 */
function currentPath(searchParams: QueueSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") {
      params.set(key, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) params.append(key, entry);
    }
  }
  const qs = params.toString();
  return qs ? `/platform/tickets?${qs}` : "/platform/tickets";
}

export default async function TicketQueue({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams>;
}) {
  const cookieHeader = (await cookies()).toString();
  const resolvedSearchParams = await searchParams;
  const filters = readQueueFilters(resolvedSearchParams);
  const filtered = Object.keys(filters).length > 0;
  // Queue and Analytics are separate `SurfaceTabs` panels — never on screen
  // together — so unlike the CRM work tab there is no cross-group stacking
  // to suppress here; each independently-fetched half just needs the
  // operator's own return path.
  const reauthReturnTo = currentPath(resolvedSearchParams);

  // `allSettled`, not `all`: `Promise.all` rejects on the first failure, so a
  // parked analytics endpoint would reject the whole render and take the queue
  // down with it — the exact coupling this surface must not have.
  const [ticketsResult, analyticsResult] = await Promise.allSettled([
    fetchTickets(cookieHeader, filters),
    fetchSupportAnalytics(cookieHeader),
  ]);

  const page: TicketsPage | null =
    ticketsResult.status === "fulfilled" ? ticketsResult.value : null;
  const error: unknown =
    ticketsResult.status === "rejected" ? ticketsResult.reason : null;

  const analytics: SupportAnalytics | null =
    analyticsResult.status === "fulfilled" ? analyticsResult.value : null;
  const analyticsError: unknown =
    analyticsResult.status === "rejected" ? analyticsResult.reason : null;

  const rows: QueueItem[] = page ? toQueueItems(page) : [];
  const state: SurfaceState = queueState({ error, rows, filtered });

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Tickets"
        description="Every product's inbound support, in one queue."
      />

      <SurfaceTabs
        label="Tickets views"
        tabs={[
          {
            id: "queue",
            label: "Queue",
            content: (
              <div className="flex flex-col gap-6">
                {/* Estate-wide counts, deliberately not narrowed by the
                    filters: the summary is computed upstream over every
                    ticket, and a filtered "Urgent open" would answer a
                    different question than the one the label asks. */}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <StatTile
                    label="Open"
                    value={page ? page.summary.open : ""}
                    state={page ? undefined : state}
                  />
                  <StatTile
                    label="In progress"
                    value={page ? page.summary.inProgress : ""}
                    state={page ? undefined : state}
                  />
                  <StatTile
                    label="Urgent open"
                    value={page ? page.summary.urgentOpen : ""}
                    state={page ? undefined : state}
                  />
                  <StatTile
                    label="Resolved this week"
                    value={page ? page.summary.resolvedThisWeek : ""}
                    state={page ? undefined : state}
                  />
                </div>

                <QueueView
                  descriptors={QUEUE_FILTERS}
                  values={toFilterValues(filters)}
                  items={rows}
                  state={state}
                  emptyMessage={QUEUE_EMPTY_MESSAGE}
                  reauthReturnTo={reauthReturnTo}
                />
              </div>
            ),
          },
          {
            id: "analytics",
            label: "Analytics",
            content: (
              <AnalyticsPanel
                data={analytics}
                state={analyticsState({ error: analyticsError, data: analytics })}
                reauthReturnTo={reauthReturnTo}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
