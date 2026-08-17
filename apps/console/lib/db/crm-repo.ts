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
 * Log a note/call/message activity, independent of any stage change.
 *
 * `crm_activities` carries no CHECK tying it to `crm_opportunities.product`
 * — the grandfathered-row constraint (migration 0021) applies only to
 * `crm_opportunities` — so this needs no product guard and no transaction:
 * it is one INSERT.
 */
export async function logActivity(input: LogActivityInput): Promise<void> {
  await tesserixQuery(
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
 * any — checked against `crm_contacts`' own unique indexes (lower(email),
 * lower(instagram_handle)), the same two keys `crm_suppressions` is keyed
 * on. A row that matches gets counted, not silently merged: this import
 * does not attempt to update an existing organisation's details, only to
 * avoid creating a duplicate one.
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
    `SELECT organisation_id FROM crm_contacts WHERE ${clauses.join(" OR ")} LIMIT 1`,
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
 *  disagree with what a real insert would collide on. */
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
  /** Never null here: `stage = 'won'` requires a product — migration 0019's
   *  `crm_opp_product_required_when_qualified` CHECK, mirrored by
   *  `requiresProduct` in `lib/crm.ts`. `toHandoffRow` fails loud if that
   *  ever stops being true rather than silently showing a row with nothing
   *  to ask apps/web about. */
  product: string;
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
  if (!row.product) {
    throw new Error(`crm-repo: won opportunity ${row.id} has no product`);
  }
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
 * Won opportunities whose organisation has not yet been linked to a
 * conversion, oldest-won-first — the longest a merchant has been sitting
 * unaccounted for is the one an operator should look at first.
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
        AND g.converted_at IS NULL
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
}

export interface LinkedConversion {
  organisationId: string;
  organisationName: string;
  product: string;
  method: "matched" | "manual";
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
 */
export async function linkConversion(input: LinkConversionInput): Promise<LinkedConversion> {
  const { organisationId, product, ref, label, method } = input;
  if (!product.trim() || !ref.trim()) {
    throw new Error("linkConversion: both product and ref are required");
  }

  const rows = await tesserixQuery<{ id: string; name: string }>(
    `UPDATE crm_organisations
        SET converted_product = $2,
            converted_ref = $3,
            converted_label = $4,
            converted_at = now(),
            converted_link_method = $5,
            updated_at = now()
      WHERE id = $1
      RETURNING id, name`,
    [organisationId, product, ref, label ?? null, method],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`linkConversion: organisation ${organisationId} not found`);
  }
  return { organisationId: row.id, organisationName: row.name, product, method };
}
