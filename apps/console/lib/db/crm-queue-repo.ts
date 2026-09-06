/**
 * The CRM work queues: opportunities due for action, opportunities that have
 * gone quiet with nothing scheduled, and the closed list.
 *
 * Split out of `crm-repo.ts` (#566); `crm-repo.ts` re-exports everything here,
 * so nothing importing `@/lib/db/crm-repo` had to change.
 *
 * `filterClause`'s follower predicate comes from `crm-sql.ts`
 * (`primaryContactFollowerClause`) and must keep coming from there — the queue
 * and the browse surface have to mean the same contact by "the primary
 * contact's follower band".
 */
import { tesserixQuery } from "./tesserix";
import { UNASSIGNED_PRODUCT, UNKNOWN_COUNTRY, type FollowerFilter } from "./crm-filters";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  trimBackwardPage,
  trimForwardPage,
  type KeysetCursor,
} from "./keyset-cursor";
import { type CrmStage } from "../crm";
import { toIso, toIsoRequired } from "./crm-row";
import { notVoided, primaryContactFollowerClause } from "./crm-sql";

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
