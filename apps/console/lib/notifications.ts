/**
 * What the bell shows.
 *
 * A notification is DERIVED — a ticket that arrived or a merchant who replied,
 * read from the rows themselves. There is no notifications table and no
 * writer, so an item cannot drift from the thing it describes and cannot
 * outlive it. Everything here links to a ticket a human can open.
 */

export type NotificationKind = "ticket_created" | "merchant_reply";

export interface NotificationItem {
  /** `${kind}:${row id}` — the merged list holds both kinds, and a bare row
   *  id could collide across the two tables. */
  readonly id: string;
  readonly kind: NotificationKind;
  /** The ticket's uuid. The detail route keys on this, never the number. */
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly productId: string;
  readonly subject: string;
  readonly actor: string;
  readonly at: string;
}

export interface NotificationFeed {
  readonly items: readonly NotificationItem[];
  readonly unread: number;
  readonly lastSeenAt: string | null;
}

export const FEED_LIMIT = 20;
export const FEED_WINDOW_DAYS = 14;

export interface TicketEventRow {
  readonly id: string;
  readonly product_id: string;
  readonly ticket_number: string;
  readonly subject: string;
  readonly submitted_by_name: string;
  readonly created_at: string;
}

export interface ReplyEventRow {
  readonly id: string;
  readonly ticket_id: string;
  readonly author_name: string;
  readonly created_at: string;
  readonly ticket_number: string;
  readonly product_id: string;
  readonly subject: string;
}

export function toTicketEvent(row: TicketEventRow): NotificationItem {
  return {
    id: `ticket_created:${row.id}`,
    kind: "ticket_created",
    ticketId: row.id,
    ticketNumber: row.ticket_number,
    productId: row.product_id,
    subject: row.subject,
    actor: row.submitted_by_name,
    at: row.created_at,
  };
}

export function toReplyEvent(row: ReplyEventRow): NotificationItem {
  return {
    id: `merchant_reply:${row.id}`,
    kind: "merchant_reply",
    ticketId: row.ticket_id,
    ticketNumber: row.ticket_number,
    productId: row.product_id,
    subject: row.subject,
    actor: row.author_name,
    at: row.created_at,
  };
}

/** Newest first, then truncated — truncating before sorting would drop new
 *  events from whichever source happened to be longer. */
export function mergeEvents(
  a: readonly NotificationItem[],
  b: readonly NotificationItem[],
  limit: number,
): NotificationItem[] {
  return [...a, ...b]
    .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0))
    .slice(0, limit);
}

/**
 * Unread is derived, never stored.
 *
 * `null` last-seen means the operator has never opened the panel, and that
 * reads as ZERO rather than as the entire window. The alternative ships a bell
 * with every ticket ever in it on the day it launches, which trains everyone
 * to ignore it.
 */
export function countUnread(
  items: readonly NotificationItem[],
  lastSeenAt: string | null,
): number {
  if (!lastSeenAt) return 0;
  return items.filter((item) => item.at > lastSeenAt).length;
}
