import { cookies } from "next/headers";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { StatTile } from "@/components/kit/stat-tile";
import { QueueList, type QueueItem } from "@/components/kit/queue-list";
// Imported from `surface-state` and not from `states`: this is a server
// component, and `states.tsx` is a "use client" module whose exports become
// client references that throw when called on the server.
import { resolveState, toSurfaceError, type SurfaceState } from "@/components/kit/surface-state";
import { fetchTickets } from "@/lib/platform-api";
import {
  severityOf,
  ticketKey,
  type Ticket,
  type TicketsPage,
} from "@/lib/tickets";

/**
 * The cross-product ticket queue — the console's inbound half.
 *
 * Mixed rather than grouped by product (spec open question 1): a support person
 * does not know which product an email concerns until they read it, so triage
 * order is "what has waited longest and shouts loudest", with the product as a
 * column rather than a partition.
 */

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
    // The UUID, not the number: the detail API supports only id lookup.
    href: `/platform/tickets/${ticket.id}`,
  }));
}

/** The `empty` copy, exported so the test asserts on the string the page ships
 *  rather than on a second copy of it that could drift. */
export const QUEUE_EMPTY_MESSAGE = "Nothing waiting. Every ticket is answered.";

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

export default async function TicketQueue() {
  const cookieHeader = (await cookies()).toString();

  let page: TicketsPage | null = null;
  let error: unknown = null;
  try {
    page = await fetchTickets(cookieHeader);
  } catch (caught) {
    error = caught;
  }

  const rows: QueueItem[] = page ? toQueueItems(page) : [];
  // No filters on this surface yet (#133 task 3 adds status/priority/product).
  // Passed as a value rather than hard-coded at the call site so landing them
  // is a matter of computing this one boolean.
  const filtered = false;

  const state: SurfaceState = queueState({ error, rows, filtered });

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Tickets"
        description="Every product's inbound support, in one queue."
      />

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

      <QueueList items={rows} state={state} emptyMessage={QUEUE_EMPTY_MESSAGE} />
    </div>
  );
}
