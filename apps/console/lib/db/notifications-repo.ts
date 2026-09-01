import { tesserixQuery } from "./tesserix";
import type { ReplyEventRow, TicketEventRow } from "../notifications";

/**
 * The bell's reads and its one write.
 *
 * Both feed queries are bounded by a window AND a limit: the window keeps the
 * scan small, the limit keeps the panel scannable.
 *
 * `console_notification_reads` holds ONE watermark per `user_id`, not one
 * per `(user_id, kind)` — `readLastSeenAt`/`writeLastSeenAt` below read and
 * write a single row keyed only on the operator. That is a deliberate,
 * accepted simplification for this phase, not an oversight: `countUnread`
 * (`lib/notifications.ts`) runs on the already capability-filtered list, so
 * day-to-day the watermark only ever measures against kinds the operator can
 * currently see.
 *
 * The one real consequence: an operator who has been opening the bell while
 * holding only `rotate-credentials` (so the watermark has only ever advanced
 * against proposal timestamps), who then GAINS `support`, will find the
 * entire existing ticket backlog older than that watermark on their very
 * next read — it arrives pre-read with `unread: 0`, even though they have
 * never actually seen a single one of those tickets. A per-kind watermark
 * would avoid this; it is not what this phase built.
 */

/** pg parses timestamptz into a Date; the row types (and every consumer:
 *  lexicographic sort, unread comparison, JSON response) want ISO-8601
 *  strings. Normalise once, here, rather than making every caller guess. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("notifications: expected a timestamp");
}

export async function recentTicketRows(
  sinceIso: string,
  limit: number,
): Promise<TicketEventRow[]> {
  const rows = await tesserixQuery<TicketEventRow>(
    `SELECT id::text, product_id, ticket_number, subject,
            submitted_by_name, created_at
       FROM platform_tickets
      WHERE created_at > $1::timestamptz
      ORDER BY created_at DESC
      LIMIT $2`,
    [sinceIso, limit],
  );
  return rows.map((row) => ({ ...row, created_at: toIso(row.created_at) }));
}

export async function recentMerchantReplyRows(
  sinceIso: string,
  limit: number,
): Promise<ReplyEventRow[]> {
  // Merchant replies only. An operator does not need telling that they
  // themselves replied — and ptr_merchant_recent_idx is partial on exactly
  // this predicate.
  const rows = await tesserixQuery<ReplyEventRow>(
    `SELECT r.id::text, r.ticket_id::text, r.author_name, r.created_at,
            t.ticket_number, t.product_id, t.subject
       FROM platform_ticket_replies r
       JOIN platform_tickets t ON t.id = r.ticket_id
      WHERE r.author_type = 'merchant'
        AND r.created_at > $1::timestamptz
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [sinceIso, limit],
  );
  return rows.map((row) => ({ ...row, created_at: toIso(row.created_at) }));
}

export async function readLastSeenAt(userId: string): Promise<string | null> {
  const rows = await tesserixQuery<{ last_seen_at: string }>(
    `SELECT last_seen_at FROM console_notification_reads WHERE user_id = $1`,
    [userId],
  );
  const value = rows[0]?.last_seen_at;
  return value === undefined ? null : toIso(value);
}

export async function writeLastSeenAt(
  userId: string,
  atIso: string,
): Promise<void> {
  await tesserixQuery(
    `INSERT INTO console_notification_reads (user_id, last_seen_at)
     VALUES ($1, $2::timestamptz)
     ON CONFLICT (user_id)
     DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, updated_at = now()`,
    [userId, atIso],
  );
}
