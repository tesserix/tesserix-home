import { describe, expect, it, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("./tesserix", () => ({
  tesserixQuery: (...args: unknown[]) => query(...args),
  // `tesserixTx` hands its callback a query function scoped to one client.
  // The mock has no notion of a separate client — every call, transactional
  // or not, funnels through the same `query` spy, so a test can assert on
  // the full sequence of statements (SELECT, UPDATE, INSERT) a transactional
  // write issues, in order, exactly like it does for a plain read.
  tesserixTx: (fn: (query: (...args: unknown[]) => unknown) => unknown) => fn(query),
  isDatabaseConfigured: () => true,
}));

import {
  dueOpportunities,
  driftingOpportunities,
  advanceStage,
  setNextAction,
  logActivity,
  organisationDetail,
  ACTIVITY_LIMIT,
  MissingProductError,
  isSuppressed,
  addSuppression,
  removeSuppression,
  listSuppressions,
  previewImport,
  commitImport,
  findMatchingOrganisationId,
  wonWithoutConversion,
  linkConversion,
  AlreadyLinkedError,
  SuppressedContactError,
} from "./crm-repo";
import { UNASSIGNED_PRODUCT, UNKNOWN_COUNTRY, UNKNOWN_FOLLOWERS } from "./crm-filters";
import { encodeKeysetCursor } from "./keyset-cursor";

beforeEach(() => {
  query.mockReset();
  // A plausible default current-row for the write tests below: a real
  // organisation_id/product pair, stage "contacted" (product not required).
  // Tests that care about a specific current stage override with
  // `mockResolvedValueOnce` before calling in.
  query.mockResolvedValue([
    { stage: "contacted", organisation_id: "g1", product: null },
  ]);
});

/**
 * The queue's page query — the statement carrying the bound LIMIT. Both queue
 * functions issue a count query alongside it, so a positional
 * `query.mock.calls[0]` would assert against whichever of the two the
 * implementation happens to start first. Selecting by shape says which
 * statement is meant.
 */
const queuePageCall = (): [string, unknown[]] => {
  // Keyed on the bound LIMIT placeholder: only the page query has one. A
  // plain "ORDER BY" would also match the count query whenever a follower
  // filter is active, because that filter's EXISTS subquery carries its own
  // ORDER BY … LIMIT 1.
  const call = query.mock.calls.find(([sql]) => String(sql).includes("LIMIT $"));
  if (!call) throw new Error("crm-repo.test: no page query was issued");
  return call as [string, unknown[]];
};

/** The queue's count query — the unlimited total the operator is told. */
const queueCountCall = (): [string, unknown[]] => {
  const call = query.mock.calls.find(([sql]) => String(sql).includes("count(*) AS count"));
  if (!call) throw new Error("crm-repo.test: no count query was issued");
  return call as [string, unknown[]];
};

const CURSOR_TIMESTAMP = "2026-07-20T00:00:00.000Z";
const CURSOR_ID = "11111111-1111-1111-1111-111111111111";

/** A cursor pointing at the page AFTER the row it names — what a "Next"
 *  link carries. Built through the codec, not by hand, so these tests cannot
 *  quietly encode a shape the repo no longer accepts. */
const forwardCursor = () => encodeKeysetCursor(CURSOR_TIMESTAMP, CURSOR_ID, "after");

/** A cursor pointing at the page BEFORE the row it names — what a "Previous"
 *  link carries, anchored on the FIRST row of the page it was built from. */
const backwardCursor = () => encodeKeysetCursor(CURSOR_TIMESTAMP, CURSOR_ID, "before");

describe("the queue", () => {
  it("breaks an ordering tie on id, in both queues", async () => {
    // Without a tiebreak, rows sharing a sort timestamp come back in
    // whatever order the plan produces. That is harmless for a single
    // capped page and fatal for the keyset cursor: a row can repeat on one
    // page and never appear on another. Production's 259 rows were written
    // by one migration batch and share a narrow timestamp range, so ties
    // are the normal case here, not an edge one.
    query.mockResolvedValue([]);
    await dueOpportunities({}, 50);
    expect(queuePageCall()[0]).toContain("ORDER BY o.next_action_at ASC, o.id ASC");

    query.mockReset();
    query.mockResolvedValue([]);
    await driftingOpportunities({}, 14, 50);
    expect(queuePageCall()[0]).toContain(
      "ORDER BY COALESCE(o.last_contacted_at, o.created_at) ASC, o.id ASC",
    );
  });

  it("returns a paginated shape, not a bare array", async () => {
    // The defect: a bare capped array tells the operator nothing about what
    // it left behind. 259 drifting rows against a limit of 100 rendered as
    // 100 rows with no count and no truncation notice.
    query.mockReset();
    query.mockResolvedValue([]);
    const page = await dueOpportunities({}, 50);
    expect(page).toEqual({
      rows: [],
      total: 0,
      precedingCount: 0,
      nextCursor: null,
      previousCursor: null,
    });
  });

  it("counts the whole matching set in a query of its own, with no LIMIT", async () => {
    query.mockReset();
    query.mockImplementation(async (sql: string) =>
      String(sql).includes("count(*) AS count") ? [{ count: "259", preceding: "0" }] : [],
    );
    const page = await driftingOpportunities({ product: "mark8ly" }, 14, 100);
    const [countSql, countParams] = queueCountCall();
    // The unlimited count for this queue's own predicate AND its filters —
    // the number the operator is told, so it must not silently mean
    // "everything drifting" when a filter is active.
    expect(countSql).toContain("o.next_action_at IS NULL");
    expect(countSql).toContain("o.product = $1");
    expect(countSql).not.toContain("LIMIT");
    expect(countParams).toEqual(["mark8ly", 14]);
    expect(page.total).toBe(259);
  });

  it("asks for limit + 1 rows, so a next page is proven rather than inferred", async () => {
    query.mockReset();
    query.mockResolvedValue([]);
    await dueOpportunities({}, 50);
    expect(queuePageCall()[1]).toEqual([51]);
  });

  it("hands a backward page back in display order, not in the order it was fetched", async () => {
    // The re-reverse. A backward fetch runs `ORDER BY … DESC`, so the driver
    // returns the page's LAST row first. Returning that as-is renders the
    // page upside down with every count and cursor still correct — invisible
    // to any assertion over the SET of ids, which is why this asserts the
    // sequence.
    const row = (id: string, at: string) => ({
      id, organisation_id: "g1", organisation_name: "Bondi Baker",
      product: null, stage: "contacted", owner: null,
      next_action_at: new Date(at), next_action_note: null,
      last_contacted_at: null, quiet_since: new Date(at),
      is_starred: false,
    });
    query.mockReset();
    query.mockImplementation(async (sql: string) =>
      String(sql).includes("count(*) AS count")
        ? [{ count: "9", preceding: "6" }]
        : [
            // Nearest the anchor first: this is what SQL returns for a
            // backward fetch, plus the proof row at the far end.
            row("33333333-3333-3333-3333-333333333333", "2026-08-03T09:00:00Z"),
            row("22222222-2222-2222-2222-222222222222", "2026-08-02T09:00:00Z"),
            row("11111111-1111-1111-1111-111111111111", "2026-08-01T09:00:00Z"),
          ],
    );
    const page = await dueOpportunities({}, 2, backwardCursor());
    expect(page.rows.map((r) => r.id)).toEqual([
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
    ]);
    // Six rows sit before the anchor, two of them are on this page, so four
    // sort ahead of it.
    expect(page.precedingCount).toBe(4);
    // Paged backwards from somewhere, so there is always a page ahead.
    expect(page.nextCursor).not.toBeNull();
    expect(page.previousCursor).not.toBeNull();
  });

  it("drops the proof row from the page it hands back", async () => {
    const row = (id: string) => ({
      id, organisation_id: "g1", organisation_name: "Bondi Baker",
      product: null, stage: "contacted", owner: null,
      next_action_at: new Date("2026-08-01T09:00:00Z"), next_action_note: null,
      last_contacted_at: null, quiet_since: new Date("2026-07-20T00:00:00Z"),
      is_starred: false,
    });
    query.mockReset();
    query.mockImplementation(async (sql: string) =>
      String(sql).includes("count(*) AS count")
        ? [{ count: "3", preceding: "0" }]
        : [row("11111111-1111-1111-1111-111111111111"), row("22222222-2222-2222-2222-222222222222")],
    );
    const page = await dueOpportunities({}, 1);
    expect(page.rows.map((r) => r.id)).toEqual(["11111111-1111-1111-1111-111111111111"]);
    expect(page.nextCursor).not.toBeNull();
  });

  it("advances past the cursor with a keyset predicate on (sort key, id), in both queues", async () => {
    const cursor = forwardCursor();

    query.mockReset();
    query.mockResolvedValue([]);
    await dueOpportunities({}, 50, cursor);
    // Strictly greater than: the cursor is the last row of the previous
    // page, so including it would repeat that row.
    expect(queuePageCall()[0]).toContain("(o.next_action_at, o.id) > (");
    // …and the rows behind the page are counted inclusively, because the
    // cursor row itself has already been seen.
    expect(queueCountCall()[0]).toContain("count(*) FILTER (WHERE (o.next_action_at, o.id) <= (");

    query.mockReset();
    query.mockResolvedValue([]);
    await driftingOpportunities({}, 14, 50, cursor);
    expect(queuePageCall()[0]).toContain(
      "(COALESCE(o.last_contacted_at, o.created_at), o.id) > (",
    );
  });

  it("counts nothing as preceding when there is no cursor", async () => {
    query.mockReset();
    query.mockResolvedValue([]);
    await dueOpportunities({}, 50);
    expect(queueCountCall()[0]).not.toContain("FILTER");
  });

  it("rejects a malformed cursor rather than falling back to page one", async () => {
    // A silent fallback would show page one while the URL says otherwise —
    // the same "reports success, withholds the truth" defect as truncation.
    query.mockReset();
    query.mockResolvedValue([]);
    await expect(dueOpportunities({}, 50, "not-a-cursor")).rejects.toThrow();
    await expect(driftingOpportunities({}, 14, 50, "not-a-cursor")).rejects.toThrow();
    // Rejected before any query runs, so a bad cursor never costs a round
    // trip — and never reaches the database as a bound value.
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a cursor carrying a non-uuid id or an unparseable timestamp", async () => {
    query.mockReset();
    query.mockResolvedValue([]);
    const forge = (payload: string) => Buffer.from(payload, "utf-8").toString("base64");
    await expect(
      dueOpportunities({}, 50, forge("after|2026-07-20T00:00:00.000Z|1 OR 1=1")),
    ).rejects.toThrow();
    await expect(
      dueOpportunities({}, 50, forge("after|not-a-date|11111111-1111-1111-1111-111111111111")),
    ).rejects.toThrow();
    await expect(
      dueOpportunities({}, 50, forge("no-separator-at-all")),
    ).rejects.toThrow();
    // A cursor from before the direction existed. Rejected rather than read
    // as "after": a link built to page one way must never silently page the
    // other.
    await expect(
      dueOpportunities({}, 50, forge(`${CURSOR_TIMESTAMP}|${CURSOR_ID}`)),
    ).rejects.toThrow();
  });

  it("flips the comparison and the ORDER BY for a backward cursor, in both queues", async () => {
    query.mockReset();
    query.mockResolvedValue([]);
    await dueOpportunities({}, 50, backwardCursor());
    const [sql] = queuePageCall();
    // Strictly less than: the cursor is the FIRST row of the page being left,
    // which stays on that page.
    expect(sql).toContain("(o.next_action_at, o.id) < (");
    // …and the fetch runs against the queue's display order, so the page
    // adjacent to the anchor is the one the LIMIT keeps.
    expect(sql).toContain("ORDER BY o.next_action_at DESC, o.id DESC");

    query.mockReset();
    query.mockResolvedValue([]);
    await driftingOpportunities({}, 14, 50, backwardCursor());
    const [driftSql] = queuePageCall();
    expect(driftSql).toContain("(COALESCE(o.last_contacted_at, o.created_at), o.id) < (");
    expect(driftSql).toContain(
      "ORDER BY COALESCE(o.last_contacted_at, o.created_at) DESC, o.id DESC",
    );
  });

  it("counts rows before a backward anchor exclusively, since the anchor is not on this page", async () => {
    // Forward, the anchor IS the last row of the previous page and counts as
    // preceding (`<=`). Backward, it is the first row of the page being left
    // — it sorts AFTER this page, so counting it would push the range one
    // row along.
    query.mockReset();
    query.mockResolvedValue([]);
    await dueOpportunities({}, 50, backwardCursor());
    expect(queueCountCall()[0]).toContain("count(*) FILTER (WHERE (o.next_action_at, o.id) < (");
  });

  it("asks only for opportunities whose next action has arrived", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({}, 50);
    const [sql] = queuePageCall();
    expect(sql).toContain("next_action_at <= now()");
    // Terminal deals are done; surfacing them would make the queue a to-do
    // list of things already finished.
    expect(sql).toContain("stage NOT IN ('won', 'lost')");
  });

  it("treats drifting as no next action AND stale contact, not either", async () => {
    query.mockResolvedValue([]);
    await driftingOpportunities({}, 14, 50);
    const [sql] = queuePageCall();
    expect(sql).toContain("next_action_at IS NULL");
    expect(sql).toContain("last_contacted_at");
    // Guards the guard: an OR here would surface every scheduled lead as
    // drifting the moment it went quiet, which is the opposite of the point.
    expect(sql).not.toMatch(/next_action_at IS NULL\s+OR/i);
  });

  it("measures staleness from last contact, or from creation if never contacted", async () => {
    query.mockResolvedValue([]);
    await driftingOpportunities({}, 14, 50);
    const [sql] = queuePageCall();
    // NULL last_contacted_at means "never contacted", not "contacted at the
    // dawn of time". Without COALESCE(..., created_at), every freshly
    // imported lead (no next action, no contact yet) would be instantly
    // drifting, flooding the queue the moment an import finishes. A
    // never-contacted lead gets the same 14-day grace period, counted from
    // when it entered the system — not zero days.
    expect(sql).toContain("COALESCE(o.last_contacted_at, o.created_at)");
    // NULLS FIRST would float every never-contacted lead to the top
    // regardless of how recently it was created — the exact bug the
    // COALESCE fixes. It must not appear on the ordering.
    expect(sql).not.toMatch(/NULLS FIRST/i);
  });

  it("passes staleDays as a bind parameter used against the COALESCE, not last_contacted_at alone", async () => {
    // Pins the specific regression: comparing staleDays against bare
    // last_contacted_at would make every never-contacted row (NULL)
    // satisfy `NULL <= now() - interval` as unknown/false in SQL terms
    // inconsistently, OR (with the old explicit "IS NULL OR" clause) make
    // it unconditionally true — either way decoupled from staleDays. The
    // fix binds staleDays against a comparison that is well-defined for
    // every row: COALESCE(last_contacted_at, created_at). A freshly
    // created row (created_at = now()) fails `<= now() - 14 days`; a
    // long-untouched one (created_at long ago) passes it. Both flow
    // through the same single comparison, so this is what must not
    // regress back to a bare-column or unconditional check.
    //
    // make_interval(days => $1::int) over ($1 || ' days')::interval: typed,
    // rejects garbage at parse time rather than at the database.
    query.mockResolvedValue([]);
    await driftingOpportunities({}, 14, 50);
    const [sql, params] = queuePageCall();
    expect(params).toEqual([14, 51]);
    expect(sql).toMatch(
      /COALESCE\(o\.last_contacted_at, o\.created_at\)\s*\n?\s*<= now\(\) - make_interval\(days => \$1::int\)/,
    );
  });

  it("normalises timestamps to ISO strings", async () => {
    query.mockResolvedValue([{
      id: "o1", organisation_id: "g1", organisation_name: "Bondi Baker",
      product: null, stage: "contacted", owner: "ava@tesserix.app",
      next_action_at: new Date("2026-08-01T09:00:00Z"), next_action_note: "call back",
      last_contacted_at: null,
      quiet_since: new Date("2026-07-20T00:00:00Z"),
      is_starred: false,
    }]);
    const { rows } = await dueOpportunities({}, 50);
    const [row] = rows;
    expect(row.nextActionAt).toBe("2026-08-01T09:00:00.000Z");
    expect(row.lastContactedAt).toBeNull();
    expect(row.quietSince).toBe("2026-07-20T00:00:00.000Z");
  });

  it("selects quiet_since (COALESCE) as its own column, not last_contacted_at alone", async () => {
    // Ruling 10: exposing raw created_at would let a consumer recompute the
    // COALESCE in TypeScript, putting the business rule in two places that
    // can disagree. The SQL must alias the COALESCE itself as quiet_since,
    // for both queries, so the rule stays in one place.
    query.mockReset();
    query.mockResolvedValue([]);
    await dueOpportunities({}, 50);
    const [dueSql] = queuePageCall();
    expect(dueSql).toContain(
      "COALESCE(o.last_contacted_at, o.created_at) AS quiet_since",
    );

    query.mockReset();
    query.mockResolvedValue([]);
    await driftingOpportunities({}, 14, 50);
    const [driftingSql] = queuePageCall();
    expect(driftingSql).toContain(
      "COALESCE(o.last_contacted_at, o.created_at) AS quiet_since",
    );
  });

  it("matches NULL product for the unassigned sentinel, not equality", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ product: UNASSIGNED_PRODUCT }, 50);
    const [sql, params] = queuePageCall();
    expect(sql).toContain("o.product IS NULL");
    expect(sql).not.toMatch(/o\.product\s*=/);
    // The sentinel must never reach the database as a value — a product
    // literally named "__unassigned__" is not what the operator asked for.
    expect(params).not.toContain(UNASSIGNED_PRODUCT);
    expect(params).toEqual([51]);
  });

  it("still uses equality for a real product", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ product: "mark8ly" }, 50);
    const [sql, params] = queuePageCall();
    expect(sql).toMatch(/o\.product\s*=/);
    expect(params).toContain("mark8ly");
  });
});

describe("the queue's filters — bound parameters, not string interpolation", () => {
  it("adds no clause and no extra param when no filter is active", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({}, 50);
    const [sql, params] = queuePageCall();
    // `o.owner` legitimately appears in the SELECT list; only the WHERE-clause
    // forms (`o.product =`, `o.owner ILIKE`) indicate an active filter.
    expect(sql).not.toMatch(/o\.product\s*=/);
    expect(sql).not.toMatch(/o\.owner ILIKE/);
    expect(params).toEqual([51]);
  });

  it("binds product as a parameter, not interpolated into the SQL text", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ product: "mark8ly" }, 50);
    const [sql, params] = queuePageCall();
    expect(sql).toContain("o.product = $1");
    expect(sql).not.toContain("mark8ly");
    expect(params).toEqual(["mark8ly", 51]);
  });

  it("binds stage as a parameter", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ stage: "qualified" }, 50);
    const [sql, params] = queuePageCall();
    expect(sql).toContain("o.stage = $1");
    expect(sql).not.toContain("'qualified'");
    expect(params).toEqual(["qualified", 51]);
  });

  it("binds owner as a parameter, matched case-insensitively", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ owner: "Asha" }, 50);
    const [sql, params] = queuePageCall();
    expect(sql).toContain("o.owner ILIKE $1");
    expect(sql).toContain("ESCAPE '\\'");
    expect(sql).not.toContain("Asha");
    expect(params).toEqual(["%Asha%", 51]);
  });

  it("escapes LIKE metacharacters in the owner value rather than passing them through as wildcards", async () => {
    // Bound parameter, so this was never SQL injection — but an unescaped
    // "%" or "_" in the value acts as a LIKE wildcard rather than a literal
    // character, which is a silently wrong filter (an owner of exactly "%"
    // would match every row with a non-null owner). Only the value's own
    // `%`/`_`/`\` are escaped; the wrapping `%...%` that makes this a
    // substring search stays literal wildcards.
    query.mockResolvedValue([]);
    await dueOpportunities({ owner: "100%_done\\now" }, 50);
    const [, params] = queuePageCall();
    expect(params).toEqual(["%100\\%\\_done\\\\now%", 51]);
  });

  it("combines all three filters, each its own bound parameter, before ORDER BY/LIMIT", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ product: "mark8ly", stage: "qualified", owner: "Asha" }, 50);
    const [sql, params] = queuePageCall();
    expect(sql).toContain("o.product = $1");
    expect(sql).toContain("o.stage = $2");
    expect(sql).toContain("o.owner ILIKE $3");
    expect(sql.indexOf("o.owner ILIKE")).toBeLessThan(sql.indexOf("ORDER BY"));
    expect(params).toEqual(["mark8ly", "qualified", "%Asha%", 51]);
  });

  it("keeps the due predicate first so the partial index stays usable", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ product: "mark8ly" }, 50);
    const [sql] = queuePageCall();
    expect(sql.indexOf("next_action_at <= now()")).toBeLessThan(sql.indexOf("o.product ="));
  });

  it("binds product, stage, owner and staleDays as separate parameters on the drifting query", async () => {
    query.mockResolvedValue([]);
    await driftingOpportunities({ product: "mark8ly", stage: "new", owner: "Asha" }, 14, 50);
    const [sql, params] = queuePageCall();
    expect(sql).toContain("o.product = $1");
    expect(sql).toContain("o.stage = $2");
    expect(sql).toContain("o.owner ILIKE $3");
    expect(sql).toContain("make_interval(days => $4::int)");
    expect(sql).toContain("LIMIT $5");
    expect(params).toEqual(["mark8ly", "new", "%Asha%", 14, 51]);
  });

  it("keeps the drifting partial-index predicates first, filters appended after", async () => {
    query.mockResolvedValue([]);
    // `country` is included alongside `product`: the splice now carries four
    // filter clauses (product/stage/owner, and country/followers below), all
    // through the same `filterClause` — one assertion per clause pins that
    // none of them was spliced ahead of the partial-index predicates.
    await driftingOpportunities({ product: "mark8ly", country: "IN" }, 14, 50);
    const [sql] = queuePageCall();
    expect(sql.indexOf("next_action_at IS NULL")).toBeLessThan(sql.indexOf("o.product ="));
    expect(sql.indexOf("stage NOT IN")).toBeLessThan(sql.indexOf("o.product ="));
    expect(sql.indexOf("next_action_at IS NULL")).toBeLessThan(sql.indexOf("g.country ="));
    expect(sql.indexOf("stage NOT IN")).toBeLessThan(sql.indexOf("g.country ="));
  });

  it("binds country as an exact-match parameter against the organisation, not the raw location", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ country: "IN" }, 50);
    const [sql, params] = queuePageCall();
    expect(sql).toContain("g.country = $1");
    expect(sql).not.toContain("location");
    expect(params).toEqual(["IN", 51]);
  });

  it("binds the follower band's bounds as parameters, excluding a NULL followers_count explicitly", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ followers: "k1to10k" }, 50);
    const [sql, params] = queuePageCall();
    expect(sql).toContain("c.followers_count IS NOT NULL");
    expect(sql).toContain("c.followers_count >= $1");
    expect(sql).toContain("c.followers_count <= $2");
    expect(params).toEqual([1000, 9999, 51]);
  });

  it("resolves the follower band against the primary contact, same ordering the row displays", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ followers: "over10k" }, 50);
    const [sql] = queuePageCall();
    expect(sql).toContain("is_primary DESC");
    expect(sql).toContain("c.organisation_id = g.id");
  });

  it("omits the upper bound for the open-ended top band", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ followers: "over10k" }, 50);
    const [sql, params] = queuePageCall();
    expect(sql).not.toContain("c.followers_count <=");
    expect(params).toEqual([10000, 51]);
  });

  it("combines country and followers with product/stage/owner, each its own bound parameter", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities(
      { product: "mark8ly", stage: "qualified", owner: "Asha", country: "IN", followers: "over10k" },
      50,
    );
    const [sql, params] = queuePageCall();
    expect(sql).toContain("o.product = $1");
    expect(sql).toContain("o.stage = $2");
    expect(sql).toContain("o.owner ILIKE $3");
    expect(sql).toContain("g.country = $4");
    expect(sql).toContain("c.followers_count >= $5");
    expect(params).toEqual(["mark8ly", "qualified", "%Asha%", "IN", 10000, 51]);
  });

  it("matches a NULL country for the unknown sentinel, not equality", async () => {
    // 208 of 259 production organisations have no derived country. Without
    // this branch every country option excludes them and nothing on the
    // surface says so.
    query.mockResolvedValue([]);
    await dueOpportunities({ country: UNKNOWN_COUNTRY }, 50);
    const [sql, params] = queuePageCall();
    expect(sql).toContain("g.country IS NULL");
    expect(sql).not.toMatch(/g\.country\s*=/);
    // The sentinel must never reach the database as a value — a country
    // literally named "__unknown__" is not what the operator asked for.
    expect(params).not.toContain(UNKNOWN_COUNTRY);
    expect(params).toEqual([51]);
  });

  it("matches a primary contact with no follower count for the unknown sentinel", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ followers: UNKNOWN_FOLLOWERS }, 50);
    const [sql, params] = queuePageCall();
    // NOT EXISTS over the primary contact with a count — the exact
    // complement of the numeric bands, so no organisation falls between the
    // two and stays unreachable.
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("c.followers_count IS NOT NULL");
    expect(sql).not.toContain("c.followers_count >=");
    expect(sql).not.toContain("c.followers_count <=");
    expect(params).not.toContain(UNKNOWN_FOLLOWERS);
    expect(params).toEqual([51]);
  });

  it("resolves the unknown follower sentinel against the primary contact only", async () => {
    // Same scoping as the numeric bands: a secondary contact's follower
    // count must not make the row's follower state "known", or "Unknown"
    // and the bands would disagree about which contact they describe.
    query.mockResolvedValue([]);
    await dueOpportunities({ followers: UNKNOWN_FOLLOWERS }, 50);
    const [sql] = queuePageCall();
    expect(sql).toContain("is_primary DESC");
    expect(sql).toContain("c.organisation_id = g.id");
  });

  it("binds the unknown sentinels on the drifting query the same way", async () => {
    query.mockResolvedValue([]);
    await driftingOpportunities({ country: UNKNOWN_COUNTRY, followers: UNKNOWN_FOLLOWERS }, 14, 50);
    const [sql, params] = queuePageCall();
    expect(sql).toContain("g.country IS NULL");
    expect(sql).toContain("NOT EXISTS");
    expect(params).toEqual([14, 51]);
  });

  it("binds country and followers on the drifting query the same way", async () => {
    query.mockResolvedValue([]);
    await driftingOpportunities({ country: "IN", followers: "under1k" }, 14, 50);
    const [sql, params] = queuePageCall();
    expect(sql).toContain("g.country = $1");
    expect(sql).toContain("c.followers_count >= $2");
    expect(sql).toContain("c.followers_count <= $3");
    expect(sql).toContain("make_interval(days => $4::int)");
    expect(params).toEqual(["IN", 0, 999, 14, 51]);
  });
});

describe("advanceStage", () => {
  // Load-bearing: this is the ONLY record of when a stage was entered, and
  // therefore the only thing that makes funnel measurement possible later.
  // It cannot be reconstructed afterwards.
  it("writes a stage_change activity on every transition", async () => {
    query.mockResolvedValueOnce([
      { stage: "contacted", organisation_id: "g1", product: null },
    ]);
    const result = await advanceStage({
      opportunityId: "o1",
      to: "qualified",
      product: "mark8ly",
      actor: "ava",
    });
    const sqlText = query.mock.calls.map(([sql]) => sql).join("\n");
    expect(sqlText).toContain("INSERT INTO crm_activities");
    expect(sqlText).toContain("stage_change");
    expect(result).toEqual({ stageChanged: true, productChanged: true });
  });

  it("refuses to qualify without a product rather than guessing one", async () => {
    // No DB call happens at all — the guard runs before anything is read,
    // and any real row (grandfathered or not) is off the table either way.
    await expect(
      advanceStage({ opportunityId: "o1", to: "qualified", actor: "ava" }),
    ).rejects.toThrow(/product/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses to mark an opportunity lost without a reason", async () => {
    await expect(
      advanceStage({ opportunityId: "o1", to: "lost", product: "mark8ly", actor: "ava" }),
    ).rejects.toThrow(/reason/i);
    expect(query).not.toHaveBeenCalled();
  });

  // Guards the guard: a version that logged unconditionally would pass the
  // first test while filling the timeline with noise.
  it("does not write a stage_change when the stage is unchanged", async () => {
    query.mockResolvedValueOnce([
      { stage: "contacted", organisation_id: "g1", product: null },
    ]);
    const result = await advanceStage({ opportunityId: "o1", to: "contacted", actor: "ava" });
    const sqlText = query.mock.calls.map(([sql]) => sql).join("\n");
    expect(sqlText).not.toContain("stage_change");
    expect(sqlText).not.toMatch(/UPDATE crm_opportunities/);
    expect(result).toEqual({ stageChanged: false, productChanged: false });
  });

  it("sets closed_at when moving to won", async () => {
    query.mockResolvedValueOnce([
      { stage: "qualified", organisation_id: "g1", product: "mark8ly" },
    ]);
    await advanceStage({ opportunityId: "o1", to: "won", product: "mark8ly", actor: "ava" });
    const [updateSql] = query.mock.calls[1];
    expect(updateSql).toContain("closed_at = now()");
  });

  it("sets closed_at and lost_reason when moving to lost", async () => {
    query.mockResolvedValueOnce([
      { stage: "qualified", organisation_id: "g1", product: "mark8ly" },
    ]);
    await advanceStage({
      opportunityId: "o1",
      to: "lost",
      product: "mark8ly",
      lostReason: "went with a competitor",
      actor: "ava",
    });
    const [updateSql, updateParams] = query.mock.calls[1];
    expect(updateSql).toContain("closed_at = now()");
    expect(updateSql).toContain("lost_reason");
    expect(updateParams).toContain("went with a competitor");
  });

  // Ruling 14: leaving a terminal stage clears both fields — they describe
  // the stage being left, not baggage that survives a correction. Not
  // rejected: mis-marking a deal lost is ordinary human error, and this is
  // the fix for it, recorded honestly via the ordinary stage_change path.
  it("clears closed_at and lost_reason when leaving a terminal stage (Ruling 14)", async () => {
    query.mockResolvedValueOnce([
      { stage: "lost", organisation_id: "g1", product: "mark8ly" },
    ]);
    await advanceStage({
      opportunityId: "o1",
      to: "qualified",
      product: "mark8ly",
      actor: "ava",
    });
    const [updateSql, updateParams] = query.mock.calls[1];
    expect(updateSql).toContain("closed_at = NULL");
    expect(updateSql).toContain("lost_reason = $3");
    // Pinned by position, not `toContain(null)`: `updateParams` is
    // `[opportunityId, to, lostReason]` here (product is unchanged, so no
    // fourth param is pushed) — `toContain(null)` would pass just as well
    // if some OTHER parameter happened to be null, which proves nothing
    // about lost_reason specifically.
    expect(updateParams).toEqual(["o1", "qualified", null]);
  });

  it("moving lost -> won clears lost_reason but still sets closed_at", async () => {
    query.mockResolvedValueOnce([
      { stage: "lost", organisation_id: "g1", product: "mark8ly" },
    ]);
    await advanceStage({
      opportunityId: "o1",
      to: "won",
      product: "mark8ly",
      actor: "ava",
    });
    const [updateSql, updateParams] = query.mock.calls[1];
    expect(updateSql).toContain("closed_at = now()");
    // Pinned by position (see the comment above): params are
    // `[opportunityId, to, lostReason]`, and lost_reason — index 2 — is the
    // one that must be null, not merely "some param is null".
    expect(updateParams).toEqual(["o1", "won", null]);
  });

  it("always sets updated_at, since crm_opportunities has no update trigger", async () => {
    query.mockResolvedValueOnce([
      { stage: "contacted", organisation_id: "g1", product: null },
    ]);
    await advanceStage({ opportunityId: "o1", to: "qualified", product: "mark8ly", actor: "ava" });
    const [updateSql] = query.mock.calls[1];
    expect(updateSql).toContain("updated_at = now()");
  });

  // The grandfathered-row constraint (migration 0021): a row already sitting
  // at qualified/won/lost with a null product is rewritten by ANY update,
  // including a same-stage one that only supplies the missing product. This
  // is how such a row gets unblocked — not a special case, just the ordinary
  // "product changed" path with no stage transition attached.
  it("lets a same-stage write through when it supplies the missing product, but logs no stage_change", async () => {
    query.mockResolvedValueOnce([
      { stage: "qualified", organisation_id: "g1", product: null },
    ]);
    const result = await advanceStage({
      opportunityId: "o1",
      to: "qualified",
      product: "mark8ly",
      actor: "ava",
    });
    const sqlText = query.mock.calls.map(([sql]) => sql).join("\n");
    expect(sqlText).toMatch(/UPDATE crm_opportunities/);
    expect(sqlText).not.toContain("stage_change");
    expect(result).toEqual({ stageChanged: false, productChanged: true });
  });

  // A product re-pointed underneath a live deal, with the stage untouched,
  // must still leave a trace — the whole reason this branch exists (an
  // audit row alone can't be read by anyone browsing the organisation's
  // timeline).
  it("logs an activity for a stage-unchanged product change, not tagged stage_change", async () => {
    query.mockResolvedValueOnce([
      { stage: "qualified", organisation_id: "g1", product: "kora" },
    ]);
    await advanceStage({
      opportunityId: "o1",
      to: "qualified",
      product: "mark8ly",
      actor: "ava",
    });
    const [activitySql, activityParams] = query.mock.calls[2];
    expect(activitySql).toContain("INSERT INTO crm_activities");
    expect(activitySql).toContain("'note'");
    expect(activitySql).not.toContain("stage_change");
    expect(activityParams).toContain("Product set to mark8ly (was kora)");
  });

  it("throws when the opportunity does not exist", async () => {
    query.mockResolvedValueOnce([]);
    await expect(
      advanceStage({ opportunityId: "missing", to: "contacted", actor: "ava" }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("setNextAction", () => {
  it("schedules a next action", async () => {
    query.mockResolvedValueOnce([
      { stage: "contacted", product: null },
    ]);
    await setNextAction({
      opportunityId: "o1",
      at: "2026-08-20T09:00:00.000Z",
      note: "call back",
      actor: "ava",
    });
    const [updateSql, updateParams] = query.mock.calls[1];
    expect(updateSql).toContain("next_action_at");
    expect(updateSql).toContain("updated_at = now()");
    expect(updateParams).toContain("2026-08-20T09:00:00.000Z");
  });

  // The grandfathered-row constraint again: `setNextAction` has no product
  // argument to offer, so a row that needs one and doesn't have one is
  // refused outright — a clear, typed error, not a raw constraint violation
  // from Postgres reaching the operator.
  it("refuses to touch a grandfathered row instead of letting Postgres reject the UPDATE", async () => {
    query.mockResolvedValueOnce([
      { stage: "qualified", product: null },
    ]);
    await expect(
      setNextAction({ opportunityId: "o1", at: null, note: null, actor: "ava" }),
    ).rejects.toBeInstanceOf(MissingProductError);
    // Only the SELECT ran; the UPDATE that would trip the CHECK never did.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("allows a grandfathered row once it already carries a product", async () => {
    query.mockResolvedValueOnce([
      { stage: "won", product: "mark8ly" },
    ]);
    await setNextAction({ opportunityId: "o1", at: null, note: null, actor: "ava" });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("logActivity", () => {
  it("inserts a note without touching crm_opportunities", async () => {
    query.mockResolvedValueOnce([]);
    await logActivity({
      organisationId: "g1",
      opportunityId: "o1",
      kind: "note",
      actor: "ava",
      body: "left a voicemail",
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO crm_activities");
    expect(params).toContain("left a voicemail");
  });

  it("allows a note with no opportunity yet", async () => {
    query.mockResolvedValueOnce([]);
    await logActivity({ organisationId: "g1", kind: "note", actor: "ava", body: "first contact" });
    const [, params] = query.mock.calls[0];
    expect(params).toContain(null);
  });

  // The drift clock. Before this, `last_contacted_at` was written by nothing
  // in the application, so logging a DM left the queue still reporting the
  // organisation as quiet since whenever the backfill said.
  it("moves last_contacted_at for a real contact, in the same transaction", async () => {
    query.mockResolvedValue([]); // no suppressions, insert, update
    await logActivity({
      organisationId: "g1",
      opportunityId: "o1",
      kind: "dm_sent",
      actor: "ava",
      body: "sent a DM",
    });

    const statements = query.mock.calls.map(([sql]) => sql as string);
    const update = statements.find((sql) => sql.includes("UPDATE crm_opportunities"));
    expect(update).toBeDefined();
    expect(update).toContain("last_contacted_at = now()");
    // No triggers on these tables — updated_at has to be set by hand.
    expect(update).toContain("updated_at = now()");
  });

  it("does not move last_contacted_at for a note, a stage change or an assignment", async () => {
    for (const kind of ["note", "stage_change", "assigned"] as const) {
      query.mockReset();
      query.mockResolvedValue([]);
      await logActivity({ organisationId: "g1", opportunityId: "o1", kind, actor: "ava" });
      const statements = query.mock.calls.map(([sql]) => sql as string);
      expect(statements.some((sql) => sql.includes("UPDATE crm_opportunities"))).toBe(false);
    }
  });

  // design.md:224 — the list is checked at import AND when logging outreach.
  it("refuses outbound outreach to a suppressed organisation", async () => {
    query
      .mockResolvedValueOnce([{ email: "ava@example.com", instagram_handle: null }]) // contacts
      .mockResolvedValueOnce([{ id: "s1" }]); // isSuppressed hit

    await expect(
      logActivity({ organisationId: "g1", opportunityId: "o1", kind: "email_sent", actor: "ava" }),
    ).rejects.toBeInstanceOf(SuppressedContactError);

    const statements = query.mock.calls.map(([sql]) => sql as string);
    expect(statements.some((sql) => sql.includes("INSERT INTO crm_activities"))).toBe(false);
  });

  // Refusing to record an inbound message from a suppressed person would
  // destroy the record of the very contact that most needs one.
  it("still records an inbound message from a suppressed person", async () => {
    query.mockResolvedValue([]);
    await logActivity({
      organisationId: "g1",
      opportunityId: "o1",
      kind: "dm_received",
      actor: "ava",
    });
    const statements = query.mock.calls.map(([sql]) => sql as string);
    expect(statements.some((sql) => sql.includes("crm_suppressions"))).toBe(false);
    expect(statements.some((sql) => sql.includes("INSERT INTO crm_activities"))).toBe(true);
  });

  // #245. A contact event that names no deal is still contact with the
  // business, so it moves the clock on every deal still in play. The SQL
  // shape is asserted here; that the predicate selects the right rows is
  // proved against a real database in crm-activity-clock.integration.test.ts.
  it("advances every open opportunity when the contact names no deal", async () => {
    query.mockResolvedValue([]);
    await logActivity({ organisationId: "g1", kind: "call", actor: "ava" });

    const statements = query.mock.calls.map(([sql]) => sql as string);
    const update = statements.find((sql) => sql.includes("UPDATE crm_opportunities"));
    expect(update).toBeDefined();
    expect(update).toContain("last_contacted_at = now()");
    expect(update).toContain("updated_at = now()");
    expect(update).toContain("organisation_id = $1");
    // Terminal deals are done being worked; a clock they no longer answer to
    // must not move.
    expect(update).toContain("stage NOT IN ('won', 'lost')");
    const updateCall = query.mock.calls.find(([sql]) =>
      (sql as string).includes("UPDATE crm_opportunities"),
    );
    expect(updateCall?.[1]).toEqual(["g1"]);
  });

  it("advances nothing for an organisation-level note", async () => {
    query.mockResolvedValue([]);
    await logActivity({ organisationId: "g1", kind: "note", actor: "ava", body: "a thought" });
    const statements = query.mock.calls.map(([sql]) => sql as string);
    expect(statements.some((sql) => sql.includes("UPDATE crm_opportunities"))).toBe(false);
  });

  // The organisation-level bump must not take the activity row down with it
  // when migration 0021's CHECK would reject one of the deals it touches.
  it("skips deals the product CHECK would reject, rather than failing the log", async () => {
    query.mockResolvedValue([]);
    await logActivity({ organisationId: "g1", kind: "call", actor: "ava" });
    const statements = query.mock.calls.map(([sql]) => sql as string);
    const update = statements.find((sql) => sql.includes("UPDATE crm_opportunities"));
    expect(update).toContain("product IS NOT NULL");
  });
});

describe("organisationDetail", () => {
  /**
   * Drive `organisationDetail` with `count` activity rows and nothing else.
   *
   * The four reads are issued in a fixed order (organisation, contacts,
   * opportunities, activities), so `query.mock.calls[3]` is the activity
   * query and the mocks can be queued positionally.
   */
  async function detailWithActivities(count: number) {
    query
      .mockResolvedValueOnce([
        {
          id: "g1",
          name: "Bondi Baker",
          website_url: null,
          location: null,
          country: null,
          category: [],
          tags: [],
          converted_product: null,
          converted_label: null,
          converted_at: null,
          created_at: new Date("2026-01-01T00:00:00Z"),
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(
        Array.from({ length: count }, (_unused, i) => ({
          id: `a${i}`,
          opportunity_id: null,
          kind: "note",
          actor: "ava",
          body: null,
          occurred_at: new Date("2026-08-01T09:00:00Z"),
        })),
      );
    return organisationDetail("g1");
  }

  it("returns null for an organisation that does not exist, without reading the rest", async () => {
    query.mockResolvedValueOnce([]);
    const detail = await organisationDetail("missing");
    expect(detail).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("assembles the organisation, its contacts, opportunities and activities", async () => {
    query
      .mockResolvedValueOnce([
        {
          id: "g1",
          name: "Bondi Baker",
          website_url: "https://bondibaker.example",
          location: "Bondi",
          category: ["bakery"],
          tags: ["warm"],
          converted_product: null,
          converted_label: null,
          converted_at: null,
          created_at: new Date("2026-01-01T00:00:00Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "c1",
          name: "Priya",
          email: "priya@bondibaker.example",
          phone: null,
          instagram_handle: "@bondibaker",
          is_primary: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "o1",
          product: "mark8ly",
          stage: "qualified",
          owner: "ava@tesserix.app",
          next_action_at: null,
          next_action_note: null,
          last_contacted_at: new Date("2026-08-01T00:00:00Z"),
          is_starred: false,
          closed_at: null,
          lost_reason: null,
          created_at: new Date("2026-01-05T00:00:00Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "a1",
          opportunity_id: "o1",
          kind: "note",
          actor: "ava",
          body: "left a voicemail",
          occurred_at: new Date("2026-08-01T09:00:00Z"),
        },
      ]);

    const detail = await organisationDetail("g1");

    expect(detail?.organisation.name).toBe("Bondi Baker");
    expect(detail?.contacts).toHaveLength(1);
    expect(detail?.contacts[0].isPrimary).toBe(true);
    expect(detail?.opportunities).toHaveLength(1);
    expect(detail?.opportunities[0].stage).toBe("qualified");
    expect(detail?.activities).toHaveLength(1);
    expect(detail?.activities[0].kind).toBe("note");
    // Timestamps normalised to ISO strings, same contract as the queue rows.
    expect(detail?.organisation.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(detail?.activities[0].occurredAt).toBe("2026-08-01T09:00:00.000Z");
  });

  // The activity cap used to be silent: a timeline longer than it ended at
  // row 200 with nothing on screen to say so, and an operator who scrolled to
  // the bottom had no way to tell that from the actual bottom. Same probe-row
  // shape as `wonWithoutConversion` (#246), for the same reason: one query,
  // no second COUNT.
  it("asks for one activity past the cap, and reports the overflow without returning it", async () => {
    const detail = await detailWithActivities(ACTIVITY_LIMIT + 1);

    const [, params] = query.mock.calls[3];
    expect(params, "the probe row is what makes hasMoreActivities knowable").toEqual([
      "g1",
      ACTIVITY_LIMIT + 1,
    ]);
    expect(detail?.activities).toHaveLength(ACTIVITY_LIMIT);
    expect(detail?.hasMoreActivities).toBe(true);
  });

  // The boundary: a timeline of exactly the cap has nothing past it.
  // Inferring from `activities.length === cap` would claim otherwise here,
  // which is the whole reason the probe row is fetched.
  it("reports no overflow when the timeline ends exactly at the cap", async () => {
    const detail = await detailWithActivities(ACTIVITY_LIMIT);

    expect(detail?.activities).toHaveLength(ACTIVITY_LIMIT);
    expect(detail?.hasMoreActivities).toBe(false);
  });

  // `crm_activities.occurred_at` carries no uniqueness guarantee — it is a
  // plain `timestamptz DEFAULT now()`, and the seed and backfill paths write
  // explicit values — so without a total order two rows sharing it are cut
  // arbitrarily by the LIMIT. Now that the cut decides which row is DROPPED
  // and not merely where it sits, an arbitrary tiebreak means two loads of
  // the same page can disagree about what the timeline contains.
  it("breaks an occurred_at tie by id, so the cap cuts the same row every time", async () => {
    await detailWithActivities(1);

    const [sql] = query.mock.calls[3];
    expect(sql).toContain("ORDER BY occurred_at DESC, id DESC");
  });

  it("scopes contacts, opportunities and activities to the organisation", async () => {
    query.mockResolvedValueOnce([
      {
        id: "g1",
        name: "Bondi Baker",
        website_url: null,
        location: null,
        category: [],
        tags: [],
        converted_product: null,
        converted_label: null,
        converted_at: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    query.mockResolvedValue([]);
    await organisationDetail("g1");
    const calledSql = query.mock.calls.slice(1).map(([sql]) => sql as string);
    expect(calledSql.some((sql) => sql.includes("FROM crm_contacts") && sql.includes("organisation_id = $1"))).toBe(true);
    expect(calledSql.some((sql) => sql.includes("FROM crm_opportunities") && sql.includes("organisation_id = $1"))).toBe(true);
    expect(calledSql.some((sql) => sql.includes("FROM crm_activities") && sql.includes("organisation_id = $1"))).toBe(true);
  });
});

describe("suppressions", () => {
  // The whole point of the list: the partial UNIQUE indexes
  // (crm_suppressions_email_uq, crm_suppressions_ig_uq) are on `lower(...)`,
  // so a lookup that compares the raw value would miss a match that differs
  // only in case — and then collide on the very next insert.
  it("matches a suppression case-insensitively on either key", async () => {
    query.mockResolvedValue([{ id: "s1" }]);
    expect(await isSuppressed({ email: "Ava@Example.com" })).toBe(true);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("lower(");
  });

  // Fix round 3: `addSuppression` and migration 0022's trigger both trim the
  // stored email, so an untrimmed lookup that still passed the raw value
  // through would miss a real match on nothing but whitespace — exactly
  // what a CSV cell (Task 8's import) carries as a matter of course.
  it("trims whitespace from an email lookup before comparing", async () => {
    query.mockResolvedValue([{ id: "s1" }]);
    expect(await isSuppressed({ email: "  ava@example.com  " })).toBe(true);
    const [, params] = query.mock.calls[0];
    expect(params).toContain("ava@example.com");
    expect(params).not.toContain("  ava@example.com  ");
  });

  it("matches on instagram_handle too, case-insensitively", async () => {
    query.mockResolvedValue([{ id: "s1" }]);
    expect(await isSuppressed({ instagramHandle: "Bondi_Baker" })).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("lower(instagram_handle)");
    // Normalized (Ruling 18): lowercased before it ever reaches SQL, not
    // passed through raw and left to `lower()` alone.
    expect(params).toContain("bondi_baker");
    expect(params).not.toContain("Bondi_Baker");
  });

  // Ruling 18: a handle can arrive with or without a leading `@` depending on
  // where it came from. `lower()` does not bridge that — only stripping the
  // `@` at the boundary does, on both the write and the read side (the next
  // two tests pin both directions).
  it("strips a leading '@' before querying instagram_handle, so a lookup matches regardless of format", async () => {
    query.mockResolvedValue([{ id: "s1" }]);
    expect(await isSuppressed({ instagramHandle: "@BondiBaker" })).toBe(true);
    const [, params] = query.mock.calls[0];
    expect(params).toContain("bondibaker");
  });

  it("returns false without querying when neither key is supplied", async () => {
    expect(await isSuppressed({})).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns false when nothing matches", async () => {
    query.mockResolvedValue([]);
    expect(await isSuppressed({ email: "nobody@example.com" })).toBe(false);
  });

  it("adds a suppression keyed by email", async () => {
    query.mockResolvedValueOnce([
      {
        id: "s1",
        email: "ava@example.com",
        instagram_handle: null,
        reason: "unsubscribed",
        created_by: "ava@tesserix.app",
        created_at: new Date("2026-08-16T00:00:00Z"),
      },
    ]);
    const row = await addSuppression({
      email: "ava@example.com",
      reason: "unsubscribed",
      actor: "ava@tesserix.app",
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO crm_suppressions");
    expect(params).toEqual(["ava@example.com", null, "unsubscribed", "ava@tesserix.app"]);
    expect(row.email).toBe("ava@example.com");
    expect(row.createdAt).toBe("2026-08-16T00:00:00.000Z");
  });

  // The write-side half of Ruling 18: stored in its canonical form so the
  // read side's own normalization always has something consistent to match
  // against, regardless of how an operator (or an import row) typed it.
  it("strips a leading '@' and lowercases before storing an instagram handle", async () => {
    query.mockResolvedValueOnce([
      {
        id: "s1",
        email: null,
        instagram_handle: "bondibaker",
        reason: "unsubscribed",
        created_by: "ava@tesserix.app",
        created_at: new Date("2026-08-16T00:00:00Z"),
      },
    ]);
    await addSuppression({
      instagramHandle: "@BondiBaker",
      reason: "unsubscribed",
      actor: "ava@tesserix.app",
    });
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([null, "bondibaker", "unsubscribed", "ava@tesserix.app"]);
  });

  // Belt-and-braces alongside migration 0022's trigger (Ruling 19): trimmed
  // and lowercased here too, so the common case never has to round-trip
  // through the database to look normal.
  it("trims and lowercases the email before storing it", async () => {
    query.mockResolvedValueOnce([
      {
        id: "s1",
        email: "ava@example.com",
        instagram_handle: null,
        reason: "unsubscribed",
        created_by: "ava@tesserix.app",
        created_at: new Date("2026-08-16T00:00:00Z"),
      },
    ]);
    await addSuppression({
      email: "  Ava@Example.com  ",
      reason: "unsubscribed",
      actor: "ava@tesserix.app",
    });
    const [, params] = query.mock.calls[0];
    expect(params).toEqual(["ava@example.com", null, "unsubscribed", "ava@tesserix.app"]);
  });

  it("refuses to add a suppression with neither key, before touching the database", async () => {
    await expect(
      addSuppression({ reason: "unsubscribed", actor: "ava@tesserix.app" }),
    ).rejects.toThrow(/email|instagram/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("lists suppressions newest first", async () => {
    query.mockResolvedValue([]);
    await listSuppressions();
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("FROM crm_suppressions");
    expect(sql).toContain("ORDER BY created_at DESC");
  });

  // Ruling 17: `removeSuppression` is plain data access — no session to
  // check, no `auditedOperation` call, at this layer. Accountability for the
  // write lives in `suppressions/actions.ts`, via the shared `withCrmWrite`
  // (see `lib/crm-write.ts` and `suppressions/actions.test.ts`).
  describe("removeSuppression", () => {
    it("deletes by id and returns exactly the rows the DELETE reports, including the suppression key", async () => {
      query.mockResolvedValueOnce([{ id: "s1", email: "ava@example.com", instagram_handle: null }]);
      const rows = await removeSuppression("s1");
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain("DELETE FROM crm_suppressions");
      expect(sql).toContain("RETURNING id, email, instagram_handle");
      expect(params).toEqual(["s1"]);
      // Ruling 20: email/instagramHandle returned alongside id, and mapped
      // to camelCase — the caller (`suppressions/actions.ts`) needs these to
      // audit the suppression's key rather than the opaque uuid it was
      // looked up by.
      expect(rows).toEqual([{ id: "s1", email: "ava@example.com", instagramHandle: null }]);
    });

    // Important 3: a DELETE against a non-matching id succeeds with zero
    // rows, not an error — the caller (`suppressions/actions.ts`) needs this
    // real count to write an honest `{ removed: 0 }` rather than assuming
    // `{ removed: 1 }` for a removal that never happened.
    it("returns no rows, honestly, when nothing matched", async () => {
      query.mockResolvedValueOnce([]);
      const rows = await removeSuppression("missing");
      expect(rows).toEqual([]);
    });
  });
});

/**
 * CSV import (Task 8).
 *
 * The rule both `previewImport` and `commitImport` exist to hold: suppression
 * is checked at BOTH preview and commit, never only at preview. A preview
 * can be minutes old; someone can be suppressed in the gap, and committing a
 * stale preview would then contact a person who asked not to be. Every test
 * below that calls `commitImport` re-asserts the suppression check fires
 * there too — not "trust the preview already covered it".
 *
 * `query.mockImplementation` routes by SQL shape rather than call order, so
 * these tests don't depend on exactly how many statements `commitImport`
 * issues per row — only on which statements ran and with what effect.
 */
describe("import", () => {
  function routeQuery(overrides: {
    suppressed?: unknown[];
    matched?: unknown[];
  }) {
    return (sql: string) => {
      if (/INSERT INTO crm_imports/.test(sql)) {
        return Promise.resolve([{ id: "imp1" }]);
      }
      if (/FROM crm_suppressions/.test(sql)) {
        return Promise.resolve(overrides.suppressed ?? []);
      }
      if (/FROM crm_contacts/.test(sql)) {
        return Promise.resolve(overrides.matched ?? []);
      }
      if (/INSERT INTO crm_organisations/.test(sql)) {
        return Promise.resolve([{ id: "org1" }]);
      }
      return Promise.resolve([]);
    };
  }

  // Ruling 23: `isSuppressed`/`findMatchingOrganisationId` accept an
  // optional `query` override, defaulting to `tesserixQuery`. These two
  // tests prove the override actually takes precedence — not just that a
  // plausible answer comes back — by asserting the module's OWN connection
  // (`query`, what `tesserixQuery` routes to in this harness) is never
  // touched when an override is supplied. That's the mechanism
  // `commitImport` relies on to read its own transaction's uncommitted
  // writes; the shared single-spy harness elsewhere in this file can't
  // distinguish "two connections" from "one", so this is the one place that
  // isolates the override itself.
  describe("query overrides (Ruling 23)", () => {
    it("isSuppressed uses the supplied query, not the module's own connection", async () => {
      const override = vi.fn().mockResolvedValue([{ id: "s1" }]);
      const result = await isSuppressed({ email: "ava@example.com" }, override);
      expect(result).toBe(true);
      expect(override).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
    });

    it("findMatchingOrganisationId uses the supplied query, not the module's own connection", async () => {
      const override = vi.fn().mockResolvedValue([{ organisation_id: "org1" }]);
      const result = await findMatchingOrganisationId({ email: "ava@example.com" }, override);
      expect(result).toBe("org1");
      expect(override).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
    });
  });

  // Issue #215. Migration 0023 makes lower(instagram_handle) unique, so at
  // most one row can match and the order decides nothing on a current
  // database. The ORDER BY is for the database that is NOT current — one
  // predating 0023, or one where the index was dropped — where LIMIT 1 with
  // no order picks arbitrarily and unrepeatably. Asserted on the SQL rather
  // than on a returned row because a fake query can't reproduce Postgres's
  // choice of plan, which is exactly the thing being pinned down.
  describe("findMatchingOrganisationId determinism (#215)", () => {
    it("orders by created_at then id so a multi-row match resolves the same way every call", async () => {
      const override = vi.fn().mockResolvedValue([]);
      await findMatchingOrganisationId({ instagramHandle: "@BondiBaker" }, override);
      const [sql] = override.mock.calls[0];
      expect(sql).toMatch(/ORDER BY\s+created_at,\s*id\s+LIMIT 1/);
    });
  });

  describe("previewImport", () => {
    it("skips suppressed rows at preview, before anything is written", async () => {
      query.mockImplementation(routeQuery({ suppressed: [{ id: "s1" }] }));
      const preview = await previewImport([{ email: "ava@example.com" }]);
      expect(preview.skippedSuppressed).toBe(1);
      expect(preview.toCreate).toBe(0);
      expect(preview.matchedExisting).toBe(0);
      // No call issued anything that could mutate the database — the
      // no-write property is structural (previewImport never calls
      // tesserixTx), not a single early return that a future edit could
      // route around.
      expect(query.mock.calls.every(([sql]) => !/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toBe(
        true,
      );
    });

    it("counts a row matching an existing contact as matchedExisting, not toCreate", async () => {
      query.mockImplementation(
        routeQuery({ suppressed: [], matched: [{ organisation_id: "org1" }] }),
      );
      const row = { email: "ava@example.com" };
      const preview = await previewImport([row]);
      expect(preview.matchedExisting).toBe(1);
      expect(preview.toCreate).toBe(0);
      // Judgement call 2: dedup-only is correct (never merge scraped CSV
      // data over an operator-curated row) — but the list of which rows
      // were left unchanged has to be discoverable, not just a bare count.
      expect(preview.matchedRows).toEqual([row]);
    });

    it("counts a fresh row as toCreate", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const preview = await previewImport([{ email: "new@example.com" }]);
      expect(preview.toCreate).toBe(1);
      expect(preview.matchedExisting).toBe(0);
      expect(preview.skippedSuppressed).toBe(0);
    });

    // Important 1 (review round 2): the exact regression. Before this fix,
    // two rows sharing an email both previewed as toCreate, while
    // commitImport (Ruling 23) correctly resolved the second as
    // matchedExisting — a preview silently misreporting the one input its
    // own module comments call "ordinary content for a scraped leads
    // sheet", on the one page whose entire premise is "preview what this
    // would do".
    it("resolves an intra-batch duplicate email as matchedExisting on the second row, matching what commitImport will do", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const preview = await previewImport([
        { email: "dup@example.com" },
        { email: "dup@example.com" },
      ]);
      expect(preview.toCreate).toBe(1);
      expect(preview.matchedExisting).toBe(1);
    });

    it("resolves an intra-batch duplicate Instagram handle the same way, format- and case-insensitively", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const preview = await previewImport([
        { instagramHandle: "@BondiBaker" },
        { instagramHandle: "bondibaker" },
      ]);
      expect(preview.toCreate).toBe(1);
      expect(preview.matchedExisting).toBe(1);
    });

    it("does not treat an email and an Instagram handle sharing normalised text as duplicates of each other", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const preview = await previewImport([
        { email: "bondibaker@example.com" },
        { instagramHandle: "bondibaker@example.com" },
      ]);
      // Namespaced keys (`email:`/`ig:`) — an email and a handle that
      // happen to share the same literal text are not the same identity.
      expect(preview.toCreate).toBe(2);
      expect(preview.matchedExisting).toBe(0);
    });

    it("counts a row with nothing to identify it as malformed, without querying the database for it", async () => {
      query.mockImplementation(routeQuery({}));
      const preview = await previewImport([{ phone: "0400000000" }]);
      expect(preview.malformed).toBe(1);
      expect(preview.toCreate).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });

    it("never issues a write statement at all, across a full mixed batch", async () => {
      query.mockImplementation(
        routeQuery({ suppressed: [], matched: [] }),
      );
      await previewImport([
        { email: "suppressed@example.com" },
        { email: "matched@example.com" },
        { email: "fresh@example.com" },
        {},
      ]);
      for (const [sql] of query.mock.calls) {
        expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)/i);
      }
    });
  });

  describe("commitImport", () => {
    it("still consults suppression when committing, not only at preview", async () => {
      // Guards the guard: checking only at preview means a stale preview
      // commits someone who was suppressed in between.
      query.mockImplementation(routeQuery({ suppressed: [{ id: "s1" }] }));
      const result = await commitImport([{ email: "ava@example.com" }], "ava@tesserix.app", "legitimate_interests");
      expect(query.mock.calls.some(([sql]) => /FROM crm_suppressions/.test(sql))).toBe(true);
      expect(result.skippedSuppressed).toBe(1);
      expect(result.created).toBe(0);
      // A suppressed row must never reach the organisation insert.
      expect(query.mock.calls.some(([sql]) => /INSERT INTO crm_organisations/.test(sql))).toBe(
        false,
      );
    });

    it("skips a row matching an existing contact without creating a duplicate organisation", async () => {
      query.mockImplementation(
        routeQuery({ suppressed: [], matched: [{ organisation_id: "org1" }] }),
      );
      const result = await commitImport([{ email: "ava@example.com" }], "ava@tesserix.app", "legitimate_interests");
      expect(result.matchedExisting).toBe(1);
      expect(result.created).toBe(0);
      expect(query.mock.calls.some(([sql]) => /INSERT INTO crm_organisations/.test(sql))).toBe(
        false,
      );
    });

    it("creates an organisation, contact and opportunity for a fresh row, stamped with the import id", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const result = await commitImport(
        [{ name: "Bondi Baker", email: "ava@example.com", instagramHandle: "@bondibaker" }],
        "ava@tesserix.app",
        "legitimate_interests",
      );
      expect(result.created).toBe(1);

      const orgCall = query.mock.calls.find(([sql]) => /INSERT INTO crm_organisations/.test(sql));
      expect(orgCall).toBeDefined();
      const [, orgParams] = orgCall!;
      // import_id (from the crm_imports insert) is stamped on the row.
      expect(orgParams).toContain("imp1");

      const oppCall = query.mock.calls.find(([sql]) => /INSERT INTO crm_opportunities/.test(sql));
      expect(oppCall).toBeDefined();
      const [oppSql, oppParams] = oppCall!;
      // product stays null and stage lands at 'new' — migrated/imported
      // opportunities were never matched to a product, and the CHECK
      // constraint (crm_opp_product_required_when_qualified) only allows a
      // null product at 'new'/'contacted'.
      expect(oppSql).toContain("'new'");
      expect(oppParams).not.toContain("qualified");
    });

    it("counts a row with nothing to identify it as malformed and writes nothing for it", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const result = await commitImport([{ phone: "0400000000" }], "ava@tesserix.app", "legitimate_interests");
      expect(result.malformed).toBe(1);
      expect(result.created).toBe(0);
      expect(query.mock.calls.some(([sql]) => /INSERT INTO crm_organisations/.test(sql))).toBe(
        false,
      );
    });

    it("writes one crm_imports batch row and records row/skipped counts on it", async () => {
      query.mockImplementation(routeQuery({ suppressed: [{ id: "s1" }], matched: [] }));
      await commitImport(
        [{ email: "ava@example.com" }, { phone: "0400000000" }],
        "ava@tesserix.app",
        "legitimate_interests",
        "leads.csv",
      );
      const importInsert = query.mock.calls.find(([sql]) => /INSERT INTO crm_imports/.test(sql));
      expect(importInsert).toBeDefined();
      const updateCall = query.mock.calls.find(([sql]) => /UPDATE crm_imports/.test(sql));
      expect(updateCall).toBeDefined();
      const [, updateParams] = updateCall!;
      // 2 rows total, both skipped (1 suppressed, 1 malformed).
      expect(updateParams).toEqual(["imp1", 2, 2]);
    });

    // Important 1 (Ruling 23): the reproduction case. Two CSV rows sharing
    // an email is ordinary content for a scraped leads sheet, not an edge
    // case. Before the fix, row 2's dedup lookup ran on a separate
    // connection from the transaction's own client and could not see row
    // 1's still-uncommitted crm_contacts insert — it would attempt its own
    // insert, trip crm_contacts_email_lower_uq, and roll the WHOLE batch
    // back. This mock models the visibility a same-connection lookup gets
    // (a stateful router, not `routeQuery`'s per-call-only one): row 2's
    // "FROM crm_contacts" check only starts returning a match once row 1's
    // "INSERT INTO crm_contacts" has actually run.
    it("resolves an intra-batch duplicate email as matchedExisting on the second row, not a constraint violation", async () => {
      let contactInserted = false;
      query.mockImplementation((sql: string) => {
        if (/INSERT INTO crm_imports/.test(sql)) return Promise.resolve([{ id: "imp1" }]);
        if (/FROM crm_suppressions/.test(sql)) return Promise.resolve([]);
        if (/FROM crm_contacts/.test(sql)) {
          return Promise.resolve(contactInserted ? [{ organisation_id: "org1" }] : []);
        }
        if (/INSERT INTO crm_organisations/.test(sql)) return Promise.resolve([{ id: "org1" }]);
        if (/INSERT INTO crm_contacts/.test(sql)) {
          contactInserted = true;
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const result = await commitImport(
        [{ email: "dup@example.com" }, { email: "dup@example.com" }],
        "ava@tesserix.app",
        "legitimate_interests",
      );

      expect(result.created).toBe(1);
      expect(result.matchedExisting).toBe(1);
      expect(
        query.mock.calls.filter(([sql]) => /INSERT INTO crm_organisations/.test(sql)),
      ).toHaveLength(1);
    });

    // Important 2 (Ruling 23): the mocked tesserixTx in this file is
    // `(fn) => fn(query)` — it does not implement real BEGIN/ROLLBACK, so
    // this cannot prove Postgres-level atomicity (crm-repo.write.integration.test.ts,
    // via runTesserixTx against pglite, is what proves that for the shared
    // transactional core). What this DOES pin: a failure partway through
    // the batch must propagate as a rejection, not be swallowed into a
    // partial `{ created: 1, ... }` the caller could mistake for full
    // success.
    it("rejects the whole commit when a write fails partway through the batch, rather than reporting partial success", async () => {
      let orgInsertCount = 0;
      query.mockImplementation((sql: string) => {
        if (/INSERT INTO crm_imports/.test(sql)) return Promise.resolve([{ id: "imp1" }]);
        if (/FROM crm_suppressions/.test(sql)) return Promise.resolve([]);
        if (/FROM crm_contacts/.test(sql)) return Promise.resolve([]);
        if (/INSERT INTO crm_organisations/.test(sql)) {
          orgInsertCount++;
          if (orgInsertCount === 2) return Promise.reject(new Error("connection terminated"));
          return Promise.resolve([{ id: "org1" }]);
        }
        return Promise.resolve([]);
      });

      await expect(
        commitImport(
          [{ email: "first@example.com" }, { email: "second@example.com" }],
          "ava@tesserix.app",
          "legitimate_interests",
        ),
      ).rejects.toThrow("connection terminated");
    });

    // Minor: crm_imports.row_count previously counted only the rows that
    // survived client-side CSV parsing, under-reporting the source file by
    // however many parseImportCsv already dropped as malformed. `totalRows`
    // is how the caller (import/actions.ts) supplies the true file size.
    it("uses totalRows, not just the parsed batch size, so row_count reflects the whole file", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      await commitImport(
        [{ email: "ava@example.com" }],
        "ava@tesserix.app",
        "legitimate_interests",
        "leads.csv",
        5, // e.g. 4 rows the client-side parser already dropped as malformed
      );
      const updateCall = query.mock.calls.find(([sql]) => /UPDATE crm_imports/.test(sql));
      const [, updateParams] = updateCall!;
      // row_count is the full file (5), not just the 1 row that survived
      // parsing; skipped_count reconciles exactly: row_count - created = 4.
      expect(updateParams).toEqual(["imp1", 5, 4]);
    });

    it("lists the rows that matched an existing organisation, not just their count", async () => {
      query.mockImplementation(
        routeQuery({ suppressed: [], matched: [{ organisation_id: "org1" }] }),
      );
      const row = { email: "ava@example.com", name: "Bondi Baker" };
      const result = await commitImport([row], "ava@tesserix.app", "legitimate_interests");
      expect(result.matchedRows).toEqual([row]);
    });

    it("preview and commit agree on counts for the same input", async () => {
      const rows = [
        { email: "suppressed@example.com" },
        { email: "matched@example.com" },
        { email: "fresh@example.com" },
        {},
      ];
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const preview = await previewImport(rows);

      query.mockReset();
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const committed = await commitImport(rows, "ava@tesserix.app", "legitimate_interests");

      expect(committed.created).toBe(preview.toCreate);
      expect(committed.matchedExisting).toBe(preview.matchedExisting);
      expect(committed.skippedSuppressed).toBe(preview.skippedSuppressed);
      expect(committed.malformed).toBe(preview.malformed);
    });
  });
});

describe("wonWithoutConversion", () => {
  it("only asks for won opportunities with no conversion recorded", async () => {
    query.mockResolvedValueOnce([]);
    await wonWithoutConversion(50);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("o.stage = 'won'");
    expect(sql).toContain("g.converted_at IS NULL");
  });

  // Ruling 35. This returns one row per won OPPORTUNITY, so excluding on
  // `g.converted_at IS NULL` alone — a fact about the ORGANISATION — made a
  // second product's won deal vanish from the queue the moment the first was
  // confirmed: never linked, and with nothing telling the operator it had
  // gone. The product comparison is what keeps the exclusion per-row.
  it("excludes only the deal whose own product was accounted for", async () => {
    query.mockResolvedValueOnce([]);
    await wonWithoutConversion(50);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("g.converted_product IS DISTINCT FROM o.product");
    // Guards the guard: an unqualified `AND g.converted_at IS NULL` is
    // exactly the organisation-level filter this fix replaced.
    expect(sql).not.toMatch(/AND\s+g\.converted_at IS NULL\s*\n\s*ORDER BY/);
  });

  it("maps a row's primary contact email and product", async () => {
    query.mockResolvedValueOnce([
      {
        id: "o1",
        organisation_id: "g1",
        organisation_name: "Bondi Baker",
        product: "mark8ly",
        closed_at: new Date("2026-08-10T00:00:00Z"),
        primary_email: "priya@bondibaker.example",
      },
    ]);
    const { rows } = await wonWithoutConversion(50);
    expect(rows).toEqual([
      {
        opportunityId: "o1",
        organisationId: "g1",
        organisationName: "Bondi Baker",
        product: "mark8ly",
        primaryEmail: "priya@bondibaker.example",
        closedAt: "2026-08-10T00:00:00.000Z",
      },
    ]);
  });

  // #246. The cap used to be silent, so a backlog past it looked like a queue
  // that ended there.
  it("asks for one row past the cap, and reports the overflow without rendering it", async () => {
    query.mockResolvedValueOnce(
      Array.from({ length: 3 }, (_unused, i) => ({
        id: `o${i}`,
        organisation_id: `g${i}`,
        organisation_name: `Org ${i}`,
        product: "mark8ly",
        closed_at: new Date("2026-08-10T00:00:00Z"),
        primary_email: null,
      })),
    );

    const page = await wonWithoutConversion(2);

    const [, params] = query.mock.calls[0];
    expect(params, "the probe row is what makes hasMore knowable").toEqual([3]);
    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  // The boundary: a queue of exactly the cap has nothing past it. Inferring
  // from `rows.length === limit` would be wrong here, which is why the probe
  // row exists at all.
  it("reports no overflow when the queue ends exactly at the cap", async () => {
    query.mockResolvedValueOnce(
      Array.from({ length: 2 }, (_unused, i) => ({
        id: `o${i}`,
        organisation_id: `g${i}`,
        organisation_name: `Org ${i}`,
        product: "mark8ly",
        closed_at: null,
        primary_email: null,
      })),
    );

    const page = await wonWithoutConversion(2);

    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it("carries a null primary email through rather than failing the row", async () => {
    query.mockResolvedValueOnce([
      {
        id: "o1",
        organisation_id: "g1",
        organisation_name: "No Contact Co",
        product: "kora",
        closed_at: null,
        primary_email: null,
      },
    ]);
    const { rows: [row] } = await wonWithoutConversion(50);
    expect(row.primaryEmail).toBeNull();
  });

  // 0019's CHECK does NOT make a won, product-less opportunity unreachable
  // — 0020 drops it and 0021 reinstates it NOT VALID precisely so the
  // migrated rows survive. This row is expected, not malformed.
  it("carries a null product through rather than throwing — that is what every migrated won deal looks like", async () => {
    // `migrate-leads-to-crm.mjs` writes `product: null` on every opportunity
    // it creates, and 0020/0021 grandfather exactly those rows past the
    // product CHECK. So the FIRST migrated won lead hits this function on
    // day one. Throwing here put the whole handoff surface into its error
    // state; the row is genuinely won-but-not-converted and belongs in the
    // queue, and `linkConversion` takes the product from the operator's
    // selection rather than from the opportunity, so it is still linkable.
    query.mockResolvedValueOnce([
      {
        id: "o1",
        organisation_id: "g1",
        organisation_name: "Migrated Co",
        product: null,
        closed_at: null,
        primary_email: null,
      },
    ]);
    const { rows: [row] } = await wonWithoutConversion(50);
    expect(row.product).toBeNull();
    expect(row.organisationName).toBe("Migrated Co");
  });
});

describe("linkConversion", () => {
  it("rejects a missing product or ref before touching the database", async () => {
    await expect(
      linkConversion({
        organisationId: "g1",
        product: "",
        ref: "tenant_1",
        method: "manual",
        actor: "ava@tesserix.app",
      }),
    ).rejects.toThrow(/product and ref/);
    await expect(
      linkConversion({
        organisationId: "g1",
        product: "mark8ly",
        ref: "",
        method: "manual",
        actor: "ava@tesserix.app",
      }),
    ).rejects.toThrow(/product and ref/);
    expect(query).not.toHaveBeenCalled();
  });

  it("writes converted_* and updated_at together, only against a row with no conversion yet", async () => {
    query
      .mockResolvedValueOnce([{ id: "g1", name: "Bondi Baker" }]) // UPDATE
      .mockResolvedValueOnce([]); // INSERT INTO crm_activities

    const result = await linkConversion({
      organisationId: "g1",
      product: "mark8ly",
      ref: "tenant_9f2",
      label: "Bondi Store",
      method: "matched",
      actor: "ava@tesserix.app",
    });

    expect(result).toEqual({
      organisationId: "g1",
      organisationName: "Bondi Baker",
      product: "mark8ly",
      method: "matched",
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("converted_product = $2");
    expect(sql).toContain("converted_ref = $3");
    expect(sql).toContain("converted_link_method = $5");
    expect(sql).toContain("updated_at = now()");
    // Ruling 30: the guard against overwriting an existing conversion —
    // `wonWithoutConversion` returns one row per won OPPORTUNITY, so a
    // business with won deals on two products appears twice in the handoff
    // queue, and confirming both would otherwise silently overwrite the
    // first product's converted_* with the second's.
    expect(sql).toContain("converted_at IS NULL");
    expect(params).toEqual(["g1", "mark8ly", "tenant_9f2", "Bondi Store", "matched"]);
  });

  // Ruling 31: the timeline record. `console_audit_log` (written by the
  // action layer's `withCrmWrite`) is accountability; this is the
  // operator-facing narrative — the same escape hatch `advanceStage` uses
  // for a mere product re-point, for a moment strictly more significant
  // than that.
  it("writes a note activity in the same transaction as the update", async () => {
    query
      .mockResolvedValueOnce([{ id: "g1", name: "Bondi Baker" }]) // UPDATE
      .mockResolvedValueOnce([{ id: "opp-1" }]) // the won opportunity for this product
      .mockResolvedValueOnce([]); // INSERT INTO crm_activities

    await linkConversion({
      organisationId: "g1",
      product: "mark8ly",
      ref: "tenant_9f2",
      label: "Bondi Store",
      method: "matched",
      actor: "ava@tesserix.app",
    });

    expect(query).toHaveBeenCalledTimes(3);
    const [activitySql, activityParams] = query.mock.calls[2];
    expect(activitySql).toContain("INSERT INTO crm_activities");
    expect(activitySql).toContain("'note'");
    expect(activityParams[0]).toBe("g1");
    expect(activityParams[1]).toBe("ava@tesserix.app");
    expect(activityParams[2]).toContain("mark8ly");
    expect(activityParams[2]).toContain("tenant_9f2");
    expect(JSON.parse(activityParams[3] as string)).toEqual({
      product: "mark8ly",
      ref: "tenant_9f2",
      label: "Bondi Store",
      method: "matched",
    });
    // The deal the note is ABOUT. Without it the note lands only on the
    // organisation, and the won opportunity's own timeline — where the next
    // rep looks — still shows nothing after "won".
    expect(activityParams[4]).toBe("opp-1");
  });

  it("still writes the note when no won opportunity carries the linked product", async () => {
    query
      .mockResolvedValueOnce([{ id: "g1", name: "Bondi Baker" }]) // UPDATE
      .mockResolvedValueOnce([]) // no matching won opportunity
      .mockResolvedValueOnce([]) // and no product-less won deal to fill either
      .mockResolvedValueOnce([]); // INSERT INTO crm_activities

    await linkConversion({
      organisationId: "g1",
      product: "mark8ly",
      ref: "tenant_9f2",
      method: "manual",
      actor: "ava@tesserix.app",
    });

    const [, activityParams] = query.mock.calls[3];
    expect(activityParams[4]).toBeNull();
  });

  // #214: the write that lets a migrated won deal leave the handoff queue.
  // The queue compares the organisation's `converted_product` against the
  // opportunity's own, so a deal the migration left product-less never
  // cleared until `linkConversion` filled it in.
  it("fills a product-less won opportunity's product, and notes the conversion against it", async () => {
    query
      .mockResolvedValueOnce([{ id: "g1", name: "Bondi Baker" }]) // UPDATE crm_organisations
      .mockResolvedValueOnce([]) // no won opportunity carries this product yet
      .mockResolvedValueOnce([{ id: "opp-migrated" }]) // the fill
      .mockResolvedValueOnce([]); // INSERT INTO crm_activities

    await linkConversion({
      organisationId: "g1",
      product: "mark8ly",
      ref: "tenant_9f2",
      method: "manual",
      actor: "ava@tesserix.app",
    });

    const [fillSql, fillParams] = query.mock.calls[2];
    expect(fillSql).toContain("UPDATE crm_opportunities");
    expect(fillSql).toContain("product = $2");
    // Only a NULL is ever filled — never an overwrite of a product the deal
    // already carries — and `updated_at` explicitly, since nothing on
    // `crm_*` has a trigger to do it.
    expect(fillSql).toContain("product IS NULL");
    expect(fillSql).toContain("stage = 'won'");
    expect(fillSql).toContain("updated_at = now()");
    expect(fillParams).toEqual(["g1", "mark8ly"]);

    const [, activityParams] = query.mock.calls[3];
    expect(activityParams[4]).toBe("opp-migrated");
  });

  // The other half of "only fills a NULL": when a won deal already carries
  // the linked product, nothing is filled at all. A *different*, product-less
  // deal on the same organisation is not the deal this conversion is for,
  // and stamping it would fabricate the attribution the migration declined.
  it("does not touch any opportunity when a won deal already carries the product", async () => {
    query
      .mockResolvedValueOnce([{ id: "g1", name: "Bondi Baker" }]) // UPDATE crm_organisations
      .mockResolvedValueOnce([{ id: "opp-1" }]) // the won deal for this product
      .mockResolvedValueOnce([]); // INSERT INTO crm_activities

    await linkConversion({
      organisationId: "g1",
      product: "mark8ly",
      ref: "tenant_9f2",
      method: "matched",
      actor: "ava@tesserix.app",
    });

    expect(query).toHaveBeenCalledTimes(3);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("UPDATE crm_opportunities")),
    ).toBe(false);
  });

  it("does not write an activity when the update matches no row", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([]); // UPDATE, then the existence check

    await expect(
      linkConversion({
        organisationId: "missing",
        product: "mark8ly",
        ref: "tenant_1",
        method: "manual",
        actor: "ava@tesserix.app",
      }),
    ).rejects.toThrow();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO crm_activities"))).toBe(
      false,
    );
  });

  it("throws when the organisation no longer exists rather than reporting success", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([]); // UPDATE matched nothing, and does not exist
    await expect(
      linkConversion({
        organisationId: "missing",
        product: "mark8ly",
        ref: "tenant_1",
        method: "manual",
        actor: "ava@tesserix.app",
      }),
    ).rejects.toThrow(/not found/);
  });

  // THE case Ruling 30 exists for: the organisation is real, but a prior
  // write (the other product's row in the same handoff queue, a second
  // operator, a stale tab) already recorded a conversion. Zero rows from
  // the guarded UPDATE must not read as "not found" — that would be a false
  // report that the organisation vanished.
  it("throws AlreadyLinkedError, not a not-found error, when a conversion is already recorded", async () => {
    query
      .mockResolvedValueOnce([]) // UPDATE matched nothing — already linked
      .mockResolvedValueOnce([{ id: "g1" }]); // it does exist

    await expect(
      linkConversion({
        organisationId: "g1",
        product: "kora",
        ref: "user_2",
        method: "matched",
        actor: "ava@tesserix.app",
      }),
    ).rejects.toThrow(AlreadyLinkedError);
  });
});
