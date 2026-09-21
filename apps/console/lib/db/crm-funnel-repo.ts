import { CRM_STAGES, type CrmStage } from "../crm";
import { notVoided } from "./crm-sql";
import { tesserixQuery } from "./tesserix";

/**
 * The funnel read (#250): the shape of the pipeline, and the deals that are
 * not moving through it.
 *
 * WHY THIS IS CHEAP. Nothing new is recorded for it. `advanceStage` has
 * always written a `crm_activities` row inside the same transaction as the
 * stage change — `kind = 'stage_change'`, `metadata = {from, to}`,
 * `occurred_at`, `actor` — so a stage cannot move without its record.
 * Migration 0019's own comment says that is what the column was for. Until
 * this module, no application query selected it: the richest structured data
 * in the schema was written faithfully and read by nothing.
 *
 * WHAT IS DELIBERATELY NOT HERE. Average time-in-stage across transitions,
 * and per-stage conversion rate, both need a population of `stage_change`
 * rows that does not exist yet — every production opportunity is `new` with
 * zero transitions, so both would render a confidently empty panel today.
 * They become answerable off exactly this data as soon as the CRM is worked.
 * Recorded so the next person knows they were weighed rather than missed.
 *
 * Two statements rather than one. The counts are an aggregate over every
 * stage; the stalled list is a per-row read of the open ones. Folding them
 * into a single query would mean either a window function over a result set
 * the aggregate does not want, or a join that fans each stage's count across
 * its rows. They are also read at different cardinalities — five rows and up
 * to `STALLED_LIMIT` — and stating them separately keeps each statement
 * legible.
 */

/** How many stalled deals the tab lists. A long tail is noise on a panel,
 *  and every one of these rows is reachable from the work queues and the
 *  browse list, which page properly. */
export const STALLED_LIMIT = 20;

export interface StageCount {
  readonly stage: CrmStage;
  readonly count: number;
  /** 0–1 of `FunnelSummary.total`, or 0 when there are no deals at all.
   *  Computed here rather than in the view so the denominator is the one
   *  this module counted, not one the view recomputed from the rows it was
   *  handed. */
  readonly share: number;
}

export interface StalledRow {
  readonly id: string;
  readonly organisationId: string;
  readonly organisationName: string;
  readonly product: string | null;
  readonly stage: CrmStage;
  readonly owner: string | null;
  /** When the deal arrived at the stage it is in: the `occurred_at` of its
   *  most recent `stage_change`, or its `created_at` if it has never moved. */
  readonly since: Date;
}

export interface FunnelSummary {
  /** One entry per `CrmStage`, in `CRM_STAGES` order, always all five. */
  readonly counts: readonly StageCount[];
  readonly total: number;
  readonly stalled: readonly StalledRow[];
}

interface RawStageCount {
  stage: string;
  count: string;
}

interface RawStalledRow {
  id: string;
  organisation_id: string;
  organisation_name: string;
  product: string | null;
  stage: string;
  owner: string | null;
  since: Date;
}

/**
 * Counts by stage, over deals that are actually in the funnel.
 *
 * `notVoided` is the conjunct that carries #251's point rather than merely
 * tidying a query: `voidOpportunity` deliberately accepts a won or lost deal,
 * because a duplicated won row is exactly the close-rate pollution the void
 * exists to remove. A funnel that still counted it would have made the void
 * change nothing an operator reads — which is the whole reason this number
 * was worth stating.
 */
const COUNTS_SQL = `
  SELECT o.stage::text AS stage, count(*)::text AS count
    FROM crm_opportunities o
   WHERE ${notVoided("o")}
   GROUP BY o.stage
`;

/**
 * Open deals, oldest in their current stage first.
 *
 * THE FALLBACK IS THE POINT, not a defensive default. Every production
 * opportunity today is `stage = 'new'` with no transitions at all, so a
 * measure defined purely over `stage_change` rows would render empty until
 * the CRM is actually worked — and a deal that has never moved is precisely
 * the deal worth asking about. `COALESCE` to `created_at` answers "how long
 * has this sat where it is" for both shapes with one number. It is the same
 * fallback `quietSince` already makes in the drifting query, for the same
 * reason.
 *
 * The lateral takes `ORDER BY occurred_at DESC` and not `max(occurred_at)`
 * so it can ride `crm_activities_opp_recent_idx`, which is exactly
 * `(opportunity_id, occurred_at DESC) WHERE opportunity_id IS NOT NULL`.
 *
 * Open stages only: "how long has this won deal been won" is not a question,
 * and including the terminal stages would put every historical close at the
 * top of a list whose whole purpose is to name what needs attention. The
 * predicate is spelled the same way `crm_opp_due_idx` and
 * `crm_opp_drifting_idx` spell it.
 */
const STALLED_SQL = `
  SELECT o.id,
         o.organisation_id,
         g.name AS organisation_name,
         o.product,
         o.stage::text AS stage,
         o.owner,
         COALESCE(a.occurred_at, o.created_at) AS since
    FROM crm_opportunities o
    JOIN crm_organisations g ON g.id = o.organisation_id
    LEFT JOIN LATERAL (
      SELECT act.occurred_at
        FROM crm_activities act
       WHERE act.opportunity_id = o.id
         AND act.kind = 'stage_change'
       ORDER BY act.occurred_at DESC
       LIMIT 1
    ) a ON true
   WHERE o.stage NOT IN ('won', 'lost')
     AND ${notVoided("o")}
   ORDER BY since ASC, o.id ASC
   LIMIT $1
`;

/**
 * Fills in the stages the `GROUP BY` never mentioned.
 *
 * A `GROUP BY` answers nothing for a stage with no deals, and a panel that
 * silently omits `lost` is indistinguishable from one reporting zero losses
 * until the day there is a loss. Iterating `CRM_STAGES` rather than the rows
 * makes "no deals" and "no answer" the same visible zero, and fixes the
 * display order to the funnel's own order instead of whatever the planner
 * returned.
 */
function toStageCounts(raw: readonly RawStageCount[]): {
  counts: StageCount[];
  total: number;
} {
  const byStage = new Map(raw.map((row) => [row.stage, Number(row.count)]));
  const counts = CRM_STAGES.map((stage) => ({ stage, count: byStage.get(stage) ?? 0 }));
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  return {
    counts: counts.map((entry) => ({
      ...entry,
      share: total === 0 ? 0 : entry.count / total,
    })),
    total,
  };
}

function toStalledRow(raw: RawStalledRow): StalledRow {
  return {
    id: raw.id,
    organisationId: raw.organisation_id,
    organisationName: raw.organisation_name,
    product: raw.product,
    stage: raw.stage as CrmStage,
    owner: raw.owner,
    since: raw.since,
  };
}

/**
 * The whole funnel panel's data.
 *
 * Sequential, and `await`ed rather than `allSettled`: unlike the Work tab's
 * two queue groups — which are two independently useful lists, and where one
 * failing must not blank the other — these two reads are one answer. A stage
 * breakdown shown beside a stalled list that silently failed reads as "the
 * pipeline is healthy, nothing is stuck", which is a worse thing to show an
 * operator than an error. A rejection propagates and the tab renders its
 * error state.
 */
export async function funnelSummary(): Promise<FunnelSummary> {
  const rawCounts = await tesserixQuery<RawStageCount>(COUNTS_SQL);
  const rawStalled = await tesserixQuery<RawStalledRow>(STALLED_SQL, [STALLED_LIMIT]);
  const { counts, total } = toStageCounts(rawCounts);
  return { counts, total, stalled: rawStalled.map(toStalledRow) };
}
