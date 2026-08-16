import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { DetailLayout } from "@/components/kit/detail-layout";
// From `surface-state`, not `states`: this is a server component, and
// `states.tsx` is a `"use client"` module whose exports resolve to client
// references here. Type-only today, but the import path is the invariant —
// see components/kit/use-client-boundary.test.ts.
import {
  resolveState,
  toSurfaceError,
  type SurfaceState,
} from "@/components/kit/surface-state";
import { fetchTicketDetail, PlatformApiError } from "@/lib/platform-api";
import { severityOf, type TicketDetail } from "@/lib/tickets";
import { requiresCapability } from "@/lib/internal-access";
import { TicketThread } from "./ticket-thread";
import { ReplyForm, StatusControl } from "./respond-controls";
import { TenantLink } from "./tenant-link";

/**
 * One ticket, keyed by UUID — the API supports only id lookup, and a
 * number-lookup endpoint in apps/web is ruled out for surfaces awaiting
 * their milestone.
 *
 * The respond controls render only for operators holding `respond`; the
 * server actions assert it again regardless, because hiding a button is
 * UX, not authorization.
 */
/**
 * Which state the detail surface is in.
 *
 * The same defect the queue had, and fixed the same way. This called
 * `triageState(error, null)`, which returns only
 * `instrumentation-unavailable | error | ready` — so a null detail with no
 * error resolved to `ready` and rendered an empty `DetailLayout`: a title
 * saying "Ticket", an empty summary rail and no tabs, with nothing anywhere
 * saying the record failed to arrive.
 *
 * `notFound()` covers a 404 before this runs, so a null detail here means the
 * upstream returned something that parsed to nothing — `empty` is the honest
 * reading, and `DetailLayout` renders its own copy for it.
 *
 * Not `filtered`: a record page has no filters to clear.
 */
export function detailState(input: {
  error: unknown;
  detail: TicketDetail | null;
}): SurfaceState {
  return resolveState({
    isLoading: false,
    error: toSurfaceError(input.error),
    rows: input.detail ? [input.detail] : [],
    filtered: false,
  });
}

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieHeader = (await cookies()).toString();

  let detail: TicketDetail | null = null;
  let error: unknown = null;
  try {
    detail = await fetchTicketDetail(id, cookieHeader);
  } catch (caught) {
    if (caught instanceof PlatformApiError && caught.status === 404) {
      notFound();
    }
    error = caught;
  }

  const session = await getCurrentSession();
  const canRespond =
    !requiresCapability() || hasCapability(session?.roles, "respond");

  const state: SurfaceState = detailState({ error, detail });

  if (!detail) {
    return (
      <DetailLayout
        title="Ticket"
        breadcrumbs={[
          { label: "Tickets", href: "/platform/tickets" },
          { label: "Ticket" },
        ]}
        summary={[]}
        tabs={[]}
        state={state}
      />
    );
  }

  const { ticket } = detail;
  return (
    <DetailLayout
      title={`${ticket.ticketNumber} — ${ticket.subject}`}
      breadcrumbs={[
        { label: "Tickets", href: "/platform/tickets" },
        { label: ticket.ticketNumber },
      ]}
      actions={
        canRespond ? (
          <StatusControl ticketId={ticket.id} status={ticket.status} />
        ) : undefined
      }
      summary={[
        { label: "Product", value: ticket.productId },
        { label: "Status", value: ticket.status },
        {
          label: "Priority",
          value: `${ticket.priority}${
            severityOf(ticket.priority) === "critical" ? " — critical" : ""
          }`,
        },
        {
          label: "Submitted by",
          value: ticket.submittedByName
            ? `${ticket.submittedByName} · ${ticket.submittedByEmail}`
            : ticket.submittedByEmail,
        },
        {
          label: "Tenant",
          value: (
            <TenantLink productId={ticket.productId} tenantId={ticket.tenantId} />
          ),
        },
        {
          label: "Opened",
          value: new Date(ticket.createdAt).toLocaleString(),
        },
        // `updatedAt` has been parsed since the surface shipped and never
        // rendered. It is the one field that answers "has anyone touched this
        // lately", which is the question a queue operator opens a ticket with.
        // Optional in the payload, so an absent value says so rather than
        // rendering "Invalid Date".
        {
          label: "Last activity",
          value: ticket.updatedAt
            ? new Date(ticket.updatedAt).toLocaleString()
            : "Not recorded",
        },
        ...(ticket.resolvedAt
          ? [
              {
                label: "Resolved",
                value: new Date(ticket.resolvedAt).toLocaleString(),
              },
            ]
          : []),
      ]}
      tabs={[
        {
          id: "conversation",
          label: "Conversation",
          content: (
            <div className="flex flex-col gap-6">
              <TicketThread detail={detail} />
              {canRespond ? <ReplyForm ticketId={ticket.id} /> : null}
            </div>
          ),
        },
      ]}
    />
  );
}
