import { tesserixQuery, tesserixTx, type TxQuery } from "./tesserix";
import {
  UNASSIGNED_PRODUCT,
  UNKNOWN_COUNTRY,
  type FollowerFilter,
} from "./crm-filters";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  trimBackwardPage,
  trimForwardPage,
  type KeysetCursor,
} from "./keyset-cursor";
import {
  requiresProduct,
  CONTACT_ACTIVITY_KINDS,
  isOutboundActivityKind,
  type CrmActivityKind,
  type CrmStage,
} from "../crm";
import { toIso, toIsoRequired } from "./crm-row";
import { isSuppressed } from "./crm-suppressions-repo";
import {
  CLOCK_ELIGIBLE_SQL,
  OUTBOUND_RESCHEDULES_SQL,
  nextActionAssignment,
  notVoided,
  primaryContactFollowerClause,
  primaryContactOrder,
} from "./crm-sql";

export { CLOCK_ELIGIBLE_SQL, OUTBOUND_RESCHEDULES_SQL, nextActionAssignment };

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
  /** ISO 3166-1 alpha-2, exact match on the derived `crm_organisations.country`
   *  column — never a pattern over the raw `location`. `UNKNOWN_COUNTRY`
   *  selects the rows where that column is NULL. Same contract as
   *  `OrganisationFilter.country` below. */
  country?: string;
  /** Follower-count band of the organisation's primary contact — the same
   *  contact a row displays, selected with `primaryContactOrder()` — or
   *  `UNKNOWN_FOLLOWERS` for rows that have no such count to show. */
  followers?: FollowerFilter;
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
 * Pushes a cursor tuple onto `params` and returns the two placeholders that
 * reference it. The casts are written out rather than left to Postgres's
 * inference because one side of the comparison is an expression (the
 * drifting queue's COALESCE), not a bare column — stating the type is
 * cheaper than depending on what the planner infers there.
 */
function cursorPlaceholders(cursor: KeysetCursor, params: unknown[]): [string, string] {
  params.push(cursor.timestamp);
  const timestampParam = `$${params.length}::timestamptz`;
  params.push(cursor.id);
  return [timestampParam, `$${params.length}::uuid`];
}

/**
 * Builds `AND …` clauses for an optional product/stage/owner/country/followers
 * filter, pushing each present value onto `params` as a bound parameter
 * (never interpolated into the SQL string) and returning the clause fragment
 * to splice after the query's own predicates. An absent filter key adds no
 * clause at all — the queue's own predicates stay first and unmodified by
 * this splice, whatever filters are active.
 *
 * That is a property of the splice, not a guarantee about the query plan.
 * `crm_opp_due_idx`/`crm_opp_drifting_idx` stay eligible, but eligible is
 * not chosen: `g.country` has its own index (`crm_org_country_idx`) and the
 * follower clause is a correlated `EXISTS` on `crm_contacts`, so a selective
 * country or follower filter can legitimately lead the planner to drive
 * from `crm_organisations` instead and never touch the partial index. Which
 * index runs is Postgres's call, made per-query from statistics and
 * selectivity — not something this function controls or promises.
 */
function filterClause(filter: QueueFilter, params: unknown[]): string {
  const clauses: string[] = [];
  if (filter.product === UNASSIGNED_PRODUCT) {
    // No bound parameter: this is a NULL test, not a comparison. `= NULL`
    // is never true in SQL, which is the bug this branch exists to fix.
    clauses.push(`o.product IS NULL`);
  } else if (filter.product) {
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
  if (filter.country === UNKNOWN_COUNTRY) {
    // No bound parameter: a NULL test, not a comparison — same shape as the
    // unassigned-product branch above, and for the same reason (`= NULL` is
    // never true). 208 of 259 organisations sit here.
    clauses.push(`g.country IS NULL`);
  } else if (filter.country) {
    // Exact match on the derived column, never a pattern over raw
    // `location` — same as `organisationFilterClauses`. `g` is the
    // organisation both `dueOpportunities` and `driftingOpportunities` join
    // in for `organisation_name`, so it's already in scope here.
    params.push(filter.country);
    clauses.push(`g.country = $${params.length}`);
  }
  if (filter.followers) {
    clauses.push(primaryContactFollowerClause("g", filter.followers, params));
  }
  return clauses.length > 0 ? `\n        AND ${clauses.join("\n        AND ")}` : "";
}

/**
 * A page of a keyset-paged list, plus the counts that make the page honest.
 *
 * Same shape as `OrganisationPage`, for the same reason: a bare capped array
 * cannot say how much it left behind. Generic in the row because `queuePage`
 * now serves lists whose rows differ — the two work queues read a `QueueRow`,
 * the closed list reads a `ClosedRow` — while the pager itself is identical
 * for all of them.
 */
export interface Page<TRow> {
  rows: TRow[];
  /** Every row matching this queue's predicate AND its filters, ignoring
   *  the page limit — the number the operator is being told. */
  total: number;
  /** How many matching rows sort ahead of this page; 0 on the first page.
   *  Counted in SQL, not inferred from a page number: pagination here is
   *  keyset, so a cursor carries no position of its own. */
  precedingCount: number;
  /** Opaque cursor for the next page; null when this is the last page. */
  nextCursor: string | null;
  /** Opaque cursor for the previous page; null on the first page.
   *
   *  Non-null exactly when `precedingCount > 0` — the same SQL count the
   *  displayed range is built from, so the Previous control and the range
   *  can never disagree about whether anything sorts ahead of this page. */
  previousCursor: string | null;
}

/** A page of either work queue. Named separately because every caller and
 *  every mock in the console already speaks it, and because the platform-API
 *  path (`crm-queue-wire.ts`) builds exactly this shape off the wire. */
export type QueuePage = Page<QueueRow>;

/** The columns every queue row is built from — one list, so `dueOpportunities`
 *  and `driftingOpportunities` cannot drift apart on what a QueueRow is. */
const QUEUE_COLUMNS = `o.id, o.organisation_id, g.name AS organisation_name,
            o.product, o.stage, o.owner,
            o.next_action_at, o.next_action_note, o.last_contacted_at,
            COALESCE(o.last_contacted_at, o.created_at) AS quiet_since,
            o.is_starred`;

/** The drifting queue's sort key. Named once because the WHERE clause, the
 *  ORDER BY and the cursor comparison all have to be the same expression —
 *  three copies of a COALESCE is three chances to change two of them. */
const DRIFTING_SORT_KEY = "COALESCE(o.last_contacted_at, o.created_at)";

interface QueuePageQuery<TRaw extends { id: string }, TRow> {
  /** This list's SELECT list. A module constant like `sortKey`, never caller
   *  input — it is spliced into the statement, not bound. */
  columns: string;
  /** SQL expression this queue orders by. A module constant, never caller
   *  input — it is spliced into the statement, not bound. */
  sortKey: string;
  /** Which way `sortKey` runs. Required rather than defaulting to "asc" so
   *  that a reader of any call site can see the order the list is displayed
   *  in without leaving the call — the readability objection `keyset-cursor.ts`
   *  raises against a shared direction argument, answered by never letting the
   *  argument be implicit. */
  direction: "asc" | "desc";
  /** Prefix for cursor-rejection messages, so a thrown error names the
   *  queue that rejected it. */
  label: string;
  /** Builds this queue's WHERE body, pushing its own bound parameters onto
   *  `params` in the order the returned SQL numbers them. Called once per
   *  statement because the count and page queries bind separate lists. */
  buildWhere: (params: unknown[]) => string;
  /** One raw pg row as this list's own row type. */
  toRow: (row: TRaw) => TRow;
  /** The sort key's value on a returned row, for the next cursor. */
  sortValue: (row: TRaw) => unknown;
  limit: number;
  cursor?: string;
}

/**
 * Runs one queue's count and page queries and assembles a `QueuePage`.
 *
 * Modelled on `listOrganisations`: concurrent count + page reads, `limit + 1`
 * rows as self-contained proof that another page exists, and `precedingCount`
 * aggregated into the count query rather than asked for separately.
 *
 * The ordering carries `o.id` as a tiebreak. Without it, rows sharing a sort
 * timestamp come back in whatever order the plan produces — harmless for one
 * capped page, fatal here, because a row could repeat on one page and never
 * appear on another. Migration 0021 wrote 259 rows in one batch, so ties are
 * the normal case on this data, not an edge one. The tiebreak matters more
 * going backwards than forwards: a queue whose forward paging looks correct
 * can still repeat or lose a tied row on the way back, because the two
 * directions only agree on where a tie splits if `id` decides it.
 *
 * Reading backwards mirrors every part of the forward read at once — anchor,
 * comparison, ORDER BY and the preceding count. Mirroring a DESCENDING list
 * therefore reads ascending: the two directions cancel, which is what `flip`
 * below composes. `listOrganisations` keeps its own copy of this shape all
 * the same — see `keyset-cursor.ts` for why the SQL stays split even though
 * the cursor itself does not.
 */
async function queuePage<TRaw extends { id: string }, TRow>({
  columns,
  sortKey,
  direction,
  label,
  buildWhere,
  toRow,
  sortValue,
  limit,
  cursor,
}: QueuePageQuery<TRaw, TRow>): Promise<Page<TRow>> {
  // Decoded (and validated) before either query runs, so a malformed cursor
  // fails fast without spending a round trip on a count it would never use.
  const decoded = cursor ? decodeKeysetCursor(cursor, label) : null;
  // "before" is the mirror of the forward read: anchor on the page's FIRST
  // row rather than its last, flip the comparison, flip the ORDER BY, and
  // re-reverse the rows afterwards (see `trimBackwardPage`).
  const backwards = decoded?.direction === "before";
  const descending = direction === "desc";
  // The page predicate and the ORDER BY each depend on BOTH directions, and
  // depend on them the same way: reading backwards mirrors the list, so a
  // backward read of a descending list runs ascending — the two flips
  // cancel. The preceding count does NOT follow this boolean; see below.
  const flip = descending !== backwards;

  const countParams: unknown[] = [];
  const countWhere = buildWhere(countParams);
  // Rows ahead of this page, in the list's own display order.
  //
  // Forward, the cursor IS the last row of the previous page, so it counts
  // as preceding (the operator includes equality) and the page predicate
  // below excludes it. Backward, the cursor is the first row of the page
  // being LEFT — it sorts after this page, so it must not be counted, and
  // what the count then returns is this page plus everything ahead of it.
  // The page's own length is subtracted once the rows are in hand.
  let precedingSelect = "0";
  if (decoded) {
    const [timestampParam, idParam] = cursorPlaceholders(decoded, countParams);
    // This operator's DIRECTION follows the list's sort alone — the rows
    // ahead of an ascending page are the smaller ones, ahead of a descending
    // page the larger — while its EQUALITY follows the cursor's alone. So it
    // is not `flip`: ascending-backward and descending-forward share a `flip`
    // and want opposite operators here.
    const ahead = descending ? ">" : "<";
    const comparison = backwards ? ahead : `${ahead}=`;
    precedingSelect = `count(*) FILTER (WHERE (${sortKey}, o.id) ${comparison} (${timestampParam}, ${idParam}))`;
  }

  const params: unknown[] = [];
  let where = buildWhere(params);
  if (decoded) {
    const [timestampParam, idParam] = cursorPlaceholders(decoded, params);
    where += `\n        AND (${sortKey}, o.id) ${flip ? "<" : ">"} (${timestampParam}, ${idParam})`;
  }
  params.push(limit + 1);
  const limitParam = `$${params.length}`;
  // The same `flip` as the comparison, and for the same reason: were the two
  // to disagree, the LIMIT would keep the rows furthest from the anchor —
  // the far end of the whole list, not the page adjacent to this cursor.
  const order = flip ? "DESC" : "ASC";

  // Independent reads over two disjoint parameter lists — concurrent rather
  // than two sequential round trips for every page view.
  const [countRows, rawRows] = await Promise.all([
    tesserixQuery<{ count: string | number; preceding: string | number }>(
      `SELECT count(*) AS count, ${precedingSelect} AS preceding
         FROM crm_opportunities o
         JOIN crm_organisations g ON g.id = o.organisation_id
        WHERE ${countWhere}`,
      countParams,
    ),
    tesserixQuery<TRaw>(
      `SELECT ${columns}
       FROM crm_opportunities o
       JOIN crm_organisations g ON g.id = o.organisation_id
      WHERE ${where}
      ORDER BY ${sortKey} ${order}, o.id ${order}
      LIMIT ${limitParam}`,
      params,
    ),
  ]);

  const { rows: pageRawRows, hasMore } = backwards
    ? trimBackwardPage(rawRows, limit)
    : trimForwardPage(rawRows, limit);

  const counted = Number(countRows[0]?.preceding ?? 0);
  // Backward, the count covers this page as well (see `precedingSelect`).
  const precedingCount = backwards ? Math.max(0, counted - pageRawRows.length) : counted;

  const firstRow = pageRawRows[0];
  const lastRow = pageRawRows[pageRawRows.length - 1];
  // Backward, a next page is not something to prove: this page was reached
  // from the one after it, so it exists whenever this page has rows.
  const hasNextPage = backwards ? Boolean(lastRow) : hasMore;
  return {
    rows: pageRawRows.map(toRow),
    // count(*) comes back as a string from pg's bigint mapping.
    total: Number(countRows[0]?.count ?? 0),
    precedingCount,
    nextCursor:
      hasNextPage && lastRow
        ? encodeKeysetCursor(toIsoRequired(sortValue(lastRow)), lastRow.id, "after")
        : null,
    previousCursor:
      precedingCount > 0 && firstRow
        ? encodeKeysetCursor(toIsoRequired(sortValue(firstRow)), firstRow.id, "before")
        : null,
  };
}

/** Opportunities whose next action has arrived. Terminal deals (won/lost)
 *  are excluded — surfacing them would make the queue a to-do list of things
 *  already finished. Most-overdue-first. */
export async function dueOpportunities(
  filter: QueueFilter,
  limit: number,
  cursor?: string,
): Promise<QueuePage> {
  return queuePage<RawQueueRow, QueueRow>({
    columns: QUEUE_COLUMNS,
    sortKey: "o.next_action_at",
    direction: "asc",
    label: "dueOpportunities",
    // The queue's own predicates stay first, filters spliced after, so the
    // partial index (crm_opp_due_idx) stays eligible.
    //
    // `voided_at IS NULL` is one of those own predicates and belongs ahead of
    // the filters for the same reason (#251). It only ever NARROWS the row
    // set, so this query's predicate still implies `crm_opp_due_idx`'s
    // partial one and the index stays usable unmodified — the argument
    // migration 0049's header rests on when it declines to touch either
    // index. A voided deal is one an operator has said should never have
    // been in the funnel; leaving it Due would keep asking them to work it.
    buildWhere: (params) =>
      `o.next_action_at <= now()
        AND o.stage NOT IN ('won', 'lost')
        AND ${notVoided("o")}${filterClause(filter, params)}`,
    toRow: toQueueRow,
    // Non-null on every returned row: the predicate above requires it.
    sortValue: (row) => row.next_action_at,
    limit,
    cursor,
  });
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
 *  index would be premature tuning today.
 *
 *  A voided deal is excluded here too, ahead of the filters and for the
 *  same index reason `dueOpportunities` records (#251). Drifting is the
 *  queue that says "nobody has touched this lately", and a deal an operator
 *  has declared should never have been in the funnel is not a lapse. */
export async function driftingOpportunities(
  filter: QueueFilter,
  staleDays: number,
  limit: number,
  cursor?: string,
): Promise<QueuePage> {
  return queuePage<RawQueueRow, QueueRow>({
    columns: QUEUE_COLUMNS,
    sortKey: DRIFTING_SORT_KEY,
    direction: "asc",
    label: "driftingOpportunities",
    // Filter parameters are pushed before staleDays so the filter clauses
    // keep the low placeholder numbers whether or not a filter is active.
    buildWhere: (params) => {
      const filterSql = filterClause(filter, params);
      params.push(staleDays);
      return `o.next_action_at IS NULL
        AND o.stage NOT IN ('won', 'lost')
        AND ${notVoided("o")}
        AND ${DRIFTING_SORT_KEY}
              <= now() - make_interval(days => $${params.length}::int)${filterSql}`;
    },
    toRow: toQueueRow,
    sortValue: (row) => row.quiet_since,
    limit,
    cursor,
  });
}

/**
 * The closed list: the deals the two work queues deliberately exclude.
 *
 * A read of its own rather than a value admitted to the queues' `stage`
 * filter. The queues sort by urgency — `next_action_at`, `quiet_since` — and
 * a deal that is already won or lost has no next action and no meaningful
 * quietness, so admitting one orders it by a key that does not apply to it
 * under a heading that reads "Due". The platform-API implementation of those
 * queues (`lib/crm-queues.ts`) refuses a terminal stage with a 422 by design,
 * so admitting one would also be a two-language change to a live wire
 * contract; a new read is neither.
 */
export interface ClosedRow {
  id: string;
  organisationId: string;
  organisationName: string;
  product: string | null;
  /** `won` or `lost` — the WHERE clause admits nothing else. Carried rather
   *  than assumed by the caller, which renders the two differently. */
  stage: CrmStage;
  owner: string | null;
  /** When the deal closed. Null only for a terminal row whose `closed_at`
   *  was never written — see `CLOSED_SORT_KEY` for why that is possible and
   *  what the list does about it. */
  closedAt: string | null;
  /** Why a deal was lost, as `advanceStage` recorded it. Null on every won
   *  row: that same write sets `lost_reason` only for `lost` and clears it
   *  on any other transition. */
  lostReason: string | null;
}

export type ClosedPage = Page<ClosedRow>;

interface RawClosedRow {
  id: string;
  organisation_id: string;
  organisation_name: string;
  product: string | null;
  stage: CrmStage;
  owner: string | null;
  closed_at: unknown;
  closed_sort: unknown;
  lost_reason: string | null;
}

function toClosedRow(row: RawClosedRow): ClosedRow {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    organisationName: row.organisation_name,
    product: row.product,
    stage: row.stage,
    owner: row.owner,
    closedAt: toIso(row.closed_at),
    lostReason: row.lost_reason,
  };
}

/**
 * The closed list's sort key, and why it is not the bare column.
 *
 * `closed_at` is nullable in 0019 and no CHECK ties it to the stage. Every
 * write that moves an opportunity into a terminal stage does set it in the
 * same statement — `advanceStage` is the only such write in this module, the
 * outreach composer goes through it, and both the dev seed and the leads
 * migration backfill the column — so a NULL here is a row nothing in the
 * codebase produces today. It is still not a case to leave to chance: the
 * keyset cursor is built FROM the sort key, so one such row would make
 * `toIsoRequired` throw and take the whole list down with it, rather than
 * merely sorting oddly. `updated_at` is NOT NULL, and is the last time
 * anything touched the row — the closest real evidence available, and never
 * an invented date. `wonWithoutConversion` guards the same possibility with
 * `NULLS LAST`.
 *
 * Named once because the ORDER BY, the cursor comparison and the selected
 * `closed_sort` column all have to be the same expression.
 */
const CLOSED_SORT_KEY = "COALESCE(o.closed_at, o.updated_at)";

/** What a `ClosedRow` is built from. `closed_sort` is selected as well as
 *  `closed_at` because the cursor is minted from the sort key's value on the
 *  row, and recomputing that COALESCE in TypeScript is two copies of one
 *  expression. */
const CLOSED_COLUMNS = `o.id, o.organisation_id, g.name AS organisation_name,
            o.product, o.stage, o.owner, o.closed_at, o.lost_reason,
            ${CLOSED_SORT_KEY} AS closed_sort`;

/**
 * Won and lost deals, newest-closed-first, filtered and paged like a queue.
 *
 * Descending because the tab is read retrospectively — "what did we close,
 * and what did we lose" are both questions about recent deals — while the two
 * work queues ask "what needs doing", which is oldest-first (#565). Forward
 * paging therefore walks back through the year.
 *
 * Neither partial index in 0019 applies here — both are `WHERE … stage NOT IN
 * ('won','lost')`, and this query wants exactly their complement, so it was
 * never going to use them. At the low hundreds of rows this table holds, the
 * scan costs nothing; the same reasoning `driftingOpportunities` records
 * about its own unindexed sort.
 */
export async function closedOpportunities(
  filter: QueueFilter,
  limit: number,
  cursor?: string,
): Promise<ClosedPage> {
  return queuePage<RawClosedRow, ClosedRow>({
    columns: CLOSED_COLUMNS,
    sortKey: CLOSED_SORT_KEY,
    direction: "desc",
    label: "closedOpportunities",
    // The list's own predicate stays first, filters spliced after — the same
    // shape the queues use. A `stage` filter here narrows won/lost to one of
    // them rather than contradicting the predicate, which is what the same
    // filter would do on either work queue.
    //
    // A VOIDED DEAL IS EXCLUDED, and this exclusion is the one that carries
    // the point of #251 rather than merely tidying a queue. `voidOpportunity`
    // deliberately accepts a won or lost deal — a duplicated won row is
    // exactly the close-rate pollution the issue exists to remove — so if
    // this list still counted it, the void would have changed nothing an
    // operator reads. Everything a voided deal was is still on the
    // organisation's own file (`organisationDetail`), which keeps it.
    buildWhere: (params) =>
      `o.stage IN ('won', 'lost')
        AND ${notVoided("o")}${filterClause(filter, params)}`,
    toRow: toClosedRow,
    sortValue: (row) => row.closed_sort,
    limit,
    cursor,
  });
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

/**
 * Thrown when a write tries to move a VOIDED deal (#251).
 *
 * A void says the deal should never have been in the funnel. Every read in
 * this module now excludes one, so a voided deal cannot be reached from Due,
 * Drifting, Closed or the handoff queue — but `organisationDetail` keeps it,
 * deliberately, because that page is the organisation's file and the restore
 * control has to hang off something. So the detail page is a live surface
 * showing a row whose stage and next-action controls must not fire, and this
 * is what they raise instead.
 *
 * Two writes need it, and they share ONE error type rather than declaring one
 * each. The refusal is the same fact about the same row — this deal is out of
 * the funnel — and the remedy is the same single action: restore it, then
 * make the edit. Two types would put that one fact in two places that can
 * stop agreeing in a single commit, and would oblige every surface that
 * renders it to learn both; the shape of the failure, not the name of the
 * function that hit it, is what a caller branches on. Which write was
 * attempted is already in the caller's own frame.
 *
 * The refusals are TYPED and not silent no-ops. A no-op would report success
 * for a stage move that did not happen, which is the one thing
 * `advanceStageOnQuery`'s whole design refuses to allow — its `AdvanceStageResult`
 * exists precisely so a caller can never assume a write occurred.
 */
export class VoidedOpportunityError extends Error {
  constructor(readonly opportunityId: string) {
    super(
      `Opportunity ${opportunityId} is voided and cannot be edited. Restore it first.`,
    );
    this.name = "VoidedOpportunityError";
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
 * The statements themselves live in `advanceStageOnQuery`; this function is
 * that plus a transaction. The split exists so a caller that already holds
 * one can honour this rule instead of copying it — see that function.
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
  // Before `tesserixTx`, not inside it: see `assertAdvanceStageInput`.
  assertAdvanceStageInput(input);

  return tesserixTx((query) => advanceStageOnQuery(query, input));
}

/**
 * Advance a stage on a transaction the CALLER already opened.
 *
 * Exported, and this is the whole reason it exists: `tesserixTx` does not
 * nest, so a caller that must do its own writes in the SAME transaction as
 * the stage move (`crm-outreach.ts`, logging a templated DM and moving the
 * lead `new` -> `contacted` as one unit) cannot call `advanceStage` — that
 * function opens a transaction of its own. Such a caller had exactly two
 * options: reimplement the stage UPDATE and its `stage_change` INSERT, or
 * be handed them. A reimplementation is a second copy of the rule that
 * every transition writes its activity, and a second copy is a copy that
 * can stop agreeing with the first in one commit — the `crm-identity.ts`
 * normalisation lesson, where the same rule living in two places is how the
 * two ended up disagreeing about what a handle is. Handing the logic out is
 * what keeps one rule in one place.
 *
 * So: DO NOT write the stage UPDATE by hand anywhere else, and do not reach
 * for this from an action or a barrel export. It is for callers already
 * holding a `TxQuery`, and it carries the atomicity guarantee only because
 * the caller's transaction supplies it.
 *
 * The rules this encodes, the reasons for each, and Ruling 14 are all
 * documented on `advanceStage` above, which is now just this function plus
 * a transaction.
 */
export async function advanceStageOnQuery(
  query: TxQuery,
  input: AdvanceStageInput,
): Promise<AdvanceStageResult> {
  const { opportunityId, to, actor, product, lostReason } = input;

  // Re-checked here and not only in `advanceStage`, because this function is
  // reachable without going through it: a guard the second caller can skip
  // is not a guard. `assertAdvanceStageInput` is pure, so paying for it
  // twice on the `advanceStage` path costs nothing.
  assertAdvanceStageInput(input);

  const rows = await query<{
    stage: CrmStage;
    organisation_id: string;
    product: string | null;
    voided_at: string | null;
  }>(
    `SELECT stage, organisation_id, product, voided_at
       FROM crm_opportunities
      WHERE id = $1
        FOR UPDATE`,
    [opportunityId],
  );
  const current = rows[0];
  if (!current) {
    throw new Error(`advanceStage: opportunity ${opportunityId} not found`);
  }
  // Read from the same locked row as everything below, so no concurrent void
  // can land between the check and the UPDATE (#251).
  //
  // A voided deal does not move. "Void it, then someone moves it to won"
  // would produce a won-and-voided row, and every predicate this module just
  // gained would then have to reconcile a stage that says the deal closed
  // with a column that says it never happened. Worse, `advanceStage` writes
  // `closed_at` and a `stage_change` activity on that transition — the
  // funnel's own source of truth — so the contradiction would not stay in
  // one row. Refusing here is the cheapest place to keep the two consistent.
  //
  // Reachable in practice: `organisationDetail` deliberately keeps voided
  // deals visible, so the stage control is on screen for one.
  if (current.voided_at !== null) {
    throw new VoidedOpportunityError(opportunityId);
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
}

/**
 * Argument-only preconditions for a stage move.
 *
 * Split out so `advanceStage` can run them BEFORE it opens a transaction —
 * an invalid argument then costs no BEGIN/ROLLBACK, which is the property
 * `crm-repo.write.integration.test.ts` names when it says the row is
 * untouched "not because of a rollback but because nothing was ever sent".
 */
function assertAdvanceStageInput(input: AdvanceStageInput): void {
  const { to, product, lostReason } = input;
  // Validated against the argument alone, before any row is read: a
  // transition into a product-required stage always needs the caller to
  // supply one, so this fails fast without a wasted round trip either way.
  if (requiresProduct(to) && !product) {
    throw new Error(`advanceStage: moving to "${to}" requires a product`);
  }
  if (to === "lost" && !lostReason) {
    throw new Error('advanceStage: moving to "lost" requires a lostReason');
  }
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
 *
 * That same read now also refuses a VOIDED deal, with
 * `VoidedOpportunityError` — see the guard itself for why the queue's own
 * exclusion is not enough.
 */
export async function setNextAction(input: SetNextActionInput): Promise<void> {
  // `actor` is part of the interface for parity with `advanceStage` and
  // `logActivity`, and so a caller has it in hand for the audit row the
  // action layer writes — but this function itself only ever touches
  // `crm_opportunities`, so it isn't threaded through here.
  const { opportunityId, at, note } = input;

  await tesserixTx(async (query) => {
    const rows = await query<{
      stage: CrmStage;
      product: string | null;
      voided_at: string | null;
    }>(
      `SELECT stage, product, voided_at FROM crm_opportunities WHERE id = $1 FOR UPDATE`,
      [opportunityId],
    );
    const current = rows[0];
    if (!current) {
      throw new Error(`setNextAction: opportunity ${opportunityId} not found`);
    }
    // From the same locked read as the product guard below, and ahead of it:
    // a voided deal is refused whether or not it also lacks a product, and
    // "restore it first" is the one instruction that applies to both.
    //
    // Without this, scheduling a next action on a voided deal would succeed
    // and write `next_action_at`. `dueOpportunities` would still hide the
    // row, so nothing visible would break HERE — but the column itself would
    // then say "this is due" about a deal declared never to have happened,
    // and it is read by more than this query: `organisationDetail` renders
    // it, and the platform-API implementation of the same queues has no void
    // predicate yet (T6). A queue filter hides that state; it does not stop
    // it being written (#251).
    if (current.voided_at !== null) {
      throw new VoidedOpportunityError(opportunityId);
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

/** The kinds that count as contact, and why those — `lib/crm.ts`, which
 *  holds the list so the composer and this write path can never disagree
 *  about what "contact" means. A Set only for the membership test below. */
const CONTACT_KIND_SET: ReadonlySet<CrmActivityKind> = new Set(CONTACT_ACTIVITY_KINDS);

/**
 * Thrown when the do-not-contact list refuses a write. design.md:224 says the
 * list is checked "at import and when logging outreach"; before this, only
 * the two import callers checked, so half of what the feature claims was
 * absent. An allowlisted, operator-facing exception (see `mapError` in
 * `lib/crm-write.ts`) rather than a generic failure: an operator who just
 * hit this needs to know WHY, or they will simply try again.
 *
 * `organisationId` is optional and `message` overridable because the same
 * refusal now has two shapes. Outreach is refused against a known
 * organisation; a MANUAL CREATE (`crm-writes.ts`) is refused for a person who
 * asked not to be contacted, and on the new-organisation path there is no
 * organisation id yet — the whole point is that the row does not get written.
 * The message says which of the two happened, and neither wording names any
 * detail the operator did not just type in themselves.
 */
export class SuppressedContactError extends Error {
  constructor(
    readonly organisationId?: string,
    message = "This organisation is on the do-not-contact list. Remove the suppression before logging outreach.",
  ) {
    super(message);
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
 * (2) The queue clocks. `last_contacted_at` was written by NOTHING in the
 *     application — only the migration set it — so logging a DM or a call
 *     left the queue still reporting the organisation as quiet since
 *     whenever the backfill said. `next_action_at` then had the opposite
 *     problem (#502): still unwritten here, and because null IS the drifting
 *     predicate, a contacted lead was filed as drifting by the very act of
 *     contacting it. The activity row and the timestamps it implies must land
 *     together or not at all; a logged call with a stale "quiet since", or one
 *     with no follow-up, is worse than either alone. Which deals they move
 *     for — and why an activity naming no deal moves them for all of the open
 *     ones — is `advanceContactClock` below.
 *
 * `updated_at` is set explicitly. There are no triggers on these tables.
 */
export async function logActivity(input: LogActivityInput): Promise<void> {
  await tesserixTx(async (query) => {
    // `isOutboundActivityKind` (lib/crm.ts) rather than a list held here.
    // The do-not-contact gate and the follow-up clock below both need to know
    // which kinds are us reaching out, and one list is the only way they can
    // never disagree about it — see that constant's comment for why `call` is
    // on it.
    if (isOutboundActivityKind(input.kind)) {
      await assertNoSuppressedContact(input.organisationId, query);
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

    if (CONTACT_KIND_SET.has(input.kind)) {
      await advanceContactClock(input, query);
    }
  });
}

/**
 * Refuse an outbound kind if anyone at this organisation is on the
 * do-not-contact list. Read on the transaction's own client so the check and
 * the insert cannot straddle a concurrent suppression being added.
 *
 * Exported for the same reason as `advanceStageOnQuery`: "outbound contact is
 * refused for a suppressed organisation" is a rule this file owns, and a
 * second caller that needs it inside its own transaction (`crm-outreach.ts`,
 * re-checking at commit what the preview could only promise about an older
 * state) could either reimplement it or be handed it. Reimplementing means
 * two copies of what counts as suppressed, and the copy that drifts is the
 * one that lets a message reach someone who asked us to stop. It already
 * takes a `query`, so handing it out costs nothing but the `export`.
 */
export async function assertNoSuppressedContact(
  organisationId: string,
  query: TxQuery,
): Promise<void> {
  const contacts = await query<{ email: string | null; instagram_handle: string | null }>(
    `SELECT email, instagram_handle FROM crm_contacts WHERE organisation_id = $1`,
    [organisationId],
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
      throw new SuppressedContactError(organisationId);
    }
  }
}

/**
 * Move both queue clocks — `last_contacted_at`, which Drifting reads, and
 * `next_action_at`, which decides whether the lead is in Drifting at all — for
 * the deals this contact event actually touched.
 *
 * What each kind does to `next_action_at` is `nextActionAssignment` below;
 * this function's own subject is WHICH DEALS.
 *
 * WHICH DEALS, AND WHY THIS REVERSES WHAT THIS FUNCTION USED TO SAY (#245).
 * The previous comment here reasoned that an organisation-level activity
 * "has no one deal whose clock it would be honest to reset", and so reset
 * none. The premise is right and the conclusion was wrong: there is no
 * single deal, but the honest answer is that the event touched ALL of the
 * ones still in play, not none of them. A call to the business is contact
 * with the business, whichever deal the operator had in mind. Resetting
 * none made the console physically unable to write this column — the
 * composer names no deal — so every imported organisation entered Drifting
 * 14 days after import and stayed there for ever, and the queue came to
 * mean "imported a while ago" rather than "needs attention".
 *
 * Terminal deals are excluded: a won or lost deal is not being worked, so a
 * clock that exists to say "nobody has touched this lately" has nothing to
 * say about it.
 *
 * WHICH ROWS EITHER BRANCH MAY TOUCH is `CLOCK_ELIGIBLE_SQL` above — the
 * same predicate for both, which it very deliberately was not before.
 */
async function advanceContactClock(input: LogActivityInput, query: TxQuery): Promise<void> {
  const set = `next_action_at = ${nextActionAssignment(input.kind)},
              last_contacted_at = now(),
              updated_at = now()`;

  if (input.opportunityId) {
    await query(
      `UPDATE crm_opportunities
          SET ${set}
        WHERE id = $1
          AND ${CLOCK_ELIGIBLE_SQL}`,
      [input.opportunityId],
    );
    return;
  }

  await query(
    `UPDATE crm_opportunities
        SET ${set}
      WHERE organisation_id = $1
        AND ${CLOCK_ELIGIBLE_SQL}`,
    [input.organisationId],
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
  /**
   * ISO 3166-1 alpha-2 code derived from `location` by `countryFromLocation`,
   * and `null` when there was nothing to derive: either no location at all,
   * or a location the mapper has no entry for. Those are different absences
   * and the surfaces must not render them the same way. No writer can attach
   * a country to a NULL location, so a null `location` here always carries a
   * null `country` — see `LocationCell` in `organisations-view.tsx` for the
   * per-writer argument.
   */
  country: string | null;
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
  /**
   * The scraped follower count (#252 §A) — the CRM's only quantitative
   * qualification signal, and what the organisations browse list bands and
   * sorts on.
   *
   * Nullable, and never coalesced to 0 on the way out: a null here means no
   * count was ever collected for this contact, which is a different claim
   * from a measured zero. `crm-filters.ts`'s `UNKNOWN_LABEL` carries the
   * argument in full; the short version is that an operator reading
   * "0 followers" would qualify a lead out on a number nobody recorded.
   */
  followersCount: number | null;
  /**
   * Provenance (#248) — what we hold, when we got it, and why we may.
   *
   * Read here rather than left to a database query because the detail page
   * is where a subject-access request is answered: before this, migration
   * 0019's three columns were written by one migration script and selected
   * by nothing, so the only way to answer "why do you have my details" was
   * psql. Nullable on all three: rows created between the cutover and #248
   * genuinely have none, and rendering a guess would be worse than
   * rendering "Not recorded".
   */
  source: string | null;
  sourcedAt: string | null;
  lawfulBasis: string | null;
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
  /**
   * When the deal was taken out of the funnel (#251), or null while it is
   * live.
   *
   * Carried on the row rather than left to the caller to infer, because
   * every consumer of this DTO needs the same answer and none of them can
   * derive it: a voided deal keeps its `stage`, so nothing else on this row
   * distinguishes it. `organisationDetail` is the one read that returns
   * voided deals at all — the queues, Closed and the handoff list exclude
   * them — which is what makes a Restore control possible.
   */
  voidedAt: string | null;
  /**
   * The operator's own words for why, or null.
   *
   * Null on a live deal (migration 0049's CHECK forbids a reason without a
   * `voided_at`), and null on a voided deal whose operator gave none — the
   * reason is optional, so its absence is not a defect to render around.
   */
  voidedReason: string | null;
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
  /**
   * There is activity older than `activities` that this read does not carry.
   *
   * Carried rather than left to the caller to infer from `activities.length
   * === ACTIVITY_LIMIT`, which is wrong exactly at the boundary: a timeline of
   * precisely the cap would claim there is more history when there is not.
   *
   * Discovered by asking for one row more than the cap and discarding it —
   * one query, not a second COUNT, the same trade `HandoffPage.hasMore`
   * makes (#246). The instance is a shared db-f1-micro, and the only decision
   * this informs — is what I am reading the whole record — is the same at 201
   * as at 2,001.
   */
  hasMoreActivities: boolean;
}

/** Most recent activities shown on a detail page — a full history is a job
 *  for export/search, not this view.
 *
 *  Exported so the test can assert the probe-row arithmetic against the
 *  constant itself rather than a copy of its value. */
export const ACTIVITY_LIMIT = 200;

/** `null` for "no such organisation" — the caller (the page) turns that into
 *  `notFound()`, the same contract `fetchTicketDetail` uses. */
export async function organisationDetail(organisationId: string): Promise<OrganisationDetail | null> {
  const orgRows = await tesserixQuery<{
    id: string;
    name: string;
    website_url: string | null;
    location: string | null;
    country: string | null;
    category: string[];
    tags: string[];
    converted_product: string | null;
    converted_label: string | null;
    converted_at: unknown;
    created_at: unknown;
  }>(
    `SELECT id, name, website_url, location, country, category, tags,
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
      followers_count: number | null;
      source: string | null;
      sourced_at: unknown;
      lawful_basis: string | null;
    }>(
      // Erased contacts stay in this list, deliberately — see notErased().
      // This orders the WHOLE contact list rather than picking one contact to
      // stand for the organisation, and the detail page is the organisation's
      // file: a contact who exercised erasure is redacted there ('[erased]',
      // no identifiers), not hidden, or the record would silently lose a row
      // the activity trail still refers to.
      `SELECT id, name, email, phone, instagram_handle, is_primary,
              followers_count, source, sourced_at, lawful_basis
         FROM crm_contacts
        WHERE organisation_id = $1
        ORDER BY ${primaryContactOrder("")}`,
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
      voided_at: unknown;
      voided_reason: string | null;
    }>(
      // Voided deals stay in this list, deliberately — the same reasoning
      // `notErased()` records for erased contacts just above (#251). This
      // page is the organisation's FILE, not a work queue: the queues,
      // Closed and the handoff list all exclude a voided deal, and if this
      // list excluded it too the deal would be unreachable and there would
      // be nothing for a Restore control to hang off. `advanceStageOnQuery`
      // and `setNextAction` refuse a voided row with
      // `VoidedOpportunityError` precisely because it is visible here.
      // `voided_reason` is selected here and nowhere else, and `voided_at`
      // is selected nowhere else that RENDERS one: this is the only read
      // that returns a voided deal, so it is the only one with anything to
      // say about it. The other three reads of `voided_at` — `advanceStage`
      // and `setNextAction` above, and `lockForVoidWrite` in crm-void.ts —
      // are locked reads inside a write, and they take the column to REFUSE
      // on it, never to show it.
      `SELECT id, product, stage, owner, next_action_at, next_action_note,
              last_contacted_at, is_starred, closed_at, lost_reason, created_at,
              voided_at, voided_reason
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
      // `id` last for the same reason the organisation keyset carries it:
      // `occurred_at` is a plain `timestamptz DEFAULT now()` with no
      // uniqueness guarantee, and rows can be written with an explicit value
      // (`scripts/seed-dev.mjs` does), so two rows can share it exactly.
      // Without a total order the LIMIT then breaks that tie arbitrarily —
      // and the cut now decides which row is DROPPED, not just where it sits,
      // so two loads of the same page could disagree about what the timeline
      // contains. No write path in the app produces such a tie today; this
      // costs nothing and removes the latent one.
      `SELECT id, opportunity_id, kind, actor, body, occurred_at
         FROM crm_activities
        WHERE organisation_id = $1
        ORDER BY occurred_at DESC, id DESC
        LIMIT $2`,
      // One more than the cap: the extra row is never returned, it only
      // answers "is there history past this".
      [organisationId, ACTIVITY_LIMIT + 1],
    ),
  ]);

  return {
    organisation: {
      id: org.id,
      name: org.name,
      websiteUrl: org.website_url,
      location: org.location,
      country: org.country,
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
      followersCount: row.followers_count,
      source: row.source,
      sourcedAt: toIso(row.sourced_at),
      lawfulBasis: row.lawful_basis,
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
      voidedAt: toIso(row.voided_at),
      voidedReason: row.voided_reason,
    })),
    activities: activityRows.slice(0, ACTIVITY_LIMIT).map((row) => ({
      id: row.id,
      opportunityId: row.opportunity_id,
      kind: row.kind,
      actor: row.actor,
      body: row.body,
      occurredAt: toIsoRequired(row.occurred_at),
    })),
    hasMoreActivities: activityRows.length > ACTIVITY_LIMIT,
  };
}

export {
  type SuppressionRow,
  type SuppressionCheck,
  isSuppressed,
  type AddSuppressionInput,
  addSuppression,
  listSuppressions,
  type RemovedSuppression,
  removeSuppression,
  normalizeInstagramHandle,
} from "./crm-suppressions-repo";

export {
  findMatchingOrganisationId,
  ErasureCheckUnavailableError,
  isErased,
  type ImportPreview,
  previewImport,
  type ImportResult,
  commitImport,
} from "./crm-import-repo";

export {
  type HandoffRow,
  type HandoffPage,
  wonWithoutConversion,
  type LinkConversionInput,
  type LinkedConversion,
  AlreadyLinkedError,
  linkConversion,
} from "./crm-handoff-repo";

export {
  type OrganisationFilter,
  type OrganisationListRow,
  type OrganisationPage,
  ORGANISATION_SORTS,
  type OrganisationSortKey,
  type SortDirection,
  type OrganisationSort,
  UnknownSortKeyError,
  type ListOrganisationsOptions,
  listOrganisations,
} from "./crm-browse-repo";
