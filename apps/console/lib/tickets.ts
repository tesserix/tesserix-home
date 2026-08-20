// Imported from `./platform-api-error`, NOT from `./platform-api`. This module
// is reached from `"use client"` components, and `PlatformApiError` is a value
// (thrown, and narrowed with `instanceof`), so a value import of it from
// `./platform-api` is what dragged `pg` into the browser bundle and broke the
// production build. Point it back at `./platform-api` and it breaks again.
import { PlatformApiError } from "./platform-api-error";

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
    rows: asArray(root.rows, "rows").map((raw, i) => parseTicketRow(raw, `rows[${i}]`)),
  };
}

/**
 * Parse the platform API's ticket listing — `{ tickets: [...] }`.
 *
 * The counterpart to `parseTickets`, and the reason there are two.
 *
 * `apps/web` answers one screen-shaped payload: a standing count of the whole
 * queue welded to a filtered page of it, because this component wanted both.
 * The platform API refuses that shape (#269) and serves two domain resources,
 * leaving the composition to whoever is drawing a screen — which is this
 * application, in `fetchTickets`.
 *
 * Both parsers exist while both backends do. `parseTickets` retires with the
 * last call site that reads `/api/admin/*`.
 */
export function parseTicketList(json: unknown): readonly Ticket[] {
  const root = obj(json, "response");
  return asArray(root.tickets, "tickets").map((raw, i) => parseTicketRow(raw, `tickets[${i}]`));
}

/**
 * Parse the platform API's summary — `{ summary: { ... } }`.
 *
 * The keys are snake_case, which is the estate's spelling and what the module
 * serves. Mapped to the camelCase `TicketsSummary` here rather than renamed on
 * either side: the wire format belongs to the API and the field names belong to
 * this codebase, and a parser is exactly the place those two meet.
 */
export function parseTicketsSummary(json: unknown): TicketsSummary {
  const root = obj(json, "response");
  const s = obj(root.summary, "summary");
  return {
    open: num(s.open, "summary.open"),
    inProgress: num(s.in_progress, "summary.in_progress"),
    resolvedThisWeek: num(s.resolved_this_week, "summary.resolved_this_week"),
    urgentOpen: num(s.urgent_open, "summary.urgent_open"),
  };
}

/**
 * One row, from either backend.
 *
 * Extracted from `parseTickets` rather than duplicated, so the two listings
 * cannot disagree about what a ticket is — the failure this whole file exists
 * to prevent is a payload that renders as a plausible-looking blank row.
 */
function parseTicketRow(raw: unknown, path: string): Ticket {
  const r = obj(raw, path);
  return {
    id: str(r.id, `${path}.id`),
    productId: str(r.product_id ?? r.productId, `${path}.product_id`),
    tenantId: String(r.tenant_id ?? r.tenantId ?? ""),
    ticketNumber: str(r.ticket_number ?? r.ticketNumber, `${path}.ticket_number`),
    subject: str(r.subject, `${path}.subject`),
    status: str(r.status, `${path}.status`),
    priority: str(r.priority, `${path}.priority`),
    submittedByName: String(r.submitted_by_name ?? r.submittedByName ?? ""),
    submittedByEmail: String(r.submitted_by_email ?? r.submittedByEmail ?? ""),
    createdAt: str(r.created_at ?? r.createdAt, `${path}.created_at`),
    updatedAt: String(r.updated_at ?? r.updatedAt ?? ""),
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

export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "closed",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

/**
 * The priorities the queue can be filtered by, most urgent first — the same
 * order `listPlatformTickets` sorts by, so the filter reads like the list.
 */
export const TICKET_PRIORITIES = ["urgent", "high", "medium", "low"] as const;

/** `in_progress` is a database value, not a label. Nothing else transforms. */
export function ticketStatusLabel(status: string): string {
  const normalised = status.toLowerCase();
  return normalised === "in_progress"
    ? "In progress"
    : normalised.charAt(0).toUpperCase() + normalised.slice(1);
}

/**
 * Status → badge tone.
 *
 * The five names are the kit's `QueueStatusTone`, deliberately duplicated as a
 * return type rather than imported: `queue-list.tsx` is a `"use client"`
 * module, and this file is read by server components. A structural match is
 * all the compiler needs, and it keeps `lib/` from depending on `components/`.
 *
 * An unknown status is `neutral`, not an alarm: the column carries whatever
 * string the database holds, and a status nobody has assigned a colour to is
 * unclassified, not wrong.
 */
export function ticketStatusTone(
  status: string,
): "neutral" | "info" | "success" | "warning" | "error" {
  switch (status.toLowerCase()) {
    case "open":
      return "info";
    case "in_progress":
      return "warning";
    case "resolved":
      return "success";
    case "closed":
      return "neutral";
    default:
      return "neutral";
  }
}

/**
 * Statuses that end the conversation.
 *
 * A terminal ticket gets an explicit Reopen affordance rather than a status
 * dropdown that happens to contain "open": the operator's intent there is
 * "reopen this", not "pick a status", and a dropdown makes reopening look
 * like an edit to a field rather than a decision.
 *
 * Matched case-insensitively for the same reason `severityOf` is: the API
 * carries the status through as a free string, so a differently-cased value
 * must not silently fall out of the terminal set.
 */
const TERMINAL_STATUSES: readonly string[] = ["resolved", "closed"];

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status.toLowerCase());
}

export interface TicketReply {
  readonly id: string;
  readonly authorType: "merchant" | "platform_admin";
  readonly authorName: string;
  readonly authorEmail: string;
  readonly content: string;
  readonly createdAt: string;
}

export interface TicketDetail {
  readonly ticket: Ticket & {
    readonly description: string;
    readonly resolvedAt: string | null;
  };
  readonly replies: readonly TicketReply[];
}

/**
 * Parse `GET /api/admin/platform-tickets/[id]` — `{ ticket, replies }`.
 *
 * `author_type` is validated against the two known values rather than carried
 * through as a string: it decides whether a message renders as the customer's
 * or the operator's, and a misattributed message is worse than an error.
 */
export function parseTicketDetail(json: unknown): TicketDetail {
  const root = obj(json, "response");
  const t = obj(root.ticket, "ticket");
  return {
    ticket: {
      id: str(t.id, "ticket.id"),
      productId: str(t.product_id ?? t.productId, "ticket.product_id"),
      tenantId: String(t.tenant_id ?? t.tenantId ?? ""),
      ticketNumber: str(t.ticket_number ?? t.ticketNumber, "ticket.ticket_number"),
      subject: str(t.subject, "ticket.subject"),
      description: str(t.description, "ticket.description"),
      status: str(t.status, "ticket.status"),
      priority: str(t.priority, "ticket.priority"),
      submittedByName: String(t.submitted_by_name ?? t.submittedByName ?? ""),
      submittedByEmail: String(t.submitted_by_email ?? t.submittedByEmail ?? ""),
      resolvedAt: typeof t.resolved_at === "string" ? t.resolved_at : null,
      createdAt: str(t.created_at ?? t.createdAt, "ticket.created_at"),
      updatedAt: String(t.updated_at ?? t.updatedAt ?? ""),
    },
    replies: asArray(root.replies, "replies").map((raw, i) => {
      const r = obj(raw, `replies[${i}]`);
      const authorType = str(r.author_type ?? r.authorType, `replies[${i}].author_type`);
      if (authorType !== "merchant" && authorType !== "platform_admin") {
        throw new PlatformApiError(
          `tickets: replies[${i}].author_type is unknown (${authorType})`,
        );
      }
      return {
        id: str(r.id, `replies[${i}].id`),
        authorType,
        authorName: String(r.author_name ?? r.authorName ?? ""),
        authorEmail: String(r.author_email ?? r.authorEmail ?? ""),
        content: str(r.content, `replies[${i}].content`),
        createdAt: str(r.created_at ?? r.createdAt, `replies[${i}].created_at`),
      };
    }),
  };
}
