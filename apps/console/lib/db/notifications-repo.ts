import { tesserixQuery } from "./tesserix";
import type { ReplyEventRow, TicketEventRow } from "../notifications";

/**
 * The bell's reads and its one write.
 *
 * Both feed queries are bounded by a window AND a limit: the window keeps the
 * scan small, the limit keeps the panel scannable.
 */

export async function recentTicketRows(
  sinceIso: string,
  limit: number,
): Promise<TicketEventRow[]> {
  return tesserixQuery<TicketEventRow>(
    `SELECT id::text, product_id, ticket_number, subject,
            submitted_by_name, created_at
       FROM platform_tickets
      WHERE created_at > $1::timestamptz
      ORDER BY created_at DESC
      LIMIT $2`,
    [sinceIso, limit],
  );
}

export async function recentMerchantReplyRows(
  sinceIso: string,
  limit: number,
): Promise<ReplyEventRow[]> {
  // Merchant replies only. An operator does not need telling that they
  // themselves replied — and ptr_merchant_recent_idx is partial on exactly
  // this predicate.
  return tesserixQuery<ReplyEventRow>(
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
}

export async function readLastSeenAt(userId: string): Promise<string | null> {
  const rows = await tesserixQuery<{ last_seen_at: string }>(
    `SELECT last_seen_at FROM console_notification_reads WHERE user_id = $1`,
    [userId],
  );
  return rows[0]?.last_seen_at ?? null;
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
