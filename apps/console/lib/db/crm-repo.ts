import { tesserixQuery } from "./tesserix";
import type { CrmStage } from "../crm";

/**
 * The queue's reads: opportunities due for action, and opportunities that
 * have gone quiet with nothing scheduled.
 *
 * Both queries mirror the partial indexes in migration 0019
 * (crm_opp_due_idx, crm_opp_drifting_idx) — the WHERE clauses match the
 * index predicates exactly so Postgres can use them.
 */

export interface QueueRow {
  id: string;
  organisationId: string;
  organisationName: string;
  product: string | null;
  stage: CrmStage;
  owner: string | null;
  nextActionAt: string | null;
  nextActionNote: string | null;
  lastContactedAt: string | null;
  isStarred: boolean;
}

interface RawQueueRow {
  id: string;
  organisation_id: string;
  organisation_name: string;
  product: string | null;
  stage: CrmStage;
  owner: string | null;
  next_action_at: unknown;
  next_action_note: string | null;
  last_contacted_at: unknown;
  is_starred: boolean;
}

/** pg parses timestamptz into a Date; every consumer of a QueueRow wants
 *  ISO-8601 strings. Normalise once, here, rather than making every caller
 *  guess. Nullable: `next_action_at`/`last_contacted_at` are legitimately
 *  absent (no action scheduled, never contacted). */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("crm-repo: expected a timestamp or null");
}

function toQueueRow(row: RawQueueRow): QueueRow {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    organisationName: row.organisation_name,
    product: row.product,
    stage: row.stage,
    owner: row.owner,
    nextActionAt: toIso(row.next_action_at),
    nextActionNote: row.next_action_note,
    lastContactedAt: toIso(row.last_contacted_at),
    isStarred: row.is_starred,
  };
}

/** Opportunities whose next action has arrived. Terminal deals (won/lost)
 *  are excluded — surfacing them would make the queue a to-do list of things
 *  already finished. Most-overdue-first. */
export async function dueOpportunities(limit: number): Promise<QueueRow[]> {
  const rows = await tesserixQuery<RawQueueRow>(
    `SELECT o.id, o.organisation_id, g.name AS organisation_name,
            o.product, o.stage, o.owner,
            o.next_action_at, o.next_action_note, o.last_contacted_at,
            o.is_starred
       FROM crm_opportunities o
       JOIN crm_organisations g ON g.id = o.organisation_id
      WHERE o.next_action_at <= now()
        AND o.stage NOT IN ('won', 'lost')
      ORDER BY o.next_action_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map(toQueueRow);
}

/** Opportunities with no next action scheduled AND a stale (or absent) last
 *  contact — drifting requires BOTH conditions, not either. An OR here would
 *  surface every scheduled lead as drifting the moment it went quiet, which
 *  is the opposite of the point. Longest-quiet-first (nulls, i.e. never
 *  contacted at all, sort first as the most urgent). */
export async function driftingOpportunities(
  staleDays: number,
  limit: number,
): Promise<QueueRow[]> {
  const rows = await tesserixQuery<RawQueueRow>(
    `SELECT o.id, o.organisation_id, g.name AS organisation_name,
            o.product, o.stage, o.owner,
            o.next_action_at, o.next_action_note, o.last_contacted_at,
            o.is_starred
       FROM crm_opportunities o
       JOIN crm_organisations g ON g.id = o.organisation_id
      WHERE o.next_action_at IS NULL
        AND o.stage NOT IN ('won', 'lost')
        AND (o.last_contacted_at IS NULL
             OR o.last_contacted_at <= now() - ($1 || ' days')::interval)
      ORDER BY o.last_contacted_at ASC NULLS FIRST
      LIMIT $2`,
    [staleDays, limit],
  );
  return rows.map(toQueueRow);
}
