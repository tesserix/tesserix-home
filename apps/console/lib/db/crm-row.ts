/**
 * Timestamp coercion shared by every CRM repository module's row mappers.
 *
 * Not SQL, so it does not belong in `crm-sql.ts`, but it is used by the
 * queue, organisation-detail, suppression, handoff and browse readers alike —
 * one definition so the nullable and the NOT NULL contracts below cannot be
 * spelled two different ways in two of them.
 */

/** pg parses timestamptz into a Date; every consumer of a QueueRow wants
 *  ISO-8601 strings. Normalise once, here, rather than making every caller
 *  guess. Nullable: `next_action_at`/`last_contacted_at` are legitimately
 *  absent (no action scheduled, never contacted). */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("crm-repo: expected a timestamp or null");
}

/** `toIso`, but for a column that's `NOT NULL` in the schema — same
 *  fail-loud contract as `toQueueRow`'s `quiet_since`: a null here means the query
 *  stopped selecting the column, not a legitimate absence. */
export function toIsoRequired(value: unknown): string {
  const iso = toIso(value);
  if (iso === null) {
    throw new Error("crm-repo: expected a NOT NULL timestamp");
  }
  return iso;
}
