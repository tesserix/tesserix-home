import { cookies } from "next/headers";
import { ConsolePageHeader } from "@/components/kit/page-header";
import { StatTile } from "@/components/kit/stat-tile";
import { QueueList, type QueueItem } from "@/components/kit/queue-list";
import { type SurfaceState } from "@/components/kit/states";
import { fetchTickets } from "@/lib/platform-api";
import {
  severityOf,
  ticketKey,
  type Ticket,
  type TicketsPage,
} from "@/lib/tickets";
import { triageState } from "@/lib/triage";

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
    href: `/platform/tickets/${ticket.ticketNumber}`,
  }));
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

  const state: SurfaceState = triageState(error, null);

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

      <QueueList
        items={page ? toQueueItems(page) : []}
        state={state}
        emptyMessage="Nothing waiting. Every ticket is answered."
      />
    </div>
  );
}
