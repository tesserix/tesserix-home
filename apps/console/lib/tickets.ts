import { PlatformApiError } from "./platform-api";

/**
 * The cross-product ticket queue.
 *
 * `platform_tickets` lives in `tesserix-postgres` — platform-owned, not a
 * product database — which is why this surface can be built now while most of
 * M7 waits on product APIs. Rows carry `product_id`, so one queue genuinely
 * spans products rather than being one product's inbox with a label.
 */

export type TicketPriority = "urgent" | "high" | "medium" | "low";

export interface Ticket {
  readonly id: string;
  readonly productId: string;
  readonly tenantId: string;
  readonly ticketNumber: string;
  readonly subject: string;
  readonly status: string;
  readonly priority: string;
  readonly submittedByName: string;
  readonly submittedByEmail: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TicketsSummary {
  readonly open: number;
  readonly inProgress: number;
  readonly resolvedThisWeek: number;
  readonly urgentOpen: number;
}

export interface TicketsPage {
  readonly summary: TicketsSummary;
  readonly rows: readonly Ticket[];
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new PlatformApiError(`tickets: ${path} is missing`);
  }
  return value as Record<string, unknown>;
}

function num(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PlatformApiError(`tickets: ${path} is not a number`);
  }
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new PlatformApiError(`tickets: ${path} is not a string`);
  }
  return value;
}

/**
 * Parse the listing.
 *
 * Rejects a malformed payload rather than coercing it. A queue that silently
 * renders an empty row for a ticket is worse than one that errors: the row
 * looks handled.
 */
export function parseTickets(json: unknown): TicketsPage {
  const root = obj(json, "response");
  const s = obj(root.summary, "summary");
  return {
    summary: {
      open: num(s.open, "summary.open"),
      inProgress: num(s.inProgress, "summary.inProgress"),
      resolvedThisWeek: num(s.resolvedThisWeek, "summary.resolvedThisWeek"),
      urgentOpen: num(s.urgentOpen, "summary.urgentOpen"),
    },
    rows: asArray(root.rows, "rows").map((raw, i) => {
      const r = obj(raw, `rows[${i}]`);
      return {
        id: str(r.id, `rows[${i}].id`),
        productId: str(r.product_id ?? r.productId, `rows[${i}].product_id`),
        tenantId: String(r.tenant_id ?? r.tenantId ?? ""),
        ticketNumber: str(
          r.ticket_number ?? r.ticketNumber,
          `rows[${i}].ticket_number`,
        ),
        subject: str(r.subject, `rows[${i}].subject`),
        status: str(r.status, `rows[${i}].status`),
        priority: str(r.priority, `rows[${i}].priority`),
        submittedByName: String(r.submitted_by_name ?? r.submittedByName ?? ""),
        submittedByEmail: String(
          r.submitted_by_email ?? r.submittedByEmail ?? "",
        ),
        createdAt: str(r.created_at ?? r.createdAt, `rows[${i}].created_at`),
        updatedAt: String(r.updated_at ?? r.updatedAt ?? ""),
      };
    }),
  };
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new PlatformApiError(`tickets: ${path} is not an array`);
  }
  return value;
}

/**
 * Priority → visual severity.
 *
 * Deliberately NOT an SLA. `platform_tickets` has no deadline column and no
 * agreed response target, so anything resembling "overdue" here would be
 * invented. Severity says how loud a ticket is; waiting time says how long it
 * has waited; neither claims a breach that nobody has defined.
 */
export function severityOf(priority: string): "critical" | "warning" | "normal" {
  switch (priority.toLowerCase()) {
    case "urgent":
      return "critical";
    case "high":
      return "warning";
    default:
      return "normal";
  }
}

/**
 * Composite key for the queue row.
 *
 * `QueueItem.key` is documented as opaque precisely for cases like this: a
 * ticket is identified to a human by `(product, ticket_number)`, and using the
 * bare UUID would make a duplicate impossible to spot in the rendered list.
 */
export function ticketKey(ticket: Ticket): string {
  return `${ticket.productId}:${ticket.ticketNumber}`;
}
