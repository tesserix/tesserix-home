import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { DetailLayout } from "@/components/kit/detail-layout";
import { type SurfaceState } from "@/components/kit/states";
import { fetchTicketDetail, PlatformApiError } from "@/lib/platform-api";
import { severityOf, type TicketDetail } from "@/lib/tickets";
import { triageState } from "@/lib/triage";
import { requiresCapability } from "@/lib/internal-access";
import { TicketThread } from "./ticket-thread";
import { ReplyForm, StatusControl } from "./respond-controls";

/**
 * One ticket, keyed by UUID — the API supports only id lookup, and a
 * number-lookup endpoint in apps/web is ruled out for surfaces awaiting
 * their milestone.
 *
 * The respond controls render only for operators holding `respond`; the
 * server actions assert it again regardless, because hiding a button is
 * UX, not authorization.
 */
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

  const state: SurfaceState = triageState(error, null);

  if (!detail) {
    return (
      <DetailLayout
        title="Ticket"
        breadcrumbs={[{ label: "Tickets", href: "/platform/tickets" }]}
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
      breadcrumbs={[{ label: "Tickets", href: "/platform/tickets" }]}
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
          label: "Opened",
          value: new Date(ticket.createdAt).toLocaleString(),
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
