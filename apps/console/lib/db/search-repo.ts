import { tesserixQuery } from "./tesserix";
import type { TicketSearchRow } from "../search";

/**
 * Ticket lookup for the palette.
 *
 * Matches on exactly the fields the palette puts into each item's keywords —
 * number, subject, submitter name and email. CommandItem filters itself with a
 * substring test and offers no way to opt out, so anything this matches on but
 * does not send back as a keyword would be fetched and then silently hidden.
 *
 * `query` is interpolated into an ILIKE pattern, so `%` and `_` in it act as
 * wildcards rather than literal characters. Accepted here: the worst case is
 * a broader match on a bounded, capability-gated read, not an injection risk
 * (the value itself is still passed as a bound parameter).
 */
export async function searchTicketRows(
  query: string,
  limit: number,
): Promise<TicketSearchRow[]> {
  const pattern = `%${query}%`;
  return tesserixQuery<TicketSearchRow>(
    `SELECT id::text, product_id, ticket_number, subject,
            submitted_by_name, submitted_by_email, status
       FROM platform_tickets
      WHERE ticket_number ILIKE $1
         OR subject ILIKE $1
         OR submitted_by_name ILIKE $1
         OR submitted_by_email ILIKE $1
      ORDER BY
        CASE WHEN status IN ('open','in_progress') THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT $2`,
    [pattern, limit],
  );
}
