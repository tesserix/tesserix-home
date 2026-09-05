import { countryFromLocation } from "@tesserix/crm-country";
import { tesserixQuery, tesserixTx, type TxQuery } from "./tesserix";
import {
  FOLLOWER_BANDS,
  UNASSIGNED_PRODUCT,
  UNKNOWN_COUNTRY,
  UNKNOWN_FOLLOWERS,
  type FollowerFilter,
} from "./crm-filters";
import { isSafeWebsiteUrl } from "./crm-url";
import { CONTACT_SOURCE, isSelectableLawfulBasis, type LawfulBasis } from "../crm-provenance";
import { normalizeContactEmail, normalizeInstagramHandle } from "./crm-identity";
import {
  ERASURE_HASH_KEY_ENV,
  erasureHashes,
  isErasureHashKeyConfigured,
} from "./crm-erasure-hash";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  trimBackwardPage,
  trimForwardPage,
  type KeysetCursor,
} from "./keyset-cursor";
import {
  isUsableImportRow,
  parseCountCell,
  parseMetadataCell,
  requiresProduct,
  CONTACT_ACTIVITY_KINDS,
  isOutboundActivityKind,
  NEXT_ACTION_DAYS,
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
 * `EXISTS` clause matching organisation `${orgAlias}.id`'s PRIMARY contact
 * into `band` — selected with `primaryContactOrder()`, the same ordering the
 * row itself is displayed with, so a filter can never resolve a different
 * contact than the one on screen (see that function's doc comment for why
 * that has been a defect twice already). Shared by the queue's `filterClause`
 * and the browse surface's `organisationFilterClauses` so the two can never
 * drift apart on what "the primary contact's follower band" means.
 *
 * A NULL `followers_count` is excluded explicitly (`IS NOT NULL`), not left
 * to fail the upper bound implicitly: `NULL <= 999` is NULL, not true, in
 * SQL, so the exclusion holds either way — but leaving it implicit would
 * make that reliance invisible to the next reader.
 */
function primaryContactFollowerClause(
  orgAlias: string,
  band: FollowerFilter,
  params: unknown[],
): string {
  if (band === UNKNOWN_FOLLOWERS) {
    return primaryContactFollowerUnknownClause(orgAlias);
  }
  const bounds = FOLLOWER_BANDS[band];
  params.push(bounds.min);
  const minParam = `$${params.length}`;
  let upperBound = "";
  if (bounds.max !== null) {
    params.push(bounds.max);
    upperBound = ` AND c.followers_count <= $${params.length}`;
  }
  return `EXISTS (
        SELECT 1 FROM crm_contacts c
         WHERE c.organisation_id = ${orgAlias}.id
           AND c.id = (
             SELECT c2.id FROM crm_contacts c2
              WHERE c2.organisation_id = ${orgAlias}.id
                AND ${notErased("c2")}
              ORDER BY ${primaryContactOrder("c2")}
              LIMIT 1
           )
           AND c.followers_count IS NOT NULL
           AND c.followers_count >= ${minParam}${upperBound}
      )`;
}

/**
 * The complement of every band: organisation `${orgAlias}` has no primary
 * contact carrying a follower count.
 *
 * `NOT EXISTS`, scoped to the primary contact the same way the bands are, so
 * an organisation whose SECONDARY contact has 50k followers is still
 * "Unknown" — the bands describe the contact the row displays, and an
 * option that disagreed with them about which contact it means would put the
 * same organisation in two answers, or in neither.
 *
 * An organisation with no contacts at all satisfies this clause vacuously,
 * which is deliberate: it has no follower count to show either, its cell is
 * as blank as an unmeasured contact's, and excluding it would leave it
 * reachable from no follower option at all — the very defect this option
 * exists to fix. Band ∪ band ∪ band ∪ unknown therefore covers every row.
 *
 * Takes no `params`: this is a NULL/absence test, with nothing to bind.
 */
function primaryContactFollowerUnknownClause(orgAlias: string): string {
  return `NOT EXISTS (
        SELECT 1 FROM crm_contacts c
         WHERE c.organisation_id = ${orgAlias}.id
           AND c.id = (
             SELECT c2.id FROM crm_contacts c2
              WHERE c2.organisation_id = ${orgAlias}.id
                AND ${notErased("c2")}
              ORDER BY ${primaryContactOrder("c2")}
              LIMIT 1
           )
           AND c.followers_count IS NOT NULL
      )`;
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
 * The rows a bare clock bump may touch, as one SQL fragment both branches of
 * `advanceContactClock` — and `recordTemplatedDm` — substitute in.
 *
 * IT IS ONE CONSTANT BECAUSE IT WAS ONCE TWO COPIES, AND ONE OF THEM WAS
 * EMPTY. The organisation-wide branch carried both guards from the start; the
 * by-id branch carried neither, and the two sat six lines apart in this file
 * disagreeing about which rows a clock bump is allowed to reach. That is not a
 * cosmetic difference:
 *
 *   Migration 0021's CHECK (`stage IN ('new','contacted') OR product IS NOT
 *   NULL`) is re-evaluated against the NEW row version of every UPDATE,
 *   including one that only moves a timestamp. So a per-deal log against a
 *   grandfathered qualified/won/lost opportunity with a null product aborted
 *   the whole transaction — taking the `crm_activities` insert down with it.
 *   The operator was told their note could not be saved, and the reason was
 *   that an unrelated deal is missing a product.
 *
 * Losing the record of the contact is the expensive failure; a grandfathered
 * row that keeps drifting until someone supplies the product `setNextAction`
 * already asks for is the visible, fixable one. So the predicate skips exactly
 * the rows the CHECK would reject.
 *
 * Terminal deals are excluded for a different reason, unrelated to the CHECK:
 * a won or lost deal is not being worked, so a clock that exists to say
 * "nobody has touched this lately" has nothing to say about it. The by-id
 * branch now agrees with that too — naming a won deal explicitly does not make
 * it live again.
 *
 * A VOIDED DEAL IS EXCLUDED, third and for a third reason (#251). This is the
 * clock predicate that matters most for a void, because of the
 * by-ORGANISATION branch: an activity that names no deal — every DM the
 * composer sends, every organisation-level note — bumps the clocks of EVERY
 * eligible deal on that organisation. Without this conjunct, logging a call to
 * a business would silently reschedule a deal that had been voided, giving it
 * a fresh `next_action_at` and putting it back on Due. Nothing an operator did
 * would look like the cause. The by-id branch needs it as well: naming a
 * voided deal explicitly does not un-void it, exactly as naming a won one does
 * not make it live.
 */
export const CLOCK_ELIGIBLE_SQL = `stage NOT IN ('won', 'lost')
          AND (stage IN ('new', 'contacted') OR product IS NOT NULL)
          AND ${notVoided("")}`;

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
 * What this contact event does to `next_action_at` — the column that decides
 * which queue a lead is in (#502).
 *
 * THE COLUMN IS NOT OPTIONAL METADATA. `crm_opp_due_idx` and
 * `crm_opp_drifting_idx` are two partial indexes over the same rows split on
 * exactly this predicate: `next_action_at IS NOT NULL` is Due, `IS NULL` is
 * Drifting. So a clock bump that moved `last_contacted_at` and left this null
 * did not fail to schedule a follow-up — it actively filed the lead as
 * drifting. That is the production state the issue describes: Due empty,
 * Drifting holding all 259, every one of them reading "waiting 121d".
 *
 * OUTBOUND schedules a chase `NEXT_ACTION_DAYS` out. INBOUND is due NOW.
 *
 * The inbound half is where this departs from the issue as written, which said
 * a reply "shouldn't schedule anything, because it means act now". The
 * reasoning is right and the conclusion inverts it: null is not "act now", it
 * is the literal definition of Drifting, so leaving a reply unscheduled files
 * the hottest lead in the queue into the same bucket as the ones nobody has
 * touched since May. `now()` is what "act now" actually spells.
 *
 * A DEFAULT, NOT A RULE, and the `CASE` is where that is enforced. A date
 * already in the FUTURE is a decision the operator made about something that
 * has not happened yet, and sending a DM today does not un-make it — an
 * unconditional assignment would silently overwrite "check back in a month"
 * with "check back on Friday" every time anyone logged anything.
 *
 * A date in the PAST is not spared, and that is the other half. It described an
 * action that is now overdue, and this event is very likely that action having
 * been taken; leaving it would pin the lead permanently at the top of Due, so
 * working a lead could never take it off the list. Outbound therefore moves a
 * stale date forward, and inbound only ever pulls a date EARLIER — an overdue
 * chase that a reply arrives against stays overdue, because the reply did not
 * make it less late.
 *
 * `next_action_note` is deliberately untouched HERE. It holds the operator's
 * own words about what to do next, and a default date is not grounds to
 * rewrite them; a null note beside a real date reads as "something, soon",
 * which is honest, where a machine-written one would read as a plan nobody
 * made. `recordTemplatedDm` does write one, because it has a real fact to put
 * in it — the name of the template that was sent — and it gates that write on
 * `OUTBOUND_RESCHEDULES_SQL`, exported below, so the note and the date it
 * describes can never come apart.
 */
export const OUTBOUND_RESCHEDULES_SQL = `next_action_at IS NULL OR next_action_at <= now()`;

export function nextActionAssignment(kind: CrmActivityKind): string {
  // `NEXT_ACTION_DAYS` is a module constant integer, not caller input, so it
  // interpolates into the interval literal rather than binding as a parameter —
  // this fragment is shared by two statements whose placeholders are numbered
  // differently, and a `$n` here would have to mean something different in each.
  return isOutboundActivityKind(kind)
    ? `CASE WHEN ${OUTBOUND_RESCHEDULES_SQL}
                THEN now() + interval '${NEXT_ACTION_DAYS} days'
                ELSE next_action_at END`
    : `CASE WHEN next_action_at IS NULL OR next_action_at > now()
                THEN now()
                ELSE next_action_at END`;
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

/**
 * The one ordering that decides which contact is "the primary": the flagged
 * contact, then the oldest, then by `id`.
 *
 * One helper rather than the ordering spelled out at each site because seven
 * queries use this ordering — four display subqueries and two filter
 * subqueries in `listOrganisations`, `wonWithoutConversion`'s primary-email
 * lookup, and `organisationDetail`'s full contact list (which orders the
 * whole list this way rather than picking one row) — and they must agree.
 * Two of them previously ordered by `name` instead, so following a list row
 * to its detail page could show a different "primary" contact than the list
 * did.
 *
 * `id` last is load-bearing: `crm_contacts.created_at` is not unique (an
 * import writes a batch of contacts in one transaction, sharing it exactly),
 * so without a total order each subquery breaks a tie independently — the
 * `followers`/`hasEmail` filter matching on one contact while the row on
 * screen shows another. Same reason the organisation keyset carries `id`.
 *
 * @param alias the table alias in the calling query, or "" when unaliased.
 */
function primaryContactOrder(alias: string): string {
  const prefix = alias === "" ? "" : `${alias}.`;
  return `${prefix}is_primary DESC, ${prefix}created_at ASC, ${prefix}id ASC`;
}

/**
 * The predicate that keeps an ERASED contact out of primary-contact
 * selection (#301).
 *
 * Erasure (`crm-erasure.ts`) redacts a contact in place — it does not delete
 * the row, and deliberately so: the organisation keeps its history and its
 * activity trail. But `is_primary` survives that redaction, so without this
 * predicate the erased row stays the contact every queue and browse filter
 * resolves to. An organisation whose primary contact exercised erasure was
 * then filtered on a person who asked to be forgotten, and — where a LIVE
 * second contact existed — on the wrong person entirely: the live contact's
 * follower count and email were invisible to the filters while the erased
 * row held the primary slot.
 *
 * Applied wherever ONE contact is picked to stand for the organisation: the
 * two follower clauses, `hasEmail`, and `listOrganisations`' primary-contact
 * lateral, which resolves the four display columns together. (The one place
 * that picks a single contact without it is `wonWithoutConversion`'s lateral,
 * for the reason its own comment gives — it selects on `email IS NOT NULL`,
 * which erasure already excludes.) It is applied to nothing that reads the
 * organisation's contacts as a record: `organisationDetail` still lists the
 * erased contact, because "who is primary for queue purposes" and "what does
 * this organisation's file contain" are different questions and only the
 * first is about erasure. `contact_count` likewise still counts it.
 *
 * An organisation whose ONLY contact is erased therefore has no primary
 * contact at all, and falls into the Unknown follower band — which already
 * exists to hold exactly that shape of row (see
 * `primaryContactFollowerUnknownClause`).
 *
 * `platform-api`'s `primaryContactExists` carries the same predicate; the two
 * implementations are both live against the same schema and must not disagree
 * on a compliance-adjacent surface.
 *
 * @param alias the table alias in the calling query, or "" when unaliased.
 */
function notErased(alias: string): string {
  const prefix = alias === "" ? "" : `${alias}.`;
  return `${prefix}erased_at IS NULL`;
}

/**
 * The soft-delete predicate for opportunities (#251), in the shape
 * `notErased` above uses for contacts and for the same reason: written out by
 * hand it is a conjunct nobody can find, and the whole risk of a void is a
 * query that was missed.
 *
 * A voided deal is one an operator has said should never have been in the
 * funnel. It keeps every row it had — nothing is deleted, and `restoreOpportunity`
 * puts it back — but it leaves every surface that answers "what is in play"
 * (both work queues, the Closed list, the browse list's `open_opportunities`),
 * every clock that would reschedule it (`CLOCK_ELIGIBLE_SQL`), and every write
 * that would attribute something to it (`wonWithoutConversion`, and both of
 * `linkConversion`'s deal lookups).
 *
 * Not every query takes it, and each one that declines says so where it
 * declines: `organisationDetail`, `listOrganisations`' `products` array, and
 * `organisationFilterClauses`' product EXISTS all keep voided deals on
 * purpose. Use this helper only where the answer is "excluded"; adding it
 * somewhere new is a decision, not a tidy-up.
 *
 * @param alias the table alias in the calling query, or "" when unaliased.
 */
function notVoided(alias: string): string {
  const prefix = alias === "" ? "" : `${alias}.`;
  return `${prefix}voided_at IS NULL`;
}

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
    }>(
      // Voided deals stay in this list, deliberately — the same reasoning
      // `notErased()` records for erased contacts just above (#251). This
      // page is the organisation's FILE, not a work queue: the queues,
      // Closed and the handoff list all exclude a voided deal, and if this
      // list excluded it too the deal would be unreachable and there would
      // be nothing for a Restore control to hang off. `advanceStageOnQuery`
      // and `setNextAction` refuse a voided row with
      // `VoidedOpportunityError` precisely because it is visible here.
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

/** Both normalisers now live in `crm-identity.ts` and are re-exported here so
 *  `crm-writes.ts` (#236) keeps its existing import path.
 *
 *  They moved for #226: `crm-erasure-hash.ts` has to derive its HMAC input
 *  with the SAME functions `findMatchingOrganisationId` matches with, and
 *  importing them from this module would have made this module and that one
 *  import each other. See `crm-identity.ts` for why one definition — not two
 *  that agree — is the thing that matters here. */
export { normalizeInstagramHandle };

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
    // Canonicalised to match the write path (`addSuppression`) and the
    // database trigger (migration 0022), both of which store
    // `trim(lower(email))`. Before Ruling 19 neither side trimmed, so an
    // untrimmed lookup still matched an untrimmed stored value; now that the
    // stored form is always canonical, a lookup that skips the trim can miss
    // a real match on nothing but leading/trailing whitespace — exactly the
    // input a CSV import (Task 8) carries as a matter of course.
    params.push(normalizeContactEmail(input.email));
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
  const email = input.email ? normalizeContactEmail(input.email) : null;
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
 * The same rule now holds for the erasure register (#226): both paths call
 * `isErased`, in the same order relative to `isSuppressed`, so neither can
 * report a file differently from the other. Erasure has the stronger claim of
 * the two — a suppression can be lifted by an operator, an erasure is a
 * request to be forgotten — so it is checked first and counted separately.
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
 * 0023 — over a column 0023's `crm_contacts_normalize_trg` keeps in the
 * same canonical form `normalizeInstagramHandle` produces, so the index
 * constrains what this function actually looks up), the same two keys
 * `crm_suppressions` is keyed on. A row that
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
    params.push(normalizeContactEmail(input.email));
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

/**
 * The erasure register (#226, migration 0041).
 *
 * `eraseContact` nulls `email` and `instagram_handle`, and
 * `findMatchingOrganisationId` above matches on exactly those two columns. So
 * before this, a re-import of an erased person matched NOTHING and
 * `commitImport` created them again as a fresh organisation with a fresh
 * opportunity — the erasure silently undone, and the new row carrying no
 * trace that a request had ever been made. `crm_contacts.erased_at` had
 * existed since migration 0024 and was written by nobody's reader; 0024's own
 * header predicted this exact failure and the read half never shipped.
 *
 * The register holds a keyed HMAC of each destroyed identifier and nothing
 * else — no contact id, no organisation id, no plaintext. See
 * `crm-erasure-hash.ts` for why HMAC rather than a bare digest, and migration
 * 0041 for why the table deliberately has no foreign key to anything.
 */

/**
 * Thrown when an import cannot check the erasure register.
 *
 * This exists for exactly one situation: `CRM_ERASURE_HASH_KEY` is unset AND
 * the register is not empty. Both halves matter.
 *
 * With no key and an EMPTY register there is nothing wrong — `eraseContact`
 * throws without a key, so no hash can ever have been recorded, so there is
 * nothing an import could have matched and nothing it can get wrong. The two
 * halves of the feature cannot disagree, because neither of them runs.
 *
 * With no key and a NON-empty register the picture inverts: somebody's
 * erasure IS recorded, and this import would compute no hashes, match
 * nothing, and re-create them — while cheerfully reporting `skippedErased: 0`
 * as though it had checked. That is the silent no-op the whole feature exists
 * to prevent, and it is not something an operator could ever notice from the
 * summary card. Refusing the import outright is the only honest answer: it is
 * recoverable in one deploy, and importing is recoverable only by erasing the
 * same person a second time.
 *
 * Operator-facing (see `mapError` in `lib/crm-write.ts`) and it names the
 * variable, because the remedy is to provision it and retry.
 */
export class ErasureCheckUnavailableError extends Error {
  constructor() {
    super(
      `This import cannot run: ${ERASURE_HASH_KEY_ENV} is not configured, but contacts have ` +
        `already been erased. Importing without it would re-create people who asked to be ` +
        `forgotten. Set the variable and try again.`,
    );
    this.name = "ErasureCheckUnavailableError";
  }
}

/**
 * A once-per-batch guard that refuses the import if the erasure check could
 * not mean anything.
 *
 * Returns a function rather than being one, for two reasons that both matter:
 *
 * ONCE per batch, not once per row. The question — "is the register non-empty
 * while the key is missing?" — has one answer for the whole import, and
 * asking it 500 times against a `max: 2` pool is the connection pressure
 * Ruling 23 exists to avoid.
 *
 * LAZILY, not up front. `previewImport`'s guarantee is that a batch of rows
 * with nothing to identify them touches the database not at all — pinned by
 * `crm-repo.test.ts` — and hoisting this to the top of the loop would break
 * it for no gain: with no row to check, there is nothing the register could
 * have been consulted about.
 *
 * The probe itself only runs on the branch where the key is missing, which is
 * never in a correctly configured deployment. `LIMIT 1` because the count is
 * irrelevant; the question is whether the register is empty.
 *
 * Both `previewImport` and `commitImport` use it, for the same reason both
 * call `isSuppressed`: a preview that quietly ignored the register would
 * promise an operator N creations that the commit must then refuse.
 *
 * The returned function throws {@link ErasureCheckUnavailableError}.
 */
function erasureCheckGuard(query: TxQuery): () => Promise<void> {
  let settled = false;
  return async () => {
    if (settled) return;
    settled = true;
    if (isErasureHashKeyConfigured()) return;
    const rows = await query<{ one: number }>(
      `SELECT 1 AS one FROM crm_erased_identifiers LIMIT 1`,
      [],
    );
    if (rows.length > 0) throw new ErasureCheckUnavailableError();
  };
}

/**
 * Whether either identifier belongs to someone who asked to be forgotten.
 *
 * Shaped like `isSuppressed` on purpose — same `SuppressionCheck` input, same
 * `query` override, same `false` for a row carrying neither key — because the
 * two run back to back on every import row and a reader should not have to
 * hold two different calling conventions in mind to see that both are
 * checked.
 *
 * `query` defaults to `tesserixQuery`; `commitImport` passes its
 * transaction's own scoped query for the reasons in `isSuppressed`'s comment
 * (Ruling 23). Here the connection argument is the operative one: this is a
 * pure read of a table the import never writes, but acquiring a second pooled
 * client per row against `max: 2` is how two concurrent commits starve each
 * other out of the pool.
 *
 * Returns `false` — rather than throwing — when the key is unset. That is not
 * a fail-open: {@link assertErasureCheckable} has already refused the batch if
 * a single hash exists that this could have missed. Splitting it that way is
 * what keeps the per-row path free of a check that can only ever have one
 * answer for the whole batch.
 */
export async function isErased(
  input: SuppressionCheck,
  query: TxQuery = tesserixQuery,
): Promise<boolean> {
  if (!isErasureHashKeyConfigured()) return false;
  const hashes = erasureHashes(input);
  if (hashes.length === 0) return false;

  const rows = await query<{ identifier_hash: string }>(
    // `= ANY($1::text[])`, one round trip, rather than a clause per
    // identifier: the parameter count then does not depend on which of the
    // two keys the row happens to carry, so the statement text is identical
    // for every row and the planner sees one prepared shape. The explicit
    // cast is not optional — without it the driver's array literal arrives
    // as `unknown` and the comparison against a `text` column is ambiguous.
    `SELECT identifier_hash FROM crm_erased_identifiers WHERE identifier_hash = ANY($1::text[]) LIMIT 1`,
    [hashes],
  );
  return rows.length > 0;
}

export interface ImportPreview {
  toCreate: number;
  matchedExisting: number;
  skippedSuppressed: number;
  /**
   * Rows refused because the person asked to be forgotten (#226).
   *
   * A SEPARATE counter from `skippedSuppressed`, never folded into it, even
   * though both mean "we did not create this row". They are different legal
   * requests with different remedies, and the import card's copy for the
   * suppressed case tells the operator to remove the suppression — advice
   * that is actively wrong for someone who asked to be erased, and which an
   * operator could act on. A merged counter would put that wrong advice in
   * front of them with no way to tell the two apart.
   */
  skippedErased: number;
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
 *  only since migration 0023, which added BOTH halves it needs:
 *  `crm_contacts_instagram_lower_uq`, and the
 *  `crm_contacts_normalize_trg` trigger that guarantees the column holds the
 *  canonical form the index is expressed over. Before 0023 this set was the
 *  ONLY thing stopping two contacts sharing one canonical handle (issue
 *  #215); the index alone would have been only a partial backstop, since
 *  `lower('@bondibaker')` is `@bondibaker` and would have coexisted happily
 *  with a stored `bondibaker`. */
function importRowKeys(row: ImportRow): string[] {
  const keys: string[] = [];
  if (row.email) keys.push(`email:${normalizeContactEmail(row.email)}`);
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
  let skippedErased = 0;
  let malformed = 0;
  const matchedRows: ImportRow[] = [];
  const seenKeys = new Set<string>();
  const ensureErasureCheckable = erasureCheckGuard(tesserixQuery);

  for (const row of rows) {
    if (!isUsableImportRow(row)) {
      malformed++;
      continue;
    }
    const check: SuppressionCheck = { email: row.email, instagramHandle: row.instagramHandle };
    // Erasure BEFORE suppression, here and in `commitImport`, and the order
    // is load-bearing rather than arbitrary. Someone can be on both lists,
    // and whichever check runs first decides which counter — and therefore
    // which remedy — the operator is shown. "Remove the suppression" is the
    // wrong instruction for a person who asked to be forgotten, and it is an
    // instruction an operator can actually carry out. The two paths run the
    // checks in the same order so they can never report the same file
    // differently.
    await ensureErasureCheckable();
    if (await isErased(check)) {
      skippedErased++;
      continue;
    }
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

  return { toCreate, matchedExisting, skippedSuppressed, skippedErased, malformed, matchedRows };
}

export interface ImportResult {
  importId: string;
  created: number;
  matchedExisting: number;
  skippedSuppressed: number;
  /** Rows refused because the person asked to be forgotten (#226) — see
   *  `ImportPreview.skippedErased` for why this is never folded into
   *  `skippedSuppressed`. The same file must produce the same number here as
   *  it does at preview; `crm-repo.integration.test.ts` pins that. */
  skippedErased: number;
  malformed: number;
  /**
   * Rows that WERE created, but whose `website_url` cell failed
   * `isSafeWebsiteUrl` and was stored as NULL. Deliberately not folded into
   * `malformed` — that counter means "no organisation was created for this
   * row" — but it cannot go unreported either: there is no organisation edit
   * surface, so an operator who is never told cannot ever put the address
   * back. Zero for an import where every URL was fine, which is the common
   * case and reads as such.
   */
  droppedWebsiteUrls: number;
  /**
   * Count CELLS (not rows) whose `followers`/`posts` value was not a plain
   * whole number and was stored as NULL — `1.2k`, `n/a`, a blank-but-present
   * `-`. One row with both cells bad counts twice.
   *
   * Same contract as `droppedWebsiteUrls` and separate from `malformed` for
   * the same reason: the row WAS created, so folding it into a counter that
   * means "no organisation was created for this row" would make that counter
   * mean two things. The two count columns share one counter because they
   * share one remedy — correct the sheet, import again — and splitting them
   * would put two numbers on the summary card that an operator can only ever
   * act on together.
   */
  droppedCountCells: number;
  /** Rows created with their `metadata` cell dropped to `{}` because it was
   *  not a JSON object. Counted for the same reason as the above: nothing
   *  else would tell the operator the retained scrape output was lost. */
  droppedMetadataCells: number;
  matchedRows: readonly ImportRow[];
}

/**
 * What a scrape cell became, and whether anything was lost turning it into
 * that. The `dropped` half is why these return a pair rather than a bare
 * value: a refused cell and an absent cell both store nothing, and only the
 * refused one is worth reporting to the operator.
 */
interface CellOutcome<T> {
  value: T;
  dropped: number;
}

function countCell(raw: string | undefined): CellOutcome<number | null> {
  const trimmed = raw?.trim();
  if (!trimmed) return { value: null, dropped: 0 };
  const value = parseCountCell(trimmed);
  return { value, dropped: value === null ? 1 : 0 };
}

function metadataCell(raw: string | undefined): CellOutcome<Record<string, unknown>> {
  const trimmed = raw?.trim();
  if (!trimmed) return { value: {}, dropped: 0 };
  const value = parseMetadataCell(trimmed);
  return { value: value ?? {}, dropped: value === null ? 1 : 0 };
}

/**
 * Commit a batch of parsed CSV rows: one `crm_imports` row for the batch,
 * one `crm_organisations`/`crm_contacts`/`crm_opportunities` triple per row
 * that creates something new, all in a single transaction — either the
 * whole batch lands or none of it does, so a failure partway through never
 * leaves an orphaned `crm_imports` row with no organisations to show for it.
 *
 * Re-checks suppression AND the erasure register per row, exactly like
 * `previewImport` — see the module comment for why a stale preview cannot be
 * trusted to have already covered either. A row matching an existing organisation is counted but not
 * written, same as at preview: this does not merge into or update the
 * existing row.
 *
 * `lawfulBasis` is declared ONCE FOR THE BATCH (#248), not per row, and has
 * no default. A CSV of scraped profiles has one answer to "why may we hold
 * these people" for the whole file — the operator who chose the file is the
 * only one who knows it, and a per-row column would ask them to repeat a
 * single decision N times and let rows disagree. It is rejected here as well
 * as at the action, on the same reasoning `insertContact` states.
 * `source` is `'import'` for every contact created here (matching the
 * `crm_opportunities.source` this function already writes) and `sourced_at`
 * is the commit's own `now()`.
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
  lawfulBasis: LawfulBasis,
  filename?: string,
  totalRows: number = rows.length,
): Promise<ImportResult> {
  if (!isSelectableLawfulBasis(lawfulBasis)) {
    throw new Error(`commitImport: ${String(lawfulBasis)} is not a selectable lawful basis`);
  }
  return tesserixTx(async (query) => {
    let created = 0;
    let matchedExisting = 0;
    let skippedSuppressed = 0;
    let skippedErased = 0;
    let malformed = 0;
    let droppedWebsiteUrls = 0;
    let droppedCountCells = 0;
    let droppedMetadataCells = 0;
    const matchedRows: ImportRow[] = [];

    const ensureErasureCheckable = erasureCheckGuard(query);

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
      // Erasure first, then suppression — the same order `previewImport`
      // uses, for the reason documented there: the order decides which
      // counter, and therefore which remedy, the operator is shown for a
      // person who is on both lists.
      await ensureErasureCheckable();
      if (await isErased(check, query)) {
        skippedErased++;
        continue;
      }
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
      // A hostile `website_url` cell (`javascript:alert(1)`, `data:...`) is
      // one bad field on an otherwise usable row — not a reason to reject
      // the whole row, and certainly not a reason to throw mid-loop and roll
      // back every row already committed in this batch (Ruling 23's
      // same-transaction guarantee cuts both ways: one bad row must not cost
      // the others). Stored as NULL instead, exactly like the column's
      // existing "blank cell" handling one line below.
      //
      // Counted, though, in its own `droppedWebsiteUrls` — not in
      // `malformed`, which means "no organisation was created for this row"
      // (see the `isUsableImportRow` check above) and would come to mean two
      // things at once. The count is what makes the drop recoverable at all:
      // there is no organisation edit surface anywhere in the console, so a
      // silently dropped address is gone until the row is re-imported, and an
      // operator who is not told has no way to know a re-import is owed.
      const trimmedWebsiteUrl = row.websiteUrl?.trim() || null;
      const websiteUrl =
        trimmedWebsiteUrl && isSafeWebsiteUrl(trimmedWebsiteUrl) ? trimmedWebsiteUrl : null;
      if (trimmedWebsiteUrl && !websiteUrl) {
        droppedWebsiteUrls++;
      }
      // `country` is derived from `location` at insert time, not left for a
      // later backfill to catch: a column no writer maintains decays into a
      // filter that silently stops matching new rows (see migration 0025).
      // `countryFromLocation` never guesses — an unmappable location yields
      // NULL, the same as it would for the one-shot backfill.
      const location = row.location?.trim() || null;
      const orgRows = await query<{ id: string }>(
        `INSERT INTO crm_organisations (name, website_url, location, country, category, tags, import_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          name,
          websiteUrl,
          location,
          countryFromLocation(location),
          row.category ?? [],
          row.tags ?? [],
          importId,
        ],
      );
      const organisationId = orgRows[0].id;

      // The scrape columns (#235). Each bad cell is stored as NULL (or `{}`
      // for the bag) and counted, exactly as `website_url` above: one
      // unusable cell must neither abort the batch nor silently become a
      // `0` that files the organisation in a follower band it is not in.
      const followersCount = countCell(row.followersCount);
      const postsCount = countCell(row.postsCount);
      droppedCountCells += followersCount.dropped + postsCount.dropped;
      const metadata = metadataCell(row.metadata);
      droppedMetadataCells += metadata.dropped;

      await query(
        // #248: `source`/`sourced_at`/`lawful_basis` land on the same INSERT
        // as the personal columns, not on a follow-up UPDATE — a row that
        // exists for even one statement without the justification for
        // holding it is the state this issue is about.
        `INSERT INTO crm_contacts
           (organisation_id, name, email, phone, instagram_handle, is_primary,
            biography, followers_count, posts_count, metadata,
            source, sourced_at, lawful_basis)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9::jsonb, $10, now(), $11)`,
        [
          organisationId,
          row.name?.trim() || null,
          row.email ? normalizeContactEmail(row.email) : null,
          row.phone?.trim() || null,
          row.instagramHandle ? normalizeInstagramHandle(row.instagramHandle) : null,
          row.biography?.trim() || null,
          followersCount.value,
          postsCount.value,
          JSON.stringify(metadata.value),
          CONTACT_SOURCE.import,
          lawfulBasis,
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

    return {
      importId,
      created,
      matchedExisting,
      skippedSuppressed,
      skippedErased,
      malformed,
      droppedWebsiteUrls,
      droppedCountCells,
      droppedMetadataCells,
      matchedRows,
    };
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
export interface HandoffPage {
  readonly rows: readonly HandoffRow[];
  /**
   * There are won deals past `limit` that this page does not contain.
   *
   * Carried rather than left to the caller to infer from `rows.length ===
   * limit`, which is wrong exactly at the boundary: a queue of precisely
   * `limit` rows would claim there is more waiting when there is not, and an
   * operator who works the queue to empty would never see it go quiet.
   *
   * Discovered by asking for one row more than `limit` and discarding it —
   * one query, not a second COUNT. The instance is a shared db-f1-micro and
   * this queue's exact depth is not worth a second scan; "more are waiting"
   * is the whole decision an operator makes from it.
   */
  readonly hasMore: boolean;
}

export async function wonWithoutConversion(limit: number): Promise<HandoffPage> {
  const rows = await tesserixQuery<RawHandoffRow>(
    `SELECT o.id, o.organisation_id, g.name AS organisation_name, o.product, o.closed_at,
            c.email AS primary_email
       FROM crm_opportunities o
       JOIN crm_organisations g ON g.id = o.organisation_id
       LEFT JOIN LATERAL (
         -- No erased_at test, unlike the primary-contact subqueries this
         -- ordering is otherwise shared with (see notErased()): erasure nulls
         -- the email, so the IS NOT NULL test already excludes an erased
         -- contact, and a second predicate here could only change this result
         -- if erasure stopped nulling it — at which point the erasure path,
         -- not this query, is the thing that broke.
         SELECT email FROM crm_contacts
          WHERE organisation_id = g.id AND email IS NOT NULL
          ORDER BY ${primaryContactOrder("")}
          LIMIT 1
       ) c ON true
      WHERE o.stage = 'won'
        -- A voided won deal is not waiting to be handed off (#251): the
        -- operator has said it should never have been won, so asking anyone
        -- to find its conversion is asking them to attribute a tenant to a
        -- deal that is on the record as a mistake. See linkConversion, which
        -- repeats this conjunct -- hiding the row here is not enough,
        -- because that function finds its won deal by organisation and
        -- product rather than from the row this queue handed out.
        AND ${notVoided("o")}
        AND (
          g.converted_at IS NULL
          OR g.converted_product IS DISTINCT FROM o.product
        )
      ORDER BY o.closed_at ASC NULLS LAST
      LIMIT $1`,
    // One more than asked for: the extra row is never rendered, it only
    // answers "is there anything past the cap".
    [limit + 1],
  );
  return {
    rows: rows.slice(0, limit).map(toHandoffRow),
    hasMore: rows.length > limit,
  };
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
    //
    // `AND voided_at IS NULL` is NOT redundant with `wonWithoutConversion`'s
    // own exclusion (#251). This lookup does not read the row the handoff
    // queue handed out — it re-finds a won deal from `organisation_id +
    // product + stage`. So hiding a voided won deal from the queue does not
    // stop it being selected here, by a manual link or by a suggestion
    // confirmed for the same organisation and product.
    //
    // WHAT THIS CONJUNCT DOES, AND WHAT IT DOES NOT. The organisation UPDATE
    // above has already run, and it takes `(organisationId, product, ref)`
    // alone — the deal selected here is not an input to it. So dropping this
    // conjunct changes neither the organisation's conversion nor whether
    // `AlreadyLinkedError` fires; what stops a voided deal being OFFERED for
    // linking is `wonWithoutConversion`, which keeps it out of the queue.
    // What this conjunct alone decides is where the Ruling 31 note lands — on
    // a deal declared never to have happened, or on the organisation only —
    // and, because a match here skips the backfill below, whether a live
    // product-less won deal gets its product written at all.
    //
    // The ORGANISATION still links when its only won deal is voided, and that
    // is deliberate: a conversion is a fact about the business, and businesses
    // convert without a CRM deal behind them. Do NOT "fix" this by moving the
    // void test above the organisation UPDATE — that would refuse a real
    // handoff, which is the opposite of the ruling.
    const opportunityRows = await query<{ id: string }>(
      `SELECT id FROM crm_opportunities
        WHERE organisation_id = $1 AND product = $2 AND stage = 'won'
          AND ${notVoided("")}
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
    //
    // `AND voided_at IS NULL` in the inner SELECT, for the reason the lookup
    // above gives (#251) and one more of its own: this statement WRITES a
    // product onto the row it picks. Letting it pick a voided deal would
    // fabricate exactly the attribution the lead migration declined to
    // invent, onto a deal already declared a mistake, and would then hang
    // the conversion note off it.
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
                   AND ${notVoided("")}
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

export interface OrganisationFilter {
  /** Free-text: matches organisation name, contact name, contact email,
   *  contact instagram handle. Case-insensitive substring. */
  search?: string;
  /** Only organisations created by this import batch. */
  importId?: string;
  /** A real product string, or `UNASSIGNED_PRODUCT` for opportunities with
   *  no product set. Lives on `crm_opportunities`, not the organisation —
   *  matched with EXISTS since one organisation can have several. */
  product?: string;
  /** ISO 3166-1 alpha-2, exact match on the derived `crm_organisations.country`
   *  column (Task 3/4), or `UNKNOWN_COUNTRY` for the rows where it is NULL.
   *  Never a pattern over the raw `location`. */
  country?: string;
  /** Follower-count band of the organisation's primary contact, or
   *  `UNKNOWN_FOLLOWERS` for rows that have no such count to show. */
  followers?: FollowerFilter;
  /** True to require the primary contact to have an email on file. */
  hasEmail?: boolean;
}

export interface OrganisationListRow {
  id: string;
  name: string;
  location: string | null;
  /**
   * ISO 3166-1 alpha-2 code derived from `location`, and the value the
   * `country` filter matches on. `null` where nothing could be derived —
   * no location, or a location the mapper had no entry for; 208 of the 259
   * production organisations are in one of those two states
   * (`crm-filters.ts`) — so the surface can show which rows it resolved
   * rather than leaving the filter's misses indistinguishable from its hits.
   */
  country: string | null;
  contactName: string | null;
  contactEmail: string | null;
  /** Primary contact's Instagram handle, for handle-first rendering. */
  contactHandle: string | null;
  /**
   * Primary contact's follower count — the CRM's only quantitative
   * qualification signal, and the number the `followers` filter bands on.
   *
   * `null` means no recorded count, which is not the claim a zero makes: the
   * row belongs in the Unknown band, and the surface must render it blank
   * rather than as `0` (see `UNKNOWN_LABEL` in `crm-filters.ts`). Resolved
   * through the same `primaryContactOrder`/`notErased` pair as the filter, so
   * the displayed number is always the one the band matched on.
   */
  followersCount: number | null;
  /** How many contacts this organisation has. */
  contactCount: number;
  websiteUrl: string | null;
  /** Open (non-won/lost) opportunity count. */
  openOpportunities: number;
  /** Distinct products across this org's opportunities, nulls dropped. */
  products: readonly string[];
  createdAt: string;
}

export interface OrganisationPage {
  rows: OrganisationListRow[];
  /** Total matching the filter, ignoring pagination. */
  total: number;
  /**
   * How many matching rows sort ahead of this page — 0 on the first page.
   *
   * On the default (cursor) read this is counted in SQL, because a cursor
   * carries no position and a `?page=` param an operator could edit would let
   * the surface state a range it hasn't got. On a SORTED read the offset IS
   * the position the caller asked for, so it is that offset, capped at
   * `total`.
   */
  precedingCount: number;
  /** Opaque cursor for the next page; null when this is the last page, and
   *  always null under a sort — see `listOrganisations`. */
  nextCursor: string | null;
  /** Opaque cursor for the previous page; null on the first page and always
   *  null under a sort. Under the cursor regime it is non-null exactly when
   *  `precedingCount > 0`, so the Previous control and the displayed range
   *  are answering out of the same count. */
  previousCursor: string | null;
}

/**
 * Builds the `WHERE` predicate for `filter` — search, import batch, product,
 * country, follower band and has-email — never the pagination cursor, which
 * is position, not a predicate. Called by both the page query and the count
 * query in `listOrganisations` so the two can never disagree about what
 * "matching" means: a total computed from a second, hand-copied predicate is
 * the classic way a pager starts reporting a number that doesn't match the
 * rows on screen, and there are six predicates here that would otherwise
 * need updating in two places.
 */
function organisationFilterClauses(filter: OrganisationFilter, params: unknown[]): string[] {
  const clauses: string[] = [];

  if (filter.search) {
    // Escape backslash first so it doesn't double-escape what follows,
    // then % and _ — same treatment as the owner filter in filterClause.
    //
    // This EXISTS spans ANY contact, deliberately unlike `hasEmail` and
    // `followers` below, which bind to the primary contact: search answers
    // "where is the row I'm thinking of", so a hit on a secondary contact's
    // email is a hit, while those two filters describe the row the operator
    // will actually see. A row can therefore be found by a secondary
    // contact's email and still be excluded by "Has email on file".
    const escaped = filter.search
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    params.push(`%${escaped}%`);
    const p = `$${params.length}`;
    clauses.push(`(
        g.name ILIKE ${p} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM crm_contacts c
           WHERE c.organisation_id = g.id
             AND (
               c.name ILIKE ${p} ESCAPE '\\'
               OR c.email ILIKE ${p} ESCAPE '\\'
               OR c.instagram_handle ILIKE ${p} ESCAPE '\\'
             )
        )
      )`);
  }

  if (filter.importId) {
    params.push(filter.importId);
    clauses.push(`g.import_id = $${params.length}`);
  }

  if (filter.product) {
    // EXISTS, never a join: product lives on crm_opportunities and one
    // organisation can have several, so a join fans one org into a row per
    // matching opportunity and renders it twice.
    //
    // NO `voided_at IS NULL` here, and that is a decision rather than an
    // oversight (#251). "This organisation has a Mark8ly deal" stays true of
    // a voided one, and this filter is how an operator FINDS a business —
    // including the one whose only deal they just voided and now want to
    // open. The `open_opportunities` count in `listOrganisations` does
    // exclude them, because that one is read as work in play; these two
    // predicates answer different questions about the same rows.
    if (filter.product === UNASSIGNED_PRODUCT) {
      clauses.push(
        `EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.organisation_id = g.id AND o.product IS NULL)`,
      );
    } else {
      params.push(filter.product);
      clauses.push(
        `EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.organisation_id = g.id AND o.product = $${params.length})`,
      );
    }
  }

  if (filter.country === UNKNOWN_COUNTRY) {
    // The rows a named country cannot reach: an underivable or absent
    // location is not evidence of any market, so they stay out of every
    // real code — but they are the majority of the table (208 of 259), and
    // an operator has to be able to ask for them. `crm_org_country_idx` is
    // partial (`WHERE country IS NOT NULL`), so this predicate does not use
    // it; at this table's size that is a scan either way.
    clauses.push(`g.country IS NULL`);
  } else if (filter.country) {
    // Exact match on the derived column (crm_org_country_idx), not a
    // pattern over the raw location — a NULL country matches no filter
    // value, which is correct: an underivable location is not evidence of
    // any market.
    params.push(filter.country);
    clauses.push(`g.country = $${params.length}`);
  }

  if (filter.followers) {
    // Bounded on the primary contact, selected the same way the page query
    // selects the displayed contact — otherwise a row could appear under a
    // band its visible follower count contradicts. Shared with the queue's
    // `filterClause` via `primaryContactFollowerClause` so the two surfaces
    // can't drift apart on what "primary contact" or "NULL excluded" means.
    clauses.push(primaryContactFollowerClause("g", filter.followers, params));
  }

  if (filter.hasEmail) {
    // Bound to the primary contact, same as followers above — an org
    // matching through a non-primary contact's email would satisfy the
    // filter while the displayed contactEmail column stays blank.
    clauses.push(`EXISTS (
        SELECT 1 FROM crm_contacts c
         WHERE c.organisation_id = g.id
           AND c.id = (
             SELECT c2.id FROM crm_contacts c2
              WHERE c2.organisation_id = g.id
                AND ${notErased("c2")}
              ORDER BY ${primaryContactOrder("c2")}
              LIMIT 1
           )
           AND c.email IS NOT NULL
      )`);
  }

  return clauses;
}

interface RawOrganisationListRow {
  id: string;
  name: string;
  location: string | null;
  country: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_handle: string | null;
  followers_count: number | null;
  contact_count: string | number;
  website_url: string | null;
  open_opportunities: string | number;
  products: (string | null)[] | null;
  created_at: unknown;
}

function toOrganisationListRow(row: RawOrganisationListRow): OrganisationListRow {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    country: row.country,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactHandle: row.contact_handle,
    // Straight through, unlike the counts below: `crm_contacts.followers_count`
    // is an `integer` column (migration 0019), which pg maps to a JS number —
    // only the bigint that `count(*)` returns needs converting. A `Number()`
    // here would also turn a NULL into 0, which is the one value this column
    // must never invent.
    followersCount: row.followers_count,
    // count(*) comes back as a string from pg's bigint mapping.
    contactCount: Number(row.contact_count),
    websiteUrl: row.website_url,
    // count(*) comes back as a string from pg's bigint mapping.
    openOpportunities: Number(row.open_opportunities),
    // array_agg returns NULL (not an empty array) when nothing matches.
    products: (row.products ?? []).filter((p): p is string => p !== null),
    createdAt: toIsoRequired(row.created_at),
  };
}

/**
 * The columns the organisations list can be ordered by: a closed record from
 * the key a caller may name to the SQL expression that key means.
 *
 * This is a security boundary, not a convenience. An `ORDER BY` expression
 * cannot be a bound parameter, so whatever it is gets spliced into the
 * statement text — and every other sort key in this file (`DRIFTING_SORT_KEY`,
 * `QueuePageQuery.sortKey`) is a module literal for exactly that reason.
 * `listOrganisations` is the first read here whose ordering a caller chooses,
 * so the KEY is validated against this record and only the record's VALUE
 * reaches the SQL. The caller's string never does.
 *
 * Look the key up with `Object.hasOwn`, never `in`: `in` walks the prototype
 * chain, so `__proto__`, `constructor` and `toString` all read as recognised
 * keys. The organisations page hit precisely that with `?country=__proto__`.
 */
export const ORGANISATION_SORTS = {
  name: "g.name",
  /** The page query's lateral, so the count a row sorts by is by construction
   *  the count it displays — one expression feeds both.
   *
   *  It also matches the count the follower filter banded the row on, but for
   *  a different reason: `primaryContactFollowerClause` is a separate `EXISTS`
   *  in the shared `WHERE` and never reads `pc`. The two agree because both
   *  resolve the primary contact with `notErased` and `primaryContactOrder` —
   *  keep those in step, or a row can sort and display a number the band it
   *  came back under contradicts. */
  followers: "pc.followers_count",
  created: "g.created_at",
} as const;

export type OrganisationSortKey = keyof typeof ORGANISATION_SORTS;

export type SortDirection = "asc" | "desc";

export interface OrganisationSort {
  key: OrganisationSortKey;
  direction: SortDirection;
}

/**
 * Thrown when a sort key is not in `ORGANISATION_SORTS`.
 *
 * Thrown rather than quietly ignored: a caller asking for an ordering this
 * repo cannot give it has a bug (or is probing), and a silent fall back to
 * `created_at DESC` would show a page that contradicts the sort the URL
 * claims. The surface reading the URL is expected to validate against the
 * exported record first, so this is the boundary's second line, not its
 * first.
 */
export class UnknownSortKeyError extends Error {
  constructor(key: string) {
    super(`listOrganisations: unrecognised sort key ${JSON.stringify(key)}`);
    this.name = "UnknownSortKeyError";
  }
}

/**
 * How one page of `listOrganisations` is located.
 *
 * A union, not a bag of optional fields, because the two regimes are
 * mutually exclusive: the unsorted list pages by keyset cursor, a sorted one
 * by `?page=` offset. Letting a caller pass both would leave the function
 * choosing silently between two positions the URL asked for.
 *
 * Offset for sorted views is a deliberate trade, not an oversight — see the
 * pagination paragraph on `listOrganisations`.
 */
export type ListOrganisationsOptions =
  | { sort?: undefined; cursor?: string; page?: undefined }
  | { sort: OrganisationSort; page?: number; cursor?: undefined };

/** The `ORDER BY` fragment for `sort`, with the caller's key validated away.
 *  `NULLS LAST` on both directions: 51 of 259 contacts have no
 *  `followers_count`, and "unknown" is not "smallest" — it belongs at the end
 *  whichever way the operator reads the column. `g.id` last for the same
 *  reason the keyset carries it: `name` and `created_at` are not unique, and
 *  an unbroken tie makes a page boundary non-deterministic. */
function organisationSortOrder(sort: OrganisationSort): string {
  if (!Object.hasOwn(ORGANISATION_SORTS, sort.key)) {
    throw new UnknownSortKeyError(sort.key);
  }
  const expression = ORGANISATION_SORTS[sort.key];
  const direction = sort.direction === "asc" ? "ASC" : "DESC";
  return `${expression} ${direction} NULLS LAST, g.id DESC`;
}

/**
 * Browse and search. The reason this exists (#213): `commitImport` creates
 * every opportunity at stage 'new' with a null `next_action_at` and null
 * `last_contacted_at`, so a freshly imported lead is on neither queue for
 * fourteen days — Due needs a next action, Drifting needs a quiet period.
 * Without a list surface those rows are unreachable in the meantime.
 *
 * Search spans the organisation name AND its contacts' name/email/handle
 * because an imported lead is almost never looked up by business name —
 * the operator has the handle or the address the CSV carried.
 *
 * The contact columns come from a `LEFT JOIN LATERAL` that picks ONE
 * contact, not from a plain join: joining contacts fans a multi-contact
 * organisation into one row per contact, and de-duplicating afterwards
 * (DISTINCT ON, or a GROUP BY over every selected column) costs more. Which
 * contact it picks comes from `primaryContactOrder` and `notErased` — the
 * same ordering and the same erasure predicate the filter subqueries and the
 * detail page use, so all of them agree on a tie. `LEFT`, so an organisation
 * with no live contact keeps its row with null contact columns.
 *
 * One lateral rather than four correlated subqueries because the follower
 * count is now also an ORDER BY input: five copies of that scan is five
 * chances for one of them to resolve a different contact, and #563 mutation-
 * proved that the displayed count and the banded count must be the same
 * contact's.
 *
 * Pagination is keyset by default, not OFFSET: `OFFSET N` makes Postgres walk
 * and discard N rows every page, and a row inserted while the operator pages
 * shifts every subsequent page by one, silently skipping whatever crossed
 * the boundary — on this surface, a lead never contacted. Keyset on
 * `(created_at, id)` reads straight off the default `ORDER BY` and is
 * stable under concurrent inserts; `id` is the tiebreaker because
 * `created_at` is not unique (the migration wrote 259 rows in one batch).
 *
 * A SORTED view pages by offset instead, and gives that protection up. The
 * cursor is `{timestamp, id}` validated with `Date.parse`, and a follower
 * count is neither: generalising it is feasible, but the NULLs are not — a
 * row-value comparison `(k, id) < ($1, $2)` cannot express NULLS LAST,
 * because a NULL first element makes the whole comparison NULL and the row
 * disappears from every page. `COALESCE(followers_count, 0)` would sort 51
 * unknowns among the genuine zeros, which is the exact distinction
 * `toOrganisationListRow` and the browse table keep. Under offset it is one
 * clause and no sentinel. The trade costs little here — 259 rows, three
 * pages, and organisations arrive in batch imports rather than continuously
 * — and the default view keeps its cursor, so the protection is retained
 * where the argument above was made.
 *
 * `nextCursor` is derived by fetching `limit + 1` rows and dropping the
 * extra, not by comparing `total` to rows-seen-so-far — this function is
 * stateless across calls and has no reliable notion of "how many rows the
 * operator has already seen" to compare against, whereas an extra row is
 * cheap and self-contained proof that another page exists.
 *
 * A cursor also carries the direction it points in, so the same `?cursor=`
 * param serves Previous and Next and a shared link cannot lose which one it
 * was. This function and `queuePage` stay separate implementations, but not
 * because of direction: `queuePage` takes a required `direction` and
 * `closedOpportunities` runs it descending. They differ in what they read and
 * how they page — this one selects from `crm_organisations`, joins a lateral
 * for the primary contact, builds its filters with
 * `organisationFilterClauses`, and carries a second OFFSET regime for sorted
 * views; `queuePage` selects from `crm_opportunities` joined to their
 * organisations, filters with `filterClause`, and pages only by cursor. See
 * `keyset-cursor.ts`.
 */
export async function listOrganisations(
  filter: OrganisationFilter,
  limit: number,
  options: ListOrganisationsOptions = {},
): Promise<OrganisationPage> {
  const sort = options.sort;
  // Validated (and the offset computed) before either query runs, for the
  // same reason the cursor is: a request this function cannot serve must not
  // cost a round trip, and a rejected sort key must never reach a statement.
  const sortOrder = sort ? organisationSortOrder(sort) : null;
  const pageNumber = sort ? (options.page ?? 1) : 1;
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError(`listOrganisations: page must be a positive integer, got ${pageNumber}`);
  }
  const offset = (pageNumber - 1) * limit;
  // Decoded (and validated) before either query runs, so a malformed cursor
  // fails fast without spending a round trip on the count query it would
  // never get to use.
  const decodedCursor = options.cursor
    ? decodeKeysetCursor(options.cursor, "listOrganisations")
    : null;
  // Backwards is the mirror of every part of the forward read: the anchor is
  // the page's FIRST row rather than its last, the comparison and the ORDER
  // BY both flip, and the rows are re-reversed on the way out.
  const backwards = decodedCursor?.direction === "before";

  const countParams: unknown[] = [];
  const countClauses = organisationFilterClauses(filter, countParams);
  const countWhere = countClauses.length > 0 ? `WHERE ${countClauses.join("\n        AND ")}` : "";
  // Rows ahead of this page, in the list's own `created_at DESC, id DESC`
  // order — so "ahead" means a GREATER tuple, not a smaller one.
  //
  // Forward, the cursor is the last row of the previous page and the page
  // predicate below excludes it, so it counts as preceding (`>=`). Backward,
  // the cursor is the first row of the page being left: it sorts after this
  // page, so it is excluded (`>`), and the count then covers this page plus
  // everything ahead of it — the page's own length is subtracted below.
  //
  // Aggregated in the count query rather than asked for separately: it is
  // the same predicate over the same rows.
  let precedingSelect = "0";
  if (decodedCursor) {
    countParams.push(decodedCursor.timestamp);
    const createdAtParam = `$${countParams.length}`;
    countParams.push(decodedCursor.id);
    const idParam = `$${countParams.length}`;
    const comparison = backwards ? ">" : ">=";
    precedingSelect = `count(*) FILTER (WHERE (g.created_at, g.id) ${comparison} (${createdAtParam}, ${idParam}))`;
  }

  const params: unknown[] = [];
  const clauses = organisationFilterClauses(filter, params);
  if (decodedCursor) {
    params.push(decodedCursor.timestamp);
    const createdAtParam = `$${params.length}`;
    params.push(decodedCursor.id);
    const idParam = `$${params.length}`;
    clauses.push(
      `(g.created_at, g.id) ${backwards ? ">" : "<"} (${createdAtParam}, ${idParam})`,
    );
  }
  // limit + 1 under keyset: see the doc comment above for why an extra row,
  // not a total comparison, is what decides nextCursor. A sorted page knows
  // where it is from `total` and its offset, so it asks for exactly `limit`.
  params.push(sortOrder ? limit : limit + 1);
  let limitClause = `LIMIT $${params.length}`;
  if (sortOrder) {
    params.push(offset);
    limitClause += ` OFFSET $${params.length}`;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join("\n        AND ")}` : "";
  // Flipped with the comparison. Without this the LIMIT would keep the rows
  // furthest from the anchor — the newest rows in the whole list, not the
  // page immediately before this cursor.
  const order = backwards ? "ASC" : "DESC";
  const orderBy = sortOrder ?? `g.created_at ${order}, g.id ${order}`;

  // Independent reads over two disjoint parameter lists (built above, never
  // touched again) — safe to run concurrently rather than paying two
  // sequential round trips for every page view.
  const [countRows, rawRows] = await Promise.all([
    tesserixQuery<{ count: string | number; preceding: string | number }>(
      `SELECT count(*) AS count, ${precedingSelect} AS preceding
         FROM crm_organisations g ${countWhere}`,
      countParams,
    ),
    tesserixQuery<RawOrganisationListRow>(
      `SELECT g.id, g.name, g.location, g.country, g.website_url, g.created_at,
              pc.name AS contact_name,
              pc.email AS contact_email,
              pc.instagram_handle AS contact_handle,
              pc.followers_count AS followers_count,
              -- Counts every contact, erased ones included: the count says how
              -- many contacts the organisation's file holds, not which of them
              -- the lateral resolved to. See notErased().
              (SELECT count(*) FROM crm_contacts c
                WHERE c.organisation_id = g.id) AS contact_count,
              -- Voided deals excluded (#251): this number is read as "how
              -- much is in play here", the same question the two work
              -- queues answer, and a deal taken out of the funnel is not in
              -- play. Counting it would leave the browse list disagreeing
              -- with Due and Drifting about the same organisation.
              (SELECT count(*) FROM crm_opportunities o
                WHERE o.organisation_id = g.id
                  AND o.stage NOT IN ('won', 'lost')
                  AND ${notVoided("o")}) AS open_opportunities,
              -- NO void test here, deliberately. This array answers "which
              -- products has this organisation ever had a deal on", which
              -- stays true of a voided one -- the deal happened, and the
              -- void says it should not have been in the funnel, not that
              -- the product was never discussed. It feeds discovery (the
              -- product chips, and the product filter built in
              -- organisationFilterClauses, which declines the test for the
              -- same reason), not work.
              (SELECT array_agg(DISTINCT o.product) FROM crm_opportunities o
                WHERE o.organisation_id = g.id
                  AND o.product IS NOT NULL) AS products
         FROM crm_organisations g
         -- The organisation's primary contact, resolved once. The same
         -- contact primaryContactFollowerClause bands on: this ordering and
         -- this erasure predicate are the two things that make the two agree,
         -- so a row can never display — or sort by — a number that
         -- contradicts the band it came back under.
         LEFT JOIN LATERAL (
           SELECT c.name, c.email, c.instagram_handle, c.followers_count
             FROM crm_contacts c
            WHERE c.organisation_id = g.id
              AND ${notErased("c")}
            ORDER BY ${primaryContactOrder("c")}
            LIMIT 1
         ) pc ON TRUE
         ${where}
        ORDER BY ${orderBy}
        ${limitClause}`,
      params,
    ),
  ]);
  const total = Number(countRows[0]?.count ?? 0);

  // A sorted page asked for exactly `limit` rows, so there is no extra row
  // to trim and no cursor to derive from the ones there are.
  const { rows: pageRawRows, hasMore } = sortOrder
    ? { rows: rawRows, hasMore: false }
    : backwards
      ? trimBackwardPage(rawRows, limit)
      : trimForwardPage(rawRows, limit);
  const rows = pageRawRows.map(toOrganisationListRow);

  const counted = Number(countRows[0]?.preceding ?? 0);
  // Backward, the count covers this page too (see `precedingSelect`).
  const keysetPreceding = backwards ? Math.max(0, counted - pageRawRows.length) : counted;
  // Sorted, position IS the offset — the rows ahead of this page are the ones
  // the OFFSET skipped. Capped at `total` so a `?page=` past the end reports a
  // range inside the result set rather than beyond it.
  const precedingCount = sortOrder ? Math.min(offset, total) : keysetPreceding;

  const firstRow = pageRawRows[0];
  const lastRow = pageRawRows[pageRawRows.length - 1];
  // Backward, a next page needs no proof: this page was reached from the one
  // after it.
  const hasNextPage = backwards ? Boolean(lastRow) : hasMore;
  // Both null under a sort: a cursor names a position in `(created_at, id)`
  // order, which is not the order this page is in. The sorted surface pages
  // by `?page=` off `total` and `precedingCount` instead.
  const nextCursor =
    !sortOrder && hasNextPage && lastRow
      ? encodeKeysetCursor(toIsoRequired(lastRow.created_at), lastRow.id, "after")
      : null;
  const previousCursor =
    !sortOrder && precedingCount > 0 && firstRow
      ? encodeKeysetCursor(toIsoRequired(firstRow.created_at), firstRow.id, "before")
      : null;

  return { rows, total, precedingCount, nextCursor, previousCursor };
}
