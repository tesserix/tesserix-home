import { tesserixQuery, tesserixTx, type TxQuery } from "./tesserix";
import {
  isUsableImportRow,
  requiresProduct,
  type CrmActivityKind,
  type CrmStage,
  type ImportRow,
} from "../crm";

/**
 * The queue's reads: opportunities due for action, and opportunities that
 * have gone quiet with nothing scheduled.
 *
 * Both queries mirror the partial indexes in migration 0019
 * (crm_opp_due_idx, crm_opp_drifting_idx) — the WHERE clauses match the
 * index predicates exactly so Postgres can use them.
 */

/**
 * The queue's filters — applied in SQL, not in TypeScript.
 *
 * Ruling 11: `dueOpportunities`/`driftingOpportunities` are `ORDER BY …
 * LIMIT`. Filtering the *returned* page in TypeScript answers "rows matching
 * the filter among the first N overall", not "the first N rows matching the
 * filter" — a match ranked below the cut-off is silently dropped, which in a
 * work queue is a false negative ("nothing to do") rather than a visible
 * error. The predicates below therefore live in the WHERE clause, ahead of
 * ORDER BY/LIMIT, so a matching row's rank among *all* matching rows — not
 * its rank in the unfiltered set — decides whether it's returned.
 */
export interface QueueFilter {
  product?: string;
  stage?: CrmStage;
  owner?: string;
}

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
  /** COALESCE(last_contacted_at, created_at) — what a row is actually
   *  ordered and filtered by in the drifting query. Named for what it means
   *  rather than exposing raw created_at, so Task 5 renders (and explains)
   *  the order it's given instead of recomputing the same COALESCE in
   *  TypeScript and risking the two copies disagreeing. Present on
   *  dueOpportunities rows too so the shape is uniform across the queue. */
  quietSince: string;
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
  quiet_since: unknown;
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
  const quietSince = toIso(row.quiet_since);
  if (quietSince === null) {
    // quiet_since is COALESCE(last_contacted_at, created_at); created_at is
    // NOT NULL, so this only happens if the query stops selecting it.
    throw new Error("crm-repo: quiet_since must not be null");
  }
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
    quietSince,
    isStarred: row.is_starred,
  };
}

/**
 * Builds `AND …` clauses for an optional product/stage/owner filter, pushing
 * each present value onto `params` as a bound parameter (never interpolated
 * into the SQL string) and returning the clause fragment to splice after the
 * query's own predicates. An absent filter key adds no clause at all — the
 * partial indexes' own predicates stay first and untouched, so
 * `crm_opp_due_idx`/`crm_opp_drifting_idx` remain usable regardless of which
 * filters are active.
 */
function filterClause(filter: QueueFilter, params: unknown[]): string {
  const clauses: string[] = [];
  if (filter.product) {
    params.push(filter.product);
    clauses.push(`o.product = $${params.length}`);
  }
  if (filter.stage) {
    params.push(filter.stage);
    clauses.push(`o.stage = $${params.length}`);
  }
  if (filter.owner) {
    // Bound parameter, so this is not injectable — but an unescaped value
    // still lets `%`/`_` act as LIKE wildcards instead of literal characters
    // (an owner filter of exactly "%" would match every row with a non-null
    // owner). Escaping backslash first (so it doesn't double-escape the
    // characters it introduces), then `%` and `_`, keeps the match a literal
    // substring search; `ESCAPE '\'` tells Postgres `\` is the escape
    // character rather than a literal backslash in the pattern.
    const escaped = filter.owner.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    params.push(`%${escaped}%`);
    clauses.push(`o.owner ILIKE $${params.length} ESCAPE '\\'`);
  }
  return clauses.length > 0 ? `\n        AND ${clauses.join("\n        AND ")}` : "";
}

/** Opportunities whose next action has arrived. Terminal deals (won/lost)
 *  are excluded — surfacing them would make the queue a to-do list of things
 *  already finished. Most-overdue-first. */
export async function dueOpportunities(
  filter: QueueFilter,
  limit: number,
): Promise<QueueRow[]> {
  const params: unknown[] = [];
  const filterSql = filterClause(filter, params);
  params.push(limit);
  const limitParam = params.length;
  const rows = await tesserixQuery<RawQueueRow>(
    `SELECT o.id, o.organisation_id, g.name AS organisation_name,
            o.product, o.stage, o.owner,
            o.next_action_at, o.next_action_note, o.last_contacted_at,
            COALESCE(o.last_contacted_at, o.created_at) AS quiet_since,
            o.is_starred
       FROM crm_opportunities o
       JOIN crm_organisations g ON g.id = o.organisation_id
      WHERE o.next_action_at <= now()
        AND o.stage NOT IN ('won', 'lost')${filterSql}
      ORDER BY o.next_action_at ASC
      LIMIT $${limitParam}`,
    params,
  );
  return rows.map(toQueueRow);
}

/** Opportunities with no next action scheduled AND a stale last contact —
 *  drifting requires BOTH conditions, not either. An OR here would surface
 *  every scheduled lead as drifting the moment it went quiet, which is the
 *  opposite of the point.
 *
 *  NULL `last_contacted_at` means "never contacted", not "contacted at the
 *  dawn of time" — so staleness (and ordering) is measured from
 *  COALESCE(last_contacted_at, created_at). Without this, every freshly
 *  imported lead (NULL last_contacted_at, no next_action_at) would be
 *  instantly drifting, flooding the queue the moment an import finishes.
 *  A never-contacted lead gets the same grace period as a contacted one,
 *  counted from when it entered the system.
 *
 *  This is not index-ordered: crm_opp_drifting_idx is on bare
 *  last_contacted_at, and the COALESCE can't use it for sorting. Left
 *  alone deliberately — the partial predicate (next_action_at IS NULL AND
 *  stage NOT IN ('won','lost')) is what makes the index selective, and at
 *  259 rows a plain sort of the remainder costs nothing. An expression
 *  index would be premature tuning today. */
export async function driftingOpportunities(
  filter: QueueFilter,
  staleDays: number,
  limit: number,
): Promise<QueueRow[]> {
  const params: unknown[] = [];
  const filterSql = filterClause(filter, params);
  params.push(staleDays);
  const staleDaysParam = params.length;
  params.push(limit);
  const limitParam = params.length;
  const rows = await tesserixQuery<RawQueueRow>(
    `SELECT o.id, o.organisation_id, g.name AS organisation_name,
            o.product, o.stage, o.owner,
            o.next_action_at, o.next_action_note, o.last_contacted_at,
            COALESCE(o.last_contacted_at, o.created_at) AS quiet_since,
            o.is_starred
       FROM crm_opportunities o
       JOIN crm_organisations g ON g.id = o.organisation_id
      WHERE o.next_action_at IS NULL
        AND o.stage NOT IN ('won', 'lost')
        AND COALESCE(o.last_contacted_at, o.created_at)
              <= now() - make_interval(days => $${staleDaysParam}::int)${filterSql}
      ORDER BY COALESCE(o.last_contacted_at, o.created_at) ASC
      LIMIT $${limitParam}`,
    params,
  );
  return rows.map(toQueueRow);
}

/**
 * The organisation-detail writes: stage transitions, scheduling the next
 * action, and logging an activity note. See migration 0021's header for
 * the constraint every write here has to respect.
 */

/**
 * Thrown when a write targets a "grandfathered" opportunity — one migration
 * 0021 left sitting at `qualified`/`won`/`lost` with a null `product` (the
 * ~155 rows `NOT VALID` grandfathered past the CHECK's initial scan) — and
 * the caller has no product to supply to fix it.
 *
 * `crm_opp_product_required_when_qualified` is `NOT VALID`, which only skips
 * the constraint's initial validation scan; Postgres still evaluates it on
 * the NEW ROW VERSION of every subsequent UPDATE, including a bare
 * `updated_at = now()`. So a grandfathered row is effectively read-only
 * until a product is supplied. This is thrown *before* that UPDATE runs, so
 * the operator sees a clear, typed prompt instead of a raw Postgres
 * constraint-violation error surfacing through the stack.
 */
export class MissingProductError extends Error {
  constructor(readonly opportunityId: string) {
    super(
      `Opportunity ${opportunityId} was migrated without a product and must be assigned one (via a stage update) before it can be edited.`,
    );
    this.name = "MissingProductError";
  }
}

export interface AdvanceStageInput {
  opportunityId: string;
  to: CrmStage;
  actor: string;
  /** Required whenever `requiresProduct(to)` is true — even if the row
   *  already carries a product from an earlier transition. The caller
   *  supplies it explicitly every time rather than this function silently
   *  reusing whatever is already on the row, so a UI can pre-fill it but an
   *  operator always makes (or confirms) the choice. */
  product?: string;
  /** Required when `to` is "lost". */
  lostReason?: string;
}

/** What actually happened, so a caller (the audit/action layer) can name
 *  and count the write honestly instead of assuming a transition occurred.
 *  `{ stageChanged: false, productChanged: false }` is the no-op case — a
 *  valid, zero-effect outcome, not an error. */
export interface AdvanceStageResult {
  stageChanged: boolean;
  productChanged: boolean;
}

const TERMINAL_STAGES: readonly CrmStage[] = ["won", "lost"];

function isTerminal(stage: CrmStage): boolean {
  return (TERMINAL_STAGES as readonly string[]).includes(stage);
}

/**
 * Advance (or otherwise edit) an opportunity's stage.
 *
 * The rule this function exists to encode: **every stage transition writes
 * a `stage_change` activity, in the same transaction as the stage update,
 * without exception.** It is the only record of when a stage was entered —
 * unreconstructable after the fact — and therefore the only thing that
 * makes funnel measurement possible later. A stage that moved without its
 * activity is the failure this design cannot tolerate, so both writes go
 * through `tesserixTx` on one client: either both land or neither does.
 *
 * A same-stage call is not a transition (guards the guard: logging one
 * unconditionally would fill the timeline with noise and undermine the one
 * thing `stage_change` exists to make trustworthy) — UNLESS it also changes
 * `product`, which is the escape hatch for a grandfathered row: an operator
 * can supply the missing product without moving the stage, and that write
 * goes through (no CHECK violation, since the new row still satisfies
 * `stage IN ('new','contacted') OR product IS NOT NULL`). That write still
 * gets its own activity — a product moving underneath a live deal, silently,
 * is exactly the kind of change the timeline exists to catch — just not a
 * `stage_change` one, because no stage actually changed.
 *
 * Ruling 14: a reverse transition (e.g. `lost` → `qualified`) is ALLOWED,
 * not rejected — mis-marking a deal lost is ordinary human error, and
 * refusing the correction would force a hand-written database fix for a
 * mistake the UI itself permitted. But `closed_at`/`lost_reason` describe
 * the stage being left, not carried baggage: they are recomputed from `to`
 * on every stage change, not only ever added. Leaving a re-opened deal with
 * a stale close date and loss reason would corrupt close-rate and
 * cycle-time reads exactly the way an unlogged transition corrupts the
 * funnel — the design treats a returning business as a NEW opportunity, so
 * this reverse path is a correction, not the normal flow, but the record it
 * leaves must still be honest.
 */
export async function advanceStage(input: AdvanceStageInput): Promise<AdvanceStageResult> {
  const { opportunityId, to, actor, product, lostReason } = input;

  // Validated against the argument alone, before any row is read: a
  // transition into a product-required stage always needs the caller to
  // supply one, so this fails fast without a wasted round trip either way.
  if (requiresProduct(to) && !product) {
    throw new Error(`advanceStage: moving to "${to}" requires a product`);
  }
  if (to === "lost" && !lostReason) {
    throw new Error('advanceStage: moving to "lost" requires a lostReason');
  }

  return tesserixTx(async (query) => {
    const rows = await query<{
      stage: CrmStage;
      organisation_id: string;
      product: string | null;
    }>(
      `SELECT stage, organisation_id, product
         FROM crm_opportunities
        WHERE id = $1
          FOR UPDATE`,
      [opportunityId],
    );
    const current = rows[0];
    if (!current) {
      throw new Error(`advanceStage: opportunity ${opportunityId} not found`);
    }

    const stageChanging = current.stage !== to;
    const productChanging = product !== undefined && product !== current.product;

    if (!stageChanging && !productChanging) {
      return { stageChanged: false, productChanged: false };
    }

    const setClauses = ["updated_at = now()"];
    const params: unknown[] = [opportunityId];
    if (stageChanging) {
      params.push(to);
      setClauses.push(`stage = $${params.length}`);
      // Recomputed from `to`, not conditionally appended: entering a
      // terminal stage sets these, but LEAVING one (Ruling 14's reverse
      // transition) must clear them just as deliberately, or a corrected
      // "lost" deal keeps its close date and reason forever.
      setClauses.push(isTerminal(to) ? "closed_at = now()" : "closed_at = NULL");
      params.push(to === "lost" ? lostReason : null);
      setClauses.push(`lost_reason = $${params.length}`);
    }
    if (productChanging) {
      params.push(product);
      setClauses.push(`product = $${params.length}`);
    }

    await query(
      `UPDATE crm_opportunities SET ${setClauses.join(", ")} WHERE id = $1`,
      params,
    );

    if (stageChanging) {
      await query(
        `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body, metadata)
         VALUES ($1, $2, 'stage_change', $3, $4, $5::jsonb)`,
        [
          current.organisation_id,
          opportunityId,
          actor,
          `${current.stage} → ${to}`,
          JSON.stringify({ from: current.stage, to }),
        ],
      );
    } else if (productChanging) {
      // Not a stage_change — the timeline's audience needs to be able to
      // tell "the deal moved" from "someone re-pointed it to a different
      // product without moving it" apart, which is exactly what a shared
      // activity kind would erase.
      await query(
        `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body, metadata)
         VALUES ($1, $2, 'note', $3, $4, $5::jsonb)`,
        [
          current.organisation_id,
          opportunityId,
          actor,
          `Product set to ${product} (was ${current.product ?? "none"})`,
          JSON.stringify({ productFrom: current.product, productTo: product }),
        ],
      );
    }

    return { stageChanged: stageChanging, productChanged: productChanging };
  });
}

export interface SetNextActionInput {
  opportunityId: string;
  at: string | null;
  note: string | null;
  actor: string;
}

/**
 * Schedule (or clear) an opportunity's next action.
 *
 * Reads the current row first, inside the same transaction as the UPDATE,
 * specifically to catch the grandfathered-row case: this function has no
 * `product` argument to offer, so if the row needs one and doesn't have
 * one, there is no way for this call to satisfy the CHECK. Refusing here
 * with `MissingProductError` — before the UPDATE runs — is the difference
 * between a clear prompt and a raw constraint-violation error reaching the
 * operator. crm_opportunities has no `updated_at` trigger, so the write
 * sets it explicitly.
 */
export async function setNextAction(input: SetNextActionInput): Promise<void> {
  // `actor` is part of the interface for parity with `advanceStage` and
  // `logActivity`, and so a caller has it in hand for the audit row the
  // action layer writes — but this function itself only ever touches
  // `crm_opportunities`, so it isn't threaded through here.
  const { opportunityId, at, note } = input;

  await tesserixTx(async (query) => {
    const rows = await query<{ stage: CrmStage; product: string | null }>(
      `SELECT stage, product FROM crm_opportunities WHERE id = $1 FOR UPDATE`,
      [opportunityId],
    );
    const current = rows[0];
    if (!current) {
      throw new Error(`setNextAction: opportunity ${opportunityId} not found`);
    }
    if (requiresProduct(current.stage) && !current.product) {
      throw new MissingProductError(opportunityId);
    }

    await query(
      `UPDATE crm_opportunities
          SET next_action_at = $2, next_action_note = $3, updated_at = now()
        WHERE id = $1`,
      [opportunityId, at, note],
    );
  });
}

export interface LogActivityInput {
  organisationId: string;
  opportunityId?: string;
  kind: CrmActivityKind;
  actor: string;
  body?: string;
}

/**
 * Activity kinds that record a real touch between us and the business —
 * outbound or inbound. Logging one of these means contact happened, so it is
 * what `last_contacted_at` (the drift clock the queue reads) must move for.
 *
 * `note`, `stage_change` and `assigned` are deliberately absent: they are
 * things WE did to our own record, not contact with anyone. Counting an
 * internal note as contact would silently reset the drift clock on an
 * organisation nobody has actually spoken to — the exact false "recently
 * contacted" the drift rule exists to expose.
 */
const CONTACT_ACTIVITY_KINDS: ReadonlySet<CrmActivityKind> = new Set([
  "dm_sent",
  "dm_received",
  "email_sent",
  "email_received",
  "call",
]);

/** The subset of the above that is US reaching OUT. Only these are gated on
 *  the do-not-contact list: recording that someone emailed *us*, or that we
 *  took their call, is not outreach and must stay loggable — refusing to
 *  record an inbound message from a suppressed person would destroy the
 *  record of the very contact that most needs one. */
const OUTBOUND_ACTIVITY_KINDS: ReadonlySet<CrmActivityKind> = new Set([
  "dm_sent",
  "email_sent",
  "call",
]);

/**
 * Thrown when outreach is logged against an organisation whose contacts are
 * on the do-not-contact list. design.md:224 says the list is checked "at
 * import and when logging outreach"; before this, only the two import
 * callers checked, so half of what the feature claims was absent. An
 * allowlisted, operator-facing exception (see `mapError` in
 * `lib/crm-write.ts`) rather than a generic failure: an operator who just
 * hit this needs to know WHY, or they will simply try again.
 */
export class SuppressedContactError extends Error {
  constructor(readonly organisationId: string) {
    super(
      "This organisation is on the do-not-contact list. Remove the suppression before logging outreach.",
    );
    this.name = "SuppressedContactError";
  }
}

/**
 * Log a note/call/message activity, independent of any stage change.
 *
 * `crm_activities` carries no CHECK tying it to `crm_opportunities.product`
 * — the grandfathered-row constraint (migration 0021) applies only to
 * `crm_opportunities` — so this needs no product guard.
 *
 * It does need a transaction, for two reasons this function did not have
 * before:
 *
 * (1) Suppression (design.md:224). Outbound kinds are refused if any of the
 *     organisation's contacts is suppressed — read on the transaction's own
 *     client, so the check and the insert cannot straddle a concurrent
 *     suppression being added.
 * (2) The drift clock. `last_contacted_at` was written by NOTHING in the
 *     application — only the migration set it — so logging a DM or a call
 *     left the queue still reporting the organisation as quiet since
 *     whenever the backfill said. The activity row and the timestamp it
 *     implies must land together or not at all; a logged call with a stale
 *     "quiet since" is worse than either alone.
 *
 * `updated_at` is set explicitly. There are no triggers on these tables.
 */
export async function logActivity(input: LogActivityInput): Promise<void> {
  await tesserixTx(async (query) => {
    if (OUTBOUND_ACTIVITY_KINDS.has(input.kind)) {
      const contacts = await query<{ email: string | null; instagram_handle: string | null }>(
        `SELECT email, instagram_handle FROM crm_contacts WHERE organisation_id = $1`,
        [input.organisationId],
      );
      for (const contact of contacts) {
        const suppressed = await isSuppressed(
          {
            email: contact.email ?? undefined,
            instagramHandle: contact.instagram_handle ?? undefined,
          },
          query,
        );
        if (suppressed) {
          throw new SuppressedContactError(input.organisationId);
        }
      }
    }

    await query(
      `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.organisationId,
        input.opportunityId ?? null,
        input.kind,
        input.actor,
        input.body ?? null,
      ],
    );

    // Only when the activity is attached to a deal: `last_contacted_at`
    // lives on `crm_opportunities`, and an organisation-level activity has
    // no one deal whose clock it would be honest to reset.
    if (input.opportunityId && CONTACT_ACTIVITY_KINDS.has(input.kind)) {
      await query(
        `UPDATE crm_opportunities
            SET last_contacted_at = now(), updated_at = now()
          WHERE id = $1`,
        [input.opportunityId],
      );
    }
  });
}

/**
 * The organisation-detail read: the business, its people, its deals across
 * every product, and its activity history. Four queries rather than one
 * giant join — the tables fan out (many contacts, many opportunities, many
 * activities per organisation) in ways a single join would either duplicate
 * rows for or force into nested JSON aggregation; four flat reads are
 * simpler to reason about at these row counts.
 */

export interface OrganisationRow {
  id: string;
  name: string;
  websiteUrl: string | null;
  location: string | null;
  category: readonly string[];
  tags: readonly string[];
  convertedProduct: string | null;
  convertedLabel: string | null;
  convertedAt: string | null;
  createdAt: string;
}

export interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  instagramHandle: string | null;
  isPrimary: boolean;
}

export interface OpportunityRow {
  id: string;
  product: string | null;
  stage: CrmStage;
  owner: string | null;
  nextActionAt: string | null;
  nextActionNote: string | null;
  lastContactedAt: string | null;
  isStarred: boolean;
  closedAt: string | null;
  lostReason: string | null;
  createdAt: string;
}

export interface ActivityRow {
  id: string;
  opportunityId: string | null;
  kind: CrmActivityKind;
  actor: string;
  body: string | null;
  occurredAt: string;
}

export interface OrganisationDetail {
  organisation: OrganisationRow;
  contacts: readonly ContactRow[];
  opportunities: readonly OpportunityRow[];
  activities: readonly ActivityRow[];
}

/** Most recent activities shown on a detail page — a full history is a job
 *  for export/search, not this view. */
const ACTIVITY_LIMIT = 200;

/** `toIso`, but for a column that's `NOT NULL` in the schema — same
 *  fail-loud contract as `quiet_since` above: a null here means the query
 *  stopped selecting the column, not a legitimate absence. */
function toIsoRequired(value: unknown): string {
  const iso = toIso(value);
  if (iso === null) {
    throw new Error("crm-repo: expected a NOT NULL timestamp");
  }
  return iso;
}

/** `null` for "no such organisation" — the caller (the page) turns that into
 *  `notFound()`, the same contract `fetchTicketDetail` uses. */
export async function organisationDetail(organisationId: string): Promise<OrganisationDetail | null> {
  const orgRows = await tesserixQuery<{
    id: string;
    name: string;
    website_url: string | null;
    location: string | null;
    category: string[];
    tags: string[];
    converted_product: string | null;
    converted_label: string | null;
    converted_at: unknown;
    created_at: unknown;
  }>(
    `SELECT id, name, website_url, location, category, tags,
            converted_product, converted_label, converted_at, created_at
       FROM crm_organisations
      WHERE id = $1`,
    [organisationId],
  );
  const org = orgRows[0];
  if (!org) return null;

  const [contactRows, opportunityRows, activityRows] = await Promise.all([
    tesserixQuery<{
      id: string;
      name: string | null;
      email: string | null;
      phone: string | null;
      instagram_handle: string | null;
      is_primary: boolean;
    }>(
      `SELECT id, name, email, phone, instagram_handle, is_primary
         FROM crm_contacts
        WHERE organisation_id = $1
        ORDER BY is_primary DESC, name ASC NULLS LAST`,
      [organisationId],
    ),
    tesserixQuery<{
      id: string;
      product: string | null;
      stage: CrmStage;
      owner: string | null;
      next_action_at: unknown;
      next_action_note: string | null;
      last_contacted_at: unknown;
      is_starred: boolean;
      closed_at: unknown;
      lost_reason: string | null;
      created_at: unknown;
    }>(
      `SELECT id, product, stage, owner, next_action_at, next_action_note,
              last_contacted_at, is_starred, closed_at, lost_reason, created_at
         FROM crm_opportunities
        WHERE organisation_id = $1
        ORDER BY created_at DESC`,
      [organisationId],
    ),
    tesserixQuery<{
      id: string;
      opportunity_id: string | null;
      kind: CrmActivityKind;
      actor: string;
      body: string | null;
      occurred_at: unknown;
    }>(
      `SELECT id, opportunity_id, kind, actor, body, occurred_at
         FROM crm_activities
        WHERE organisation_id = $1
        ORDER BY occurred_at DESC
        LIMIT $2`,
      [organisationId, ACTIVITY_LIMIT],
    ),
  ]);

  return {
    organisation: {
      id: org.id,
      name: org.name,
      websiteUrl: org.website_url,
      location: org.location,
      category: org.category,
      tags: org.tags,
      convertedProduct: org.converted_product,
      convertedLabel: org.converted_label,
      convertedAt: toIso(org.converted_at),
      createdAt: toIsoRequired(org.created_at),
    },
    contacts: contactRows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      instagramHandle: row.instagram_handle,
      isPrimary: row.is_primary,
    })),
    opportunities: opportunityRows.map((row) => ({
      id: row.id,
      product: row.product,
      stage: row.stage,
      owner: row.owner,
      nextActionAt: toIso(row.next_action_at),
      nextActionNote: row.next_action_note,
      lastContactedAt: toIso(row.last_contacted_at),
      isStarred: row.is_starred,
      closedAt: toIso(row.closed_at),
      lostReason: row.lost_reason,
      createdAt: toIsoRequired(row.created_at),
    })),
    activities: activityRows.map((row) => ({
      id: row.id,
      opportunityId: row.opportunity_id,
      kind: row.kind,
      actor: row.actor,
      body: row.body,
      occurredAt: toIsoRequired(row.occurred_at),
    })),
  };
}

/**
 * The do-not-contact list (migration 0019's `crm_suppressions`).
 *
 * Ships before Task 8 (import): a suppression added after the first import
 * cannot retroactively protect anyone it should have. Matching is
 * case-insensitive on both keys — the table's two partial UNIQUE indexes are
 * on `lower(email)`/`lower(instagram_handle)`, so a lookup that compared the
 * raw value would miss a match that differs only in case, and then collide
 * on the very next insert.
 *
 * Ruling 18: Instagram handles also need to be format-insensitive, not just
 * case-insensitive. A handle is written with or without a leading `@`
 * depending on where it came from (the form's own placeholder is
 * `@bondibaker`; an imported row will plausibly carry `bondibaker`), and
 * `lower()` alone does not bridge that gap — a suppressed person keyed one
 * way would silently fail to match a lookup keyed the other, which is
 * exactly the failure this feature exists to prevent. `normalizeInstagramHandle`
 * strips a leading `@` and lowercases, and runs on both the write path
 * (`addSuppression`) and the read path (`isSuppressed`), so the stored and
 * the queried form can never disagree about which is canonical.
 *
 * Ruling 17: no `auditedOperation` in this module. It briefly lived on
 * `removeSuppression` directly, on the theory that removal — the
 * consequential direction, since it is what re-exposes someone who asked not
 * to be contacted — needed its own guarantee. It didn't: the capability gate
 * has to live at the action layer regardless (a repo function has no session
 * to check), so auditing here too would just put the same guarantee in two
 * places that could drift, which is what happened. `apps/console/lib/crm-write.ts`'s
 * `withCrmWrite` is the one place both CRM action surfaces audit through now.
 */

export interface SuppressionRow {
  id: string;
  email: string | null;
  instagramHandle: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
}

interface RawSuppressionRow {
  id: string;
  email: string | null;
  instagram_handle: string | null;
  reason: string;
  created_by: string;
  created_at: unknown;
}

function toSuppressionRow(row: RawSuppressionRow): SuppressionRow {
  return {
    id: row.id,
    email: row.email,
    instagramHandle: row.instagram_handle,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: toIsoRequired(row.created_at),
  };
}

/** Strips a leading `@` and lowercases, so `@BondiBaker` and `bondibaker`
 *  are the same key on both the write and the read side (Ruling 18). */
function normalizeInstagramHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}

export interface SuppressionCheck {
  email?: string;
  instagramHandle?: string;
}

/**
 * Whether either key is already on the list. `false` — not a thrown error —
 * when neither key is supplied: there is nothing to check, and the caller
 * (an import row with neither an email nor a handle) should not have to
 * special-case that itself.
 *
 * Ruling 23: `query` defaults to `tesserixQuery` (its own pooled connection)
 * for every existing caller, but `commitImport` passes its transaction's own
 * scoped query instead. That matters for two reasons, not one:
 *
 * (1) Correctness — a lookup on a separate connection cannot see the
 *     transaction's own uncommitted inserts. Two CSV rows sharing an email
 *     is ordinary content for a scraped leads sheet, not an edge case: row
 *     1's `crm_contacts` insert must be visible to row 2's dedup check, or
 *     row 2 attempts a second insert and trips `crm_contacts_email_lower_uq`
 *     — inside the transaction, rolling the *entire batch* back after a
 *     preview that promised N creations.
 * (2) Connections — `commitImport` already holds one pooled client for its
 *     transaction; acquiring a second one per row, twice, against a pool of
 *     `max: 2` (`tesserix.ts`), is how two operators committing at once
 *     deadlock each other out of the pool entirely.
 */
export async function isSuppressed(
  input: SuppressionCheck,
  query: TxQuery = tesserixQuery,
): Promise<boolean> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.email) {
    // Trimmed to match the write path (`addSuppression`) and the database
    // trigger (migration 0022), both of which store `trim(lower(email))`.
    // Before Ruling 19 neither side trimmed, so an untrimmed lookup still
    // matched an untrimmed stored value; now that the stored form is always
    // canonical, a lookup that skips this trim can miss a real match on
    // nothing but leading/trailing whitespace — exactly the input a CSV
    // import (Task 8) carries as a matter of course.
    params.push(input.email.trim());
    clauses.push(`lower(email) = lower($${params.length})`);
  }
  if (input.instagramHandle) {
    params.push(normalizeInstagramHandle(input.instagramHandle));
    clauses.push(`lower(instagram_handle) = lower($${params.length})`);
  }
  if (clauses.length === 0) return false;

  const rows = await query<{ id: string }>(
    `SELECT id FROM crm_suppressions WHERE ${clauses.join(" OR ")} LIMIT 1`,
    params,
  );
  return rows.length > 0;
}

export interface AddSuppressionInput {
  email?: string;
  instagramHandle?: string;
  reason: string;
  actor: string;
}

/**
 * Add someone to the do-not-contact list. Not audited — adding is the safe
 * direction (see the module comment), and every row already carries
 * `created_by`/`created_at`, which is its own record of who added it and
 * when.
 *
 * Validated here, before the database is touched, so a caller that forgot
 * both keys gets a clear error rather than tripping `crm_suppression_has_a_key`
 * as a raw constraint violation.
 */
export async function addSuppression(input: AddSuppressionInput): Promise<SuppressionRow> {
  if (!input.email && !input.instagramHandle) {
    throw new Error("addSuppression: requires an email or an instagram handle");
  }
  // Trimmed at the boundary, same as `normalizeInstagramHandle` does for the
  // handle — the database trigger (migration 0022, Ruling 19) is the
  // invariant, this is belt-and-braces so the common case never round-trips
  // through it to look normal.
  const email = input.email ? input.email.trim().toLowerCase() : null;
  const rows = await tesserixQuery<RawSuppressionRow>(
    `INSERT INTO crm_suppressions (email, instagram_handle, reason, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, instagram_handle, reason, created_by, created_at`,
    [
      email,
      input.instagramHandle ? normalizeInstagramHandle(input.instagramHandle) : null,
      input.reason,
      input.actor,
    ],
  );
  return toSuppressionRow(rows[0]);
}

/** Every suppression, newest first — the list is small enough that a plain
 *  unpaginated read is honest about what it's for: a short, human-reviewed
 *  do-not-contact register, not a growing operational table. */
export async function listSuppressions(): Promise<SuppressionRow[]> {
  const rows = await tesserixQuery<RawSuppressionRow>(
    `SELECT id, email, instagram_handle, reason, created_by, created_at
       FROM crm_suppressions
      ORDER BY created_at DESC`,
  );
  return rows.map(toSuppressionRow);
}

/** What `removeSuppression`'s DELETE reports back — enough for the caller's
 *  `describe` to name both the real outcome (Important 3: `rows.length`) and
 *  the accountable identifier (Ruling 20: the email/handle, not the uuid it
 *  was looked up by — see `suppressions/actions.ts`). */
export interface RemovedSuppression {
  id: string;
  email: string | null;
  instagramHandle: string | null;
}

/**
 * Take someone off the do-not-contact list.
 *
 * Plain data access (Ruling 17) — the action layer (`suppressions/actions.ts`,
 * via `withCrmWrite`) is what audits this, since accountability for a CRM
 * write lives at the layer that already has a session to check. `RETURNING`
 * is what lets the caller's `describe` report the real outcome —
 * `{ removed: rows.length }` — rather than assuming a match: `DELETE …
 * WHERE id = $1` on an id that no longer exists succeeds with zero rows,
 * and an audit row claiming `{ removed: 1 }` for that would be recording a
 * removal that never happened. `email`/`instagram_handle` are returned
 * alongside `id` for the same reason: the caller only has the uuid it
 * looked the row up by, and the identifier worth putting in the audit
 * trail (Ruling 20) is only knowable once the row is in hand.
 */
export async function removeSuppression(id: string): Promise<RemovedSuppression[]> {
  const rows = await tesserixQuery<{
    id: string;
    email: string | null;
    instagram_handle: string | null;
  }>(
    `DELETE FROM crm_suppressions WHERE id = $1 RETURNING id, email, instagram_handle`,
    [id],
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    instagramHandle: row.instagram_handle,
  }));
}

/**
 * CSV import (Task 8).
 *
 * The rule this section exists to hold: **suppression is checked at BOTH
 * preview and commit, never only at preview.** A preview can be minutes
 * old; someone can be suppressed in the gap between an operator reviewing a
 * preview and clicking "commit", and skipping the check on commit would
 * then contact a person who asked not to be. Both `previewImport` and
 * `commitImport` call `isSuppressed` — the same function, the same
 * trimmed/lowercased email and `normalizeInstagramHandle`'d Instagram
 * comparison the do-not-contact list itself uses — so the two paths can
 * never disagree about who is protected.
 *
 * `previewImport` never calls `tesserixTx` and issues no INSERT/UPDATE at
 * all — the "dry run writes nothing" guarantee is structural (there is no
 * write statement anywhere in the function to accidentally reach), not a
 * single early return a later edit could route around.
 */

/**
 * An existing organisation this row's contact details already match, if
 * any — checked against `crm_contacts`' own unique indexes
 * (`crm_contacts_email_lower_uq` on lower(email), migration 0019;
 * `crm_contacts_instagram_lower_uq` on lower(instagram_handle), migration
 * 0023), the same two keys `crm_suppressions` is keyed on. A row that
 * matches gets counted, not silently merged: this import does not attempt
 * to update an existing organisation's details, only to avoid creating a
 * duplicate one.
 *
 * The handle index arrived late (issue #215: 0019 shipped it plain, not
 * unique, while this comment and the import's dedup both assumed
 * otherwise), so the `ORDER BY` below is not redundant with it. With both
 * indexes in place at most one row can match either clause, and the order
 * decides nothing; it exists for the case where they are somehow not — a
 * database predating 0023, or one where the index was dropped — so that a
 * wrong answer is at least the SAME wrong answer on every call. `created_at`
 * first because the oldest contact is the one earlier imports already
 * resolved this handle to, so answers stay stable as newer rows arrive
 * rather than flipping to whichever duplicate landed last; `id` as
 * tie-break because `created_at` has no uniqueness of its own and two
 * contacts written in the same transaction share it exactly.
 *
 * Exported (not `previewImport`/`commitImport`-only) so a caller can
 * directly test that the `query` override — the mechanism Ruling 23 relies
 * on — actually takes precedence over the module's own `tesserixQuery`,
 * without having to drive the whole of `commitImport` to observe it.
 *
 * `query` defaults to `tesserixQuery`: see `isSuppressed`'s doc comment for
 * why `commitImport` passes its transaction's own scoped query instead.
 */
export async function findMatchingOrganisationId(
  input: SuppressionCheck,
  query: TxQuery = tesserixQuery,
): Promise<string | null> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.email) {
    params.push(input.email.trim());
    clauses.push(`lower(email) = lower($${params.length})`);
  }
  if (input.instagramHandle) {
    params.push(normalizeInstagramHandle(input.instagramHandle));
    clauses.push(`lower(instagram_handle) = lower($${params.length})`);
  }
  if (clauses.length === 0) return null;

  const rows = await query<{ organisation_id: string }>(
    `SELECT organisation_id FROM crm_contacts WHERE ${clauses.join(" OR ")}
      ORDER BY created_at, id LIMIT 1`,
    params,
  );
  return rows[0]?.organisation_id ?? null;
}

export interface ImportPreview {
  toCreate: number;
  matchedExisting: number;
  skippedSuppressed: number;
  malformed: number;
  /** The rows that matched an existing organisation, in order — cheap to
   *  keep (no extra query: `commitImport`/`previewImport` already has the
   *  row in hand at the point it decides `matchedExisting`) and is what lets
   *  the UI name which businesses' CSV data was left on the floor, rather
   *  than reporting a bare count an operator can misread as "updated". */
  matchedRows: readonly ImportRow[];
}

/** Normalised keys a row could be deduped on, namespaced (`email:`/`ig:`)
 *  so an email and an Instagram handle can never collide with each other's
 *  normal form. Shared by `previewImport`'s in-batch dedup set below — the
 *  same trim/lowercase (email) and `normalizeInstagramHandle` (handle) the
 *  database's own unique indexes and `isSuppressed` use, so this can never
 *  disagree with what a real insert would collide on — true of the handle
 *  only since migration 0023 added `crm_contacts_instagram_lower_uq`; before
 *  it, this set was the ONLY thing stopping two contacts sharing one
 *  canonical handle (issue #215). One residual gap, inherited from the index
 *  being expressed over `lower()` alone: the database sees `@bondibaker` and
 *  `bondibaker` as distinct where this function sees one key. Every writer in
 *  this repo normalises before insert (`commitImport` below,
 *  migrate-leads-to-crm.mjs), so the two only diverge for a row written by
 *  hand — `crm_contacts` has no normalising trigger, unlike
 *  `crm_suppressions` since 0022. */
function importRowKeys(row: ImportRow): string[] {
  const keys: string[] = [];
  if (row.email) keys.push(`email:${row.email.trim().toLowerCase()}`);
  if (row.instagramHandle) keys.push(`ig:${normalizeInstagramHandle(row.instagramHandle)}`);
  return keys;
}

/**
 * Dry-run a batch of parsed CSV rows: how many would create a new
 * organisation, how many match one that already exists, how many are
 * suppressed, and how many carry nothing usable at all. Writes nothing —
 * see the module comment.
 *
 * Important 1 (review round 2): earlier this ran entirely on
 * `tesserixQuery` with no memory across rows, on the theory that a preview
 * has no transaction of its own for a later row to see. That's still true
 * of the DATABASE, but it left a gap this function itself has to close: two
 * rows in the same preview sharing an email — "ordinary content for a
 * scraped leads sheet" is this module's own description of that input —
 * both previewed as `toCreate`, while `commitImport` (Ruling 23) correctly
 * resolves the second as `matchedExisting`. Same input, two different
 * numbers, on the one page whose entire premise is "preview what this would
 * do." `seenKeys` is this function's own in-memory memory of every row IT
 * has already decided to create in THIS SAME preview — not a database read,
 * so it costs nothing extra, and it is what lets a preview agree with what
 * `commitImport` will actually do without needing a transaction to prove it.
 */
export async function previewImport(rows: readonly ImportRow[]): Promise<ImportPreview> {
  let toCreate = 0;
  let matchedExisting = 0;
  let skippedSuppressed = 0;
  let malformed = 0;
  const matchedRows: ImportRow[] = [];
  const seenKeys = new Set<string>();

  for (const row of rows) {
    if (!isUsableImportRow(row)) {
      malformed++;
      continue;
    }
    const check: SuppressionCheck = { email: row.email, instagramHandle: row.instagramHandle };
    if (await isSuppressed(check)) {
      skippedSuppressed++;
      continue;
    }

    const keys = importRowKeys(row);
    if (keys.some((key) => seenKeys.has(key))) {
      // An earlier row in this SAME batch already claimed this identity —
      // exactly the case `commitImport` resolves via the transaction seeing
      // its own uncommitted insert (Ruling 23). No database round trip
      // needed to know the answer: this preview already decided to create
      // that row.
      matchedExisting++;
      matchedRows.push(row);
      continue;
    }

    const matchedId = await findMatchingOrganisationId(check);
    if (matchedId) {
      matchedExisting++;
      matchedRows.push(row);
    } else {
      toCreate++;
      // Registered only on the branch that will actually create something
      // new — mirrors `commitImport`, where only a row that reaches its own
      // `crm_contacts` insert becomes visible to a later row's lookup. A
      // row that matched an existing organisation doesn't need to be
      // remembered here: any later row sharing its identity will
      // independently find the same durably-committed match via
      // `findMatchingOrganisationId`.
      keys.forEach((key) => seenKeys.add(key));
    }
  }

  return { toCreate, matchedExisting, skippedSuppressed, malformed, matchedRows };
}

export interface ImportResult {
  importId: string;
  created: number;
  matchedExisting: number;
  skippedSuppressed: number;
  malformed: number;
  matchedRows: readonly ImportRow[];
}

/**
 * Commit a batch of parsed CSV rows: one `crm_imports` row for the batch,
 * one `crm_organisations`/`crm_contacts`/`crm_opportunities` triple per row
 * that creates something new, all in a single transaction — either the
 * whole batch lands or none of it does, so a failure partway through never
 * leaves an orphaned `crm_imports` row with no organisations to show for it.
 *
 * Re-checks suppression per row, exactly like `previewImport` — see the
 * module comment for why a stale preview cannot be trusted to have already
 * covered it. A row matching an existing organisation is counted but not
 * written, same as at preview: this does not merge into or update the
 * existing row.
 *
 * `product` is never set: an imported lead was never matched to a product
 * (migration 0019's comment on `crm_opportunities.product`), and every
 * created opportunity lands at stage `new`, the one stage the
 * `crm_opp_product_required_when_qualified` CHECK allows without one.
 *
 * `totalRows`, when supplied, is the size of the ORIGINAL file — including
 * rows `parseImportCsv` already dropped as malformed before this function
 * ever saw them (`lib/crm.ts`'s `ParsedImport.malformed`). Without it,
 * `crm_imports.row_count` would under-report the file by exactly that many
 * rows. Defaults to `rows.length` so a caller that only has the parsed rows
 * (every existing test, and any future direct caller) still gets a
 * self-consistent record.
 */
export async function commitImport(
  rows: readonly ImportRow[],
  actor: string,
  filename?: string,
  totalRows: number = rows.length,
): Promise<ImportResult> {
  return tesserixTx(async (query) => {
    let created = 0;
    let matchedExisting = 0;
    let skippedSuppressed = 0;
    let malformed = 0;
    const matchedRows: ImportRow[] = [];

    const importRows = await query<{ id: string }>(
      `INSERT INTO crm_imports (filename, created_by) VALUES ($1, $2) RETURNING id`,
      [filename ?? null, actor],
    );
    const importId = importRows[0].id;

    for (const row of rows) {
      if (!isUsableImportRow(row)) {
        malformed++;
        continue;
      }

      const check: SuppressionCheck = { email: row.email, instagramHandle: row.instagramHandle };
      // Ruling 23: both lookups run on `query` — the transaction's OWN
      // scoped client, not the module-level `tesserixQuery` (a separate
      // pooled connection). Two things ride on this, together, not either
      // alone:
      //
      // (1) A row created earlier in THIS SAME loop must be visible to a
      //     later row's dedup check. Two CSV rows sharing an email is
      //     ordinary content for a scraped leads sheet; on a separate
      //     connection the second row's lookup would see nothing yet
      //     committed, attempt its own `crm_contacts` insert, and trip
      //     `crm_contacts_email_lower_uq` — rolling the ENTIRE batch back on
      //     what should just resolve as `matchedExisting`.
      // (2) No second pooled connection is acquired per row at all. Against
      //     `max: 2` (tesserix.ts), the old shape held one client for the
      //     transaction and tried to acquire a second, twice per row; two
      //     operators committing concurrently could each hold one client
      //     and starve the other out of the pool entirely.
      if (await isSuppressed(check, query)) {
        skippedSuppressed++;
        continue;
      }

      const matchedId = await findMatchingOrganisationId(check, query);
      if (matchedId) {
        matchedExisting++;
        matchedRows.push(row);
        continue;
      }

      const name = row.name?.trim() || row.email?.trim() || row.instagramHandle?.trim();
      const orgRows = await query<{ id: string }>(
        `INSERT INTO crm_organisations (name, website_url, location, category, tags, import_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          name,
          row.websiteUrl?.trim() || null,
          row.location?.trim() || null,
          row.category ?? [],
          row.tags ?? [],
          importId,
        ],
      );
      const organisationId = orgRows[0].id;

      await query(
        `INSERT INTO crm_contacts (organisation_id, name, email, phone, instagram_handle, is_primary)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [
          organisationId,
          row.name?.trim() || null,
          row.email ? row.email.trim().toLowerCase() : null,
          row.phone?.trim() || null,
          row.instagramHandle ? normalizeInstagramHandle(row.instagramHandle) : null,
        ],
      );

      await query(
        `INSERT INTO crm_opportunities (organisation_id, product, stage, source)
         VALUES ($1, NULL, 'new', $2)`,
        [organisationId, "import"],
      );

      created++;
    }

    // Reconciled by construction: `skippedCount` is defined as "everything
    // that wasn't created" rather than summed from the individual counters,
    // so `row_count - skipped_count === created` can never drift the way it
    // did when `skipped_count` was `skippedSuppressed + malformed` alone
    // (silently excluding `matchedExisting`, which is equally "not
    // created").
    const skippedCount = totalRows - created;
    await query(`UPDATE crm_imports SET row_count = $2, skipped_count = $3 WHERE id = $1`, [
      importId,
      totalRows,
      skippedCount,
    ]);

    return { importId, created, matchedExisting, skippedSuppressed, malformed, matchedRows };
  });
}

/**
 * The handoff queue (Task 10): a won opportunity whose organisation has not
 * yet been linked to a conversion.
 *
 * `converted_at` lives on `crm_organisations`, not `crm_opportunities`
 * (migration 0019) — one business, one conversion, even though it can carry
 * several per-product opportunities over time — so "no conversion recorded"
 * is read off the organisation, not the individual deal.
 */

export interface HandoffRow {
  opportunityId: string;
  organisationId: string;
  organisationName: string;
  /** Null for a migrated deal, and legitimately so. 0019's
   *  `crm_opp_product_required_when_qualified` CHECK does require a product
   *  from `qualified` onward, but 0020/0021 deliberately grandfather the
   *  rows `migrate-leads-to-crm.mjs` writes: a lead that closed before this
   *  schema existed was never matched to a product, and the migration
   *  refuses to invent one (see that script's header).
   *
   *  Such a row genuinely IS won-but-not-converted, so it belongs in this
   *  queue — excluding it would hide the entire migrated backlog on day
   *  one, and `toHandoffRow` used to THROW on it, which put the whole
   *  handoff surface into its error state instead. There is also nothing
   *  lost by carrying the null: `linkConversion` takes the product from the
   *  operator's own selection, not from the opportunity, so a null-product
   *  row is still linkable by hand — and that link is where the null ends,
   *  because `linkConversion` writes the chosen product back onto the deal
   *  (#214), which is what lets the row leave this queue at all. The
   *  only thing it cannot do before that is be asked
   *  about upstream — `fetchRowSignal` has no product to address a
   *  conversion-status call to, so the row reads `unknown`, which is the
   *  honest answer rather than a fabricated `none`. */
  product: string | null;
  /** The organisation's primary contact email, if it has one — what Task 9's
   *  `fetchConversionSignal` is asked about. `null` when no contact on the
   *  organisation carries an email at all: the row still shows (an operator
   *  can still link a conversion by hand), there is just nothing to check
   *  upstream for. */
  primaryEmail: string | null;
  closedAt: string | null;
}

interface RawHandoffRow {
  id: string;
  organisation_id: string;
  organisation_name: string;
  product: string | null;
  primary_email: string | null;
  closed_at: unknown;
}

function toHandoffRow(row: RawHandoffRow): HandoffRow {
  return {
    opportunityId: row.id,
    organisationId: row.organisation_id,
    organisationName: row.organisation_name,
    product: row.product,
    primaryEmail: row.primary_email,
    closedAt: toIso(row.closed_at),
  };
}

/**
 * Won opportunities not yet linked to a conversion, oldest-won-first — the
 * longest a merchant has been sitting unaccounted for is the one an operator
 * should look at first.
 *
 * Ruling 35 — the filter is PER OPPORTUNITY, not per organisation. This
 * returns one row per won opportunity, but it used to exclude on
 * `g.converted_at IS NULL`, a fact about the ORGANISATION. A business with
 * won deals on two products therefore had both rows disappear the moment
 * either one was confirmed: the second product's deal left the queue
 * silently, never linked, with nothing anywhere telling an operator it had
 * gone. Comparing the organisation's recorded `converted_product` against
 * THIS row's product means only the deal actually accounted for drops out.
 *
 * The asymmetry this leaves, stated plainly rather than papered over:
 * `converted_product`/`converted_ref`/`converted_at` live on
 * `crm_organisations`, so an organisation can hold exactly ONE recorded
 * conversion. The second product's deal now correctly stays in the queue —
 * and `linkConversion`'s Ruling 30 guard will refuse to link it, with the
 * operator-facing "already has a conversion recorded" message. That is a
 * visible, explainable refusal instead of a silent disappearance, which is
 * the trade this fix is making. The honest fix is to move `converted_*` onto
 * the opportunity, which is a schema change to a shipped design and
 * deliberately out of scope here; it is the thing to do if multi-product
 * conversions become common rather than theoretical.
 *
 * #214 — the `IS DISTINCT FROM` comparison KEEPS its place, now that
 * `linkConversion` fills a product-less won deal's `product` as it links it.
 * Reverting to a bare `g.converted_at IS NULL` was considered and rejected:
 * that is precisely the per-organisation test Ruling 35 replaced, and it
 * brings back the silent disappearance of a second product's won deal the
 * moment the first is confirmed. What #214 fixed was the other half of the
 * comparison — a null that no write ever cleared — not the comparison.
 *
 * Both branches are load-bearing, and neither is redundant. 0019's
 * `crm_org_conversion_complete` CHECK makes `converted_at` and
 * `converted_product` null together, so on a never-converted organisation
 * the comparison reads `NULL IS DISTINCT FROM o.product`, which is FALSE for
 * a product-less won deal — dropping the `converted_at IS NULL` branch would
 * hide the entire migrated backlog on day one, the exact bug this queue was
 * fixed for once already.
 */
export async function wonWithoutConversion(limit: number): Promise<HandoffRow[]> {
  const rows = await tesserixQuery<RawHandoffRow>(
    `SELECT o.id, o.organisation_id, g.name AS organisation_name, o.product, o.closed_at,
            c.email AS primary_email
       FROM crm_opportunities o
       JOIN crm_organisations g ON g.id = o.organisation_id
       LEFT JOIN LATERAL (
         SELECT email FROM crm_contacts
          WHERE organisation_id = g.id AND email IS NOT NULL
          ORDER BY is_primary DESC, name ASC NULLS LAST
          LIMIT 1
       ) c ON true
      WHERE o.stage = 'won'
        AND (
          g.converted_at IS NULL
          OR g.converted_product IS DISTINCT FROM o.product
        )
      ORDER BY o.closed_at ASC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  return rows.map(toHandoffRow);
}

export interface LinkConversionInput {
  organisationId: string;
  product: string;
  ref: string;
  label?: string;
  method: "matched" | "manual";
  /** Who confirmed the suggestion or typed the manual entry — carried
   *  through to the `crm_activities` row this write leaves (Ruling 31),
   *  same as `advanceStage`'s `actor`. */
  actor: string;
}

export interface LinkedConversion {
  organisationId: string;
  organisationName: string;
  product: string;
  method: "matched" | "manual";
}

/**
 * Thrown when `organisationId` already has a conversion recorded.
 *
 * Ruling 30: `wonWithoutConversion` returns one row per WON OPPORTUNITY, not
 * per organisation — a business with won deals on two products appears
 * twice in the handoff queue. Without a guard, confirming one row's
 * suggestion and then the other's would silently overwrite
 * `converted_product`/`converted_ref`/`converted_at` with the second
 * product's namespace: the exact cross-product attribution corruption this
 * whole design exists to prevent, reachable just by a stale tab or a second
 * operator working the same queue. Distinguished from "no such
 * organisation" (a plain not-found `Error`) so the operator sees an
 * accurate message rather than a report that the row vanished.
 */
export class AlreadyLinkedError extends Error {
  constructor(readonly organisationId: string) {
    super(`Organisation ${organisationId} already has a conversion recorded.`);
    this.name = "AlreadyLinkedError";
  }
}

/**
 * Link an organisation to a product's conversion.
 *
 * Never called for an unconfirmed suggestion — the caller (the action layer)
 * only reaches this after an operator has explicitly confirmed one, or typed
 * a conversion in by hand; `method` records which happened, so a bad
 * auto-link can never be indistinguishable from an operator's own decision.
 *
 * `product`/`ref` are validated here, together, before the UPDATE runs.
 * Migration 0019's `crm_org_conversion_complete` CHECK (both null or both
 * set) would refuse a half-supplied write anyway, but a raw
 * constraint-violation error reaching the operator is not this boundary's
 * job to produce when a clear message can be raised first.
 *
 * It also fills the won opportunity's `product` when that deal has none
 * (#214) — see the comment on that statement below. Every write here is one
 * transaction: organisation, opportunity, and timeline note land together or
 * not at all.
 *
 * The UPDATE and the `crm_activities` write both run inside `tesserixTx`
 * (Ruling 31), on one client: either both land or neither does. A
 * conversion that updated the organisation but left no note on its timeline
 * would be the single most significant moment in that business's life,
 * invisible to the next rep reading it — the timeline would still read
 * "won" with no sign handoff ever happened or who confirmed it.
 */
export async function linkConversion(input: LinkConversionInput): Promise<LinkedConversion> {
  const { organisationId, product, ref, label, method, actor } = input;
  if (!product.trim() || !ref.trim()) {
    throw new Error("linkConversion: both product and ref are required");
  }

  return tesserixTx(async (query) => {
    // `AND converted_at IS NULL` (Ruling 30): a row that already has a
    // conversion recorded is not a match for this UPDATE at all, so a
    // second confirmation — from a stale handoff-queue tab, or a second
    // operator — can never overwrite the first product's namespace.
    const rows = await query<{ id: string; name: string }>(
      `UPDATE crm_organisations
          SET converted_product = $2,
              converted_ref = $3,
              converted_label = $4,
              converted_at = now(),
              converted_link_method = $5,
              updated_at = now()
        WHERE id = $1
          AND converted_at IS NULL
        RETURNING id, name`,
      [organisationId, product, ref, label ?? null, method],
    );
    const row = rows[0];
    if (!row) {
      // Zero rows means either "no such organisation" or "already linked" —
      // resolved here, inside the same transaction, rather than leaving the
      // caller to guess which one a bare empty result meant.
      const existing = await query<{ id: string }>(
        `SELECT id FROM crm_organisations WHERE id = $1`,
        [organisationId],
      );
      if (existing.length === 0) {
        throw new Error(`linkConversion: organisation ${organisationId} not found`);
      }
      throw new AlreadyLinkedError(organisationId);
    }

    // The won deal this conversion is FOR. Ruling 31 put this note on the
    // timeline so the handoff is visible to the next rep reading the
    // record; without an `opportunity_id` it lands only on the
    // organisation, and the deal's own timeline — the one place a rep looks
    // to ask "what happened to this?" — still shows nothing after "won".
    // Null when no won opportunity carries this product and none could be
    // given it (a manual link for a product the organisation has no deal on
    // at all): the note is still worth writing at the organisation level,
    // and inventing an association with some other product's deal would be
    // worse than none.
    const opportunityRows = await query<{ id: string }>(
      `SELECT id FROM crm_opportunities
        WHERE organisation_id = $1 AND product = $2 AND stage = 'won'
        ORDER BY closed_at DESC NULLS LAST
        LIMIT 1`,
      [organisationId, product],
    );

    // #214: the migrated backlog's exit from the handoff queue.
    //
    // A migrated won deal carries `product = NULL` — the backfill refuses to
    // invent attribution it never had (see `migrate-leads-to-crm.mjs`'s
    // header). Linking a conversion is the moment that attribution stops
    // being unknown: an operator has just said, on the record, which product
    // this deal became. Writing it here is what that decision means, and it
    // is also the only thing that lets the row leave `wonWithoutConversion`
    // — whose predicate compares the organisation's `converted_product`
    // against THIS opportunity's, and so kept matching a null forever.
    // Without it the row was linkable exactly once and clearable never,
    // erroring with `AlreadyLinkedError` on every retry after.
    //
    // Only ever fills a NULL, and only when no won deal already carries this
    // product (that deal is the one the conversion is for; a *different*
    // product-less deal on the same organisation is not, and stamping it
    // would fabricate exactly the attribution the migration declined to).
    // `updated_at` is set explicitly — there are no triggers on `crm_*`.
    //
    // Migration 0021 re-added `crm_opp_product_required_when_qualified`
    // (`stage IN ('new','contacted') OR product IS NOT NULL`) as NOT VALID,
    // so a grandfathered `won` row with a null product is un-updatable
    // UNLESS the same UPDATE supplies a product. This write supplies one:
    // it is precisely the update that CHECK was shaped to permit, which
    // `crm-repo.write.integration.test.ts` proves against a real database
    // rather than taking on trust.
    //
    // Oldest-closed-first when an organisation has several product-less won
    // deals, matching the queue's own ordering, so the row the operator was
    // looking at is the row that clears. Any others stay in the queue and
    // hit Ruling 30's guard — the same visible refusal a second product's
    // deal already gets, not a new failure mode.
    const filledRows =
      opportunityRows.length > 0
        ? []
        : await query<{ id: string }>(
            `UPDATE crm_opportunities
                SET product = $2,
                    updated_at = now()
              WHERE id = (
                SELECT id FROM crm_opportunities
                 WHERE organisation_id = $1
                   AND stage = 'won'
                   AND product IS NULL
                 ORDER BY closed_at ASC NULLS LAST, id ASC
                 LIMIT 1
              )
              RETURNING id`,
            [organisationId, product],
          );

    await query(
      `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body, metadata)
       VALUES ($1, $5, 'note', $2, $3, $4::jsonb)`,
      [
        organisationId,
        actor,
        `Linked to ${product} conversion ${ref}${label ? ` (${label})` : ""}`,
        JSON.stringify({ product, ref, label: label ?? null, method }),
        opportunityRows[0]?.id ?? filledRows[0]?.id ?? null,
      ],
    );

    return { organisationId: row.id, organisationName: row.name, product, method };
  });
}
