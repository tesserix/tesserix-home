/**
 * The CRM browse surface: the filterable, sortable organisation list.
 *
 * Split out of `crm-repo.ts` (#566); `crm-repo.ts` re-exports everything here,
 * so nothing importing `@/lib/db/crm-repo` had to change.
 *
 * Every clause that resolves an organisation's PRIMARY CONTACT — the follower
 * filter, `hasEmail`, and the four display subqueries below — comes from
 * `crm-sql.ts` and must keep coming from there. They form one set that has to
 * resolve the same contact, and a locally re-spelled copy is how they drift.
 */
import { tesserixQuery } from "./tesserix";
import { UNASSIGNED_PRODUCT, UNKNOWN_COUNTRY, type FollowerFilter } from "./crm-filters";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  trimBackwardPage,
  trimForwardPage,
} from "./keyset-cursor";
import { toIsoRequired } from "./crm-row";
import {
  notErased,
  notVoided,
  primaryContactFollowerClause,
  primaryContactOrder,
} from "./crm-sql";

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
