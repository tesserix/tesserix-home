import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { UNASSIGNED_PRODUCT } from "./crm-filters";

/**
 * Integration coverage for the drifting-queue's NULL/COALESCE semantics.
 *
 * The unit tests in crm-repo.test.ts assert SQL *shape* (which substrings
 * appear) — that's necessary but not sufficient here. Two SQL statements
 * that both satisfy every shape assertion produce materially different
 * results:
 *   - `ORDER BY o.last_contacted_at ASC` (bare column, COALESCE still
 *     present in the WHERE) orders never-contacted rows arbitrarily
 *     (NULLS LAST by default) instead of by how long they've actually been
 *     quiet.
 *   - `AND (o.last_contacted_at IS NULL OR COALESCE(...) <= ...)` passes
 *     every existing shape test but reinstates the 259-row-flood
 *     regression Ruling 8 fixed, because it drops back to "never contacted
 *     = drifting" rather than "never contacted, clock starts at creation".
 *
 * This file runs the real SQL against a real (in-process) Postgres via
 * pglite and asserts on which rows come back and in what order — the only
 * way to catch either regression. Scoped narrowly to this module: the
 * other repos (notifications-repo, audit-repo) encode a window and a
 * limit, no NULL semantics or interval arithmetic, so shape assertions are
 * sufficient there and this dependency isn't worth adding for them.
 */

const dbHolder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("./tesserix", () => ({
  tesserixQuery: async (sql: string, params: readonly unknown[] = []) => {
    const db = dbHolder.db as {
      query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
    };
    const result = await db.query(sql, params as unknown[]);
    return result.rows;
  },
  isDatabaseConfigured: () => true,
}));

const {
  dueOpportunities,
  driftingOpportunities,
  isSuppressed,
  addSuppression,
  listOrganisations,
  organisationDetail,
} = await import("./crm-repo");

let db: PGlite;
let orgId: string;

// Fixed reference instant so "days ago" is stable across the whole suite,
// rather than drifting relative to `now()` between seed time and query time.
const daysAgo = (n: number) =>
  new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
const daysAhead = (n: number) =>
  new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();

beforeAll(async () => {
  db = new PGlite();
  const migrationPath = path.resolve(
    __dirname,
    "../../../web/db/migrations/0019_crm_schema.sql",
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");
  await db.exec(migrationSql);
  // Ruling 19: the normalisation trigger on crm_suppressions. Applied here
  // (not left to a separate suite) because the whole point of this
  // migration is that it holds regardless of which door a row came through
  // — including a raw INSERT, which is exactly what the suppressions
  // describe block below seeds with, below.
  const normalizeMigrationPath = path.resolve(
    __dirname,
    "../../../web/db/migrations/0022_crm_suppressions_normalize.sql",
  );
  await db.exec(readFileSync(normalizeMigrationPath, "utf-8"));
  // Task 3/4: derived `country` column the filter tests below need.
  const countryMigrationPath = path.resolve(
    __dirname,
    "../../../web/db/migrations/0025_crm_organisations_country.sql",
  );
  await db.exec(readFileSync(countryMigrationPath, "utf-8"));
  dbHolder.db = db;

  const orgResult = await db.query<{ id: string }>(
    `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
    ["Bondi Baker"],
  );
  orgId = orgResult.rows[0].id;

  await db.query(
    `INSERT INTO crm_opportunities
       (id, organisation_id, stage, next_action_at, last_contacted_at, created_at)
     VALUES
       -- A: created 1 day ago, never contacted, no next action.
       --    Within the 14-day grace period from creation — must NOT drift.
       ('11111111-1111-1111-1111-111111111111', $1, 'new', NULL, NULL, $2::timestamptz),
       -- H: created 90 days ago, never contacted, no next action.
       --    Most overdue row in the set — must drift, must sort FIRST.
       ('22222222-2222-2222-2222-222222222222', $1, 'new', NULL, NULL, $3::timestamptz),
       -- I: created 200 days ago (irrelevant — it has been contacted),
       --    last contacted 20 days ago, no next action.
       --    Stale by contact date, but less overdue than H — must drift,
       --    must sort SECOND. A bare-column ORDER BY last_contacted_at
       --    would put this row first (NULLS LAST puts H's null last),
       --    inverting the correct order.
       ('33333333-3333-3333-3333-333333333333', $1, 'contacted', NULL, $4::timestamptz, $5::timestamptz),
       -- D: created 200 days ago, last contacted 200 days ago, but has a
       --    next_action_at — drifting is never/no-next-action only, so
       --    this must be excluded from drifting regardless of staleness.
       ('44444444-4444-4444-4444-444444444444', $1, 'new', $6::timestamptz, $7::timestamptz, $8::timestamptz)`,
    [
      orgId,
      daysAgo(1),
      daysAgo(90),
      daysAgo(20),
      daysAgo(200),
      daysAhead(3),
      daysAgo(200),
      daysAgo(200),
    ],
  );

  await db.query(
    `INSERT INTO crm_opportunities
       (id, organisation_id, stage, product, next_action_at, last_contacted_at, created_at)
     VALUES
       -- Due: next action was yesterday, stage is open — must be due.
       ('55555555-5555-5555-5555-555555555555', $1, 'contacted', NULL, $2::timestamptz, NULL, $3::timestamptz),
       -- Not due: next action is in the future.
       ('66666666-6666-6666-6666-666666666666', $1, 'contacted', NULL, $4::timestamptz, NULL, $3::timestamptz),
       -- Not due: overdue next action, but stage is terminal (won). Won
       -- requires a product (crm_opp_product_required_when_qualified).
       ('77777777-7777-7777-7777-777777777777', $1, 'won', 'mark8ly', $2::timestamptz, NULL, $3::timestamptz)`,
    [orgId, daysAgo(1), daysAgo(10), daysAhead(5)],
  );
});

afterAll(async () => {
  await db.close();
});

describe("driftingOpportunities against a real database", () => {
  it("excludes a recently created, never-contacted lead", async () => {
    const { rows } = await driftingOpportunities({}, 14, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("11111111-1111-1111-1111-111111111111");
  });

  it("excludes any row with a next_action_at set, however stale", async () => {
    const { rows } = await driftingOpportunities({}, 14, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("44444444-4444-4444-4444-444444444444");
  });

  it("returns exactly the two stale rows, ordered most-overdue-first by quietSince", async () => {
    const { rows } = await driftingOpportunities({}, 14, 50);
    const ids = rows.map((r) => r.id);
    // Order pins the COALESCE-vs-bare-column regression: H (never
    // contacted, created 90 days ago) is more overdue than I (contacted 20
    // days ago) and must sort first. A bare `ORDER BY last_contacted_at`
    // would put I first, because H's NULL last_contacted_at sorts last by
    // default — exactly reversed.
    expect(ids).toEqual([
      "22222222-2222-2222-2222-222222222222", // H
      "33333333-3333-3333-3333-333333333333", // I
    ]);
  });

  it("reports quietSince as the COALESCE value, not raw last_contacted_at", async () => {
    const { rows } = await driftingOpportunities({}, 14, 50);
    const h = rows.find(
      (r) => r.id === "22222222-2222-2222-2222-222222222222",
    );
    const i = rows.find(
      (r) => r.id === "33333333-3333-3333-3333-333333333333",
    );
    expect(h?.lastContactedAt).toBeNull();
    expect(h?.quietSince).not.toBeNull();
    expect(i?.quietSince).toBe(i?.lastContactedAt);
    expect(h?.organisationName).toBe("Bondi Baker");
  });
});

describe("dueOpportunities against a real database", () => {
  // This asserts the exact due set from the top-level `beforeAll` seed only.
  // The "filtering runs in SQL..." describe below adds three more due rows
  // (two mark8ly, one kora) in its own nested `beforeAll` — if that ran
  // first, this `toEqual` would fail. It's safe today because Vitest runs a
  // file's describes, and their `beforeAll`s, in declaration order, and this
  // describe is declared above that one. That ordering guarantee does NOT
  // hold under `--sequence.shuffle`; if this suite ever adopts shuffled
  // execution, this assertion (and the nested seed below) need to move to
  // the top-level `beforeAll`/a distinct org so they stop depending on it.
  it("returns only the overdue, non-terminal opportunity", async () => {
    const { rows } = await dueOpportunities({}, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(["55555555-5555-5555-5555-555555555555"]);
  });
});

describe("filtering runs in SQL ahead of ORDER BY/LIMIT (Ruling 11)", () => {
  // The discriminating case: seed more due rows than the limit, with the one
  // matching row ranked BELOW the cut-off by next_action_at. Filtering the
  // already-limited TypeScript array can never see it — the predicate has to
  // run in the query, ahead of ORDER BY/LIMIT, for the matching row to
  // survive at all. This test fails against a TypeScript post-filter
  // (`filterRows` over a `LIMIT 2` page) and passes against the SQL-bound
  // implementation — that discrimination is the point.
  //
  // Seeded in a nested `beforeAll` (after the describe above's assertions
  // already depend on the top-level seed alone) rather than in the top-level
  // seed — see the ordering-dependence note on the previous describe.
  const orgId2Holder: { id?: string } = {};

  beforeAll(async () => {
    const org2 = await db.query<{ id: string }>(
      `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
      ["Kora Kitchen"],
    );
    orgId2Holder.id = org2.rows[0].id;

    // Two "mark8ly" rows, more overdue (smaller next_action_at sorts first
    // ASC) than the one "kora" row that follows them. A LIMIT 2 read of the
    // unfiltered due set fills up on the two mark8ly rows and never reaches
    // the kora row.
    await db.query(
      `INSERT INTO crm_opportunities
         (id, organisation_id, stage, product, next_action_at, last_contacted_at, created_at)
       VALUES
         ('88888888-8888-8888-8888-888888888888', $1, 'contacted', 'mark8ly', $2::timestamptz, NULL, $2::timestamptz),
         ('99999999-9999-9999-9999-999999999999', $1, 'contacted', 'mark8ly', $3::timestamptz, NULL, $3::timestamptz),
         ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', $4, 'contacted', 'kora', $5::timestamptz, NULL, $5::timestamptz)`,
      [orgId, daysAgo(30), daysAgo(29), orgId2Holder.id, daysAgo(1)],
    );
  });

  it("returns a product-matching row even when it ranks below the limit among unfiltered due rows", async () => {
    // With limit=2 and no filter, the two most-overdue mark8ly rows fill the
    // page and the kora row (created most recently, least overdue) is cut
    // off. Filtering that 2-row page for product=kora would return nothing —
    // the false negative Ruling 11 exists to prevent.
    const unfiltered = (await dueOpportunities({}, 2)).rows;
    expect(unfiltered.map((r) => r.id)).not.toContain(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );

    const filtered = (await dueOpportunities({ product: "kora" }, 2)).rows;
    expect(filtered.map((r) => r.id)).toEqual([
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    ]);
  });

  it("binds product/stage/owner filters against driftingOpportunities the same way", async () => {
    const { rows } = await driftingOpportunities({ product: "kora" }, 14, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("22222222-2222-2222-2222-222222222222"); // H, no product
    expect(ids).not.toContain("33333333-3333-3333-3333-333333333333"); // I, no product
  });
});

describe("owner filter escapes LIKE metacharacters against a real database", () => {
  // A literal "%" (or "_") in the filter value must not act as a LIKE
  // wildcard — an unescaped owner of "%" would otherwise match every row
  // with a non-null owner, which is a silently wrong filter, not a crash.
  beforeAll(async () => {
    await db.query(
      `UPDATE crm_opportunities SET owner = 'Asha Rao' WHERE id = $1`,
      ["55555555-5555-5555-5555-555555555555"],
    );
  });

  it("does not treat a literal '%' owner value as 'match everything'", async () => {
    const { rows } = await dueOpportunities({ owner: "%" }, 50);
    // The due set (top-level seed) has exactly one owned row ("Asha Rao"),
    // plus whatever the sibling describe above seeded with no owner set. An
    // unescaped "%" would return all of them; escaped, "%" has no literal
    // match and the filter returns nothing.
    expect(rows).toEqual([]);
  });

  it("still matches a literal substring once escaped", async () => {
    const { rows } = await dueOpportunities({ owner: "Asha" }, 50);
    expect(rows.map((r) => r.id)).toEqual([
      "55555555-5555-5555-5555-555555555555",
    ]);
  });
});

// The queue's own qualification signal (see the module doc on
// dueOpportunities/driftingOpportunities): country and follower band. Both
// predicates are shared with the organisations browse surface via
// `primaryContactFollowerClause`/`g.country = $n`, but that sharing is exactly
// what a shape-only unit test can't confirm applies correctly to the
// opportunity-joined queue query — a real database, seeded with a
// distinguishing follower count and country per organisation, is what proves
// the predicate resolves the right row.
describe("country and follower-band filters against a real database", () => {
  // Fixture ids name the seeded COUNTRY ("QQ"/"ZZ"), not the location text —
  // the two deliberately disagree. "QQ"/"ZZ" are synthetic, not "IN"/"AU":
  // real codes would collide with the country: "IN" fixtures the
  // organisations-page `describe` blocks elsewhere in this file seed, and
  // this suite shares one database across the whole file. Seeding a country
  // that contradicts its own location ("Chennai" filed under "QQ") is also
  // what makes a regression to matching on the raw `location` text
  // observable at all — a correct-looking `location`-based match would still
  // pass if the derived `country` column were silently ignored.
  let qqOrgId: string;
  let zzOrgId: string;
  let nullFollowersOrgId: string;

  const qqDueOppId = "cccccccc-1111-1111-1111-111111111111";
  const qqDriftingOppId = "cccccccc-1111-1111-1111-111111111112";
  const zzDueOppId = "cccccccc-2222-2222-2222-222222222221";
  const zzDriftingOppId = "cccccccc-2222-2222-2222-222222222222";
  const nullFollowersDueOppId = "cccccccc-3333-3333-3333-333333333331";
  const nullFollowersDriftingOppId = "cccccccc-3333-3333-3333-333333333332";

  beforeAll(async () => {
    const qqOrg = await db.query<{ id: string }>(
      `INSERT INTO crm_organisations (name, location, country) VALUES ($1, $2, $3) RETURNING id`,
      ["Queue Filter Chennai Org", "Chennai", "QQ"],
    );
    qqOrgId = qqOrg.rows[0].id;
    await db.query(
      `INSERT INTO crm_contacts (organisation_id, name, is_primary, followers_count)
       VALUES ($1, $2, true, $3)`,
      [qqOrgId, "Chennai Creator", 15000],
    );

    const zzOrg = await db.query<{ id: string }>(
      `INSERT INTO crm_organisations (name, location, country) VALUES ($1, $2, $3) RETURNING id`,
      ["Queue Filter Sydney Org", "Sydney", "ZZ"],
    );
    zzOrgId = zzOrg.rows[0].id;
    await db.query(
      `INSERT INTO crm_contacts (organisation_id, name, is_primary, followers_count)
       VALUES ($1, $2, true, $3)`,
      [zzOrgId, "Sydney Creator", 500],
    );

    const nullOrg = await db.query<{ id: string }>(
      `INSERT INTO crm_organisations (name, location, country) VALUES ($1, $2, $3) RETURNING id`,
      ["Queue Filter Null Followers Org", "Chennai", "QQ"],
    );
    nullFollowersOrgId = nullOrg.rows[0].id;
    await db.query(
      `INSERT INTO crm_contacts (organisation_id, name, is_primary, followers_count)
       VALUES ($1, $2, true, NULL)`,
      [nullFollowersOrgId, "Unmeasured Contact"],
    );

    // One due row and one drifting row per organisation, so both queries can
    // be exercised against the same fixtures. `owner` is set on the QQ due
    // row only, to test country/followers composing with an existing filter.
    await db.query(
      `INSERT INTO crm_opportunities
         (id, organisation_id, stage, owner, next_action_at, last_contacted_at, created_at)
       VALUES
         ($1, $2, 'new', 'Priya K', $9::timestamptz, NULL, $10::timestamptz),
         ($3, $2, 'new', NULL, NULL, NULL, $11::timestamptz),
         ($4, $5, 'new', NULL, $9::timestamptz, NULL, $10::timestamptz),
         ($6, $5, 'new', NULL, NULL, NULL, $11::timestamptz),
         ($7, $8, 'new', NULL, $9::timestamptz, NULL, $10::timestamptz),
         ($12, $8, 'new', NULL, NULL, NULL, $11::timestamptz)`,
      [
        qqDueOppId,
        qqOrgId,
        qqDriftingOppId,
        zzDueOppId,
        zzOrgId,
        zzDriftingOppId,
        nullFollowersDueOppId,
        nullFollowersOrgId,
        daysAgo(1),
        daysAgo(1),
        daysAgo(90),
        nullFollowersDriftingOppId,
      ],
    );
  });

  it("filters dueOpportunities by country", async () => {
    const { rows } = await dueOpportunities({ country: "QQ" }, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(qqDueOppId);
    expect(ids).not.toContain(zzDueOppId);
  });

  it("filters driftingOpportunities by country", async () => {
    const { rows } = await driftingOpportunities({ country: "QQ" }, 14, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(qqDriftingOppId);
    expect(ids).not.toContain(zzDriftingOppId);
  });

  it("filters dueOpportunities by follower band on the primary contact", async () => {
    const { rows } = await dueOpportunities({ followers: "over10k" }, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(qqDueOppId);
    expect(ids).not.toContain(zzDueOppId);
  });

  it("filters driftingOpportunities by follower band on the primary contact", async () => {
    const { rows } = await driftingOpportunities({ followers: "under1k" }, 14, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(zzDriftingOppId);
    expect(ids).not.toContain(qqDriftingOppId);
  });

  it("excludes a NULL followers_count from every band, in both due and drifting", async () => {
    const dueUnder1k = (await dueOpportunities({ followers: "under1k" }, 50)).rows;
    const dueOver10k = (await dueOpportunities({ followers: "over10k" }, 50)).rows;
    expect(dueUnder1k.map((r) => r.id)).not.toContain(nullFollowersDueOppId);
    expect(dueOver10k.map((r) => r.id)).not.toContain(nullFollowersDueOppId);

    const driftingUnder1k = (await driftingOpportunities({ followers: "under1k" }, 14, 50)).rows;
    const driftingOver10k = (await driftingOpportunities({ followers: "over10k" }, 14, 50)).rows;
    expect(driftingUnder1k.map((r) => r.id)).not.toContain(nullFollowersDriftingOppId);
    expect(driftingOver10k.map((r) => r.id)).not.toContain(nullFollowersDriftingOppId);
  });

  it("composes country and followers with the existing owner filter", async () => {
    const { rows } = await dueOpportunities(
      { country: "QQ", followers: "over10k", owner: "Priya" },
      50,
    );
    expect(rows.map((r) => r.id)).toEqual([qqDueOppId]);

    // Same organisation's country/follower band, but the owner substring
    // doesn't match — composing must AND, not OR, the predicates together.
    const nonMatching = (
      await dueOpportunities(
        { country: "QQ", followers: "over10k", owner: "Someone Else" },
        50,
      )
    ).rows;
    expect(nonMatching.map((r) => r.id)).not.toContain(qqDueOppId);
  });
});

// Important 7: the mocked unit tests in crm-repo.test.ts assert only that
// the SQL text contains `lower(` and that the raw value reaches `params` —
// an implementation of `lower(email) = $1` (`lower()` on the column only,
// the bound parameter passed through raw) satisfies both assertions and is
// still case-sensitive on the parameter side, which is exactly the bug
// Ruling 18's normalization exists to prevent. Only a real comparison, with
// a real case/format mismatch between the write and the read, tells the two
// apart — the same reason crm-repo.integration.test.ts exists at all for the
// drifting-queue's NULL/COALESCE semantics.
describe("suppressions match case-insensitively, and Instagram handles format-insensitively, against a real database", () => {
  beforeAll(async () => {
    await addSuppression({
      email: "Ava@Example.com",
      reason: "unsubscribed",
      actor: "ops@tesserix.app",
    });
    await addSuppression({
      instagramHandle: "@BondiBaker",
      reason: "asked not to be contacted",
      actor: "ops@tesserix.app",
    });
  });

  it("matches an email suppression stored mixed-case against a lookup in any other case", async () => {
    expect(await isSuppressed({ email: "ava@example.com" })).toBe(true);
    expect(await isSuppressed({ email: "AVA@EXAMPLE.COM" })).toBe(true);
    expect(await isSuppressed({ email: "someoneelse@example.com" })).toBe(false);
  });

  // Fix round 3: `addSuppression` (and migration 0022's trigger, for any row
  // that reaches the table another way) trim the stored email. A lookup
  // that didn't trim its own input would miss a real match against a value
  // that differs only by leading/trailing whitespace — a CSV cell (Task 8's
  // import) carries exactly that as a matter of course.
  it("matches an email suppression against a lookup carrying leading/trailing whitespace", async () => {
    expect(await isSuppressed({ email: "  ava@example.com  " })).toBe(true);
    expect(await isSuppressed({ email: "\tAVA@EXAMPLE.COM\n" })).toBe(true);
  });

  it("matches an instagram suppression regardless of case or a leading '@', in either direction", async () => {
    // Stored (after normalization) as "bondibaker" — matched here by a
    // lookup carrying the opposite case, and separately by one carrying the
    // `@` the write side stripped.
    expect(await isSuppressed({ instagramHandle: "bondibaker" })).toBe(true);
    expect(await isSuppressed({ instagramHandle: "@BondiBaker" })).toBe(true);
    expect(await isSuppressed({ instagramHandle: "BONDIBAKER" })).toBe(true);
    expect(await isSuppressed({ instagramHandle: "someoneelse" })).toBe(false);
  });
});

// Ruling 19 — the discriminating case the block above cannot exercise: every
// row up there was seeded through `addSuppression`, so `instagram_handle`
// never held anything but the application's own already-normalised form,
// and the column's SQL-side `lower()` was never actually load-bearing (a
// mutation removing it from BOTH sides of the comparison entirely still
// passed the whole suite). A row that reached the table any other way — a
// migration backfill, Task 8's import, a DBA's manual INSERT — is not
// guaranteed to be pre-normalised. This block bypasses `addSuppression`
// with a raw INSERT carrying the exact hand-rolled form ('@HandRolled',
// unstripped and mixed-case) migration 0022's header describes, and proves
// `isSuppressed` still finds it — which is only true because the
// `crm_suppressions_normalize_trg` trigger (0022) rewrites the row to its
// canonical form on the way in, regardless of what INSERT sent.
describe("a raw INSERT that bypasses addSuppression is still normalised, by the database trigger (Ruling 19)", () => {
  beforeAll(async () => {
    await db.query(
      `INSERT INTO crm_suppressions (instagram_handle, reason, created_by) VALUES ($1, $2, $3)`,
      ["@HandRolled", "manual entry, never went through addSuppression", "dba@tesserix.app"],
    );
  });

  it("normalises a hand-rolled INSERT so a lookup in canonical form still finds it", async () => {
    expect(await isSuppressed({ instagramHandle: "handrolled" })).toBe(true);
  });

  it("stores the row already in canonical form, not the raw '@HandRolled' the INSERT sent", async () => {
    const rows = await db.query<{ instagram_handle: string }>(
      `SELECT instagram_handle FROM crm_suppressions WHERE reason = $1`,
      ["manual entry, never went through addSuppression"],
    );
    expect(rows.rows[0].instagram_handle).toBe("handrolled");
  });

  // The other half of the failure Ruling 19 describes: without the trigger,
  // `addSuppression({ instagramHandle: "handrolled" })` would succeed
  // against the un-normalised '@HandRolled' row (crm_suppressions_ig_uq
  // does not see them as colliding), producing two rows for one person.
  // With the trigger, the hand-rolled row is already stored as "handrolled",
  // so this collides — exactly as it must.
  it("collides with a normal addSuppression call for the same person, rather than creating a second, unmatchable row", async () => {
    await expect(
      addSuppression({
        instagramHandle: "handrolled",
        reason: "duplicate of the hand-rolled row",
        actor: "ops@tesserix.app",
      }),
    ).rejects.toThrow(/crm_suppressions_ig_uq/);
  });
});

// Ruling 21: migration 0022 must never resolve a pre-existing collision by
// dropping or merging a row — it must detect one and RAISE EXCEPTION,
// naming the colliding rows, before the backfill UPDATE ever runs. This
// needs its own fresh database, seeded with colliding raw rows BEFORE 0022
// is applied — the shared `db` above already has 0022 applied and empty of
// collisions, so it cannot exercise this path. Not run through the
// `tesserixQuery` mock (`dbHolder`) at all: this is a direct assertion on
// the migration SQL itself, not on anything crm-repo.ts calls.
describe("migration 0022 refuses to normalise crm_suppressions when rows would collide (Ruling 21)", () => {
  it("aborts, naming the colliding emails, instead of silently merging or dropping one", async () => {
    const collisionDb = new PGlite();
    try {
      const schemaMigrationSql = readFileSync(
        path.resolve(__dirname, "../../../web/db/migrations/0019_crm_schema.sql"),
        "utf-8",
      );
      await collisionDb.exec(schemaMigrationSql);

      // Two rows that only collide AFTER normalisation — crm_suppressions_email_uq
      // (on bare lower(email)) does not reject this insert, because
      // 'Bob@Example.com' and ' bob@example.com ' are not equal under plain
      // lower() (the second still carries its whitespace).
      await collisionDb.query(
        `INSERT INTO crm_suppressions (email, reason, created_by) VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
          "Bob@Example.com",
          "first entry",
          "ops@tesserix.app",
          " bob@example.com ",
          "second entry, whitespace variant",
          "ops@tesserix.app",
        ],
      );

      const normalizeMigrationSql = readFileSync(
        path.resolve(__dirname, "../../../web/db/migrations/0022_crm_suppressions_normalize.sql"),
        "utf-8",
      );

      let caught: unknown;
      try {
        await collisionDb.exec(normalizeMigrationSql);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/refuses to normalise crm_suppressions\.email/);
      // Named, not just flagged — an operator resolving this by hand needs
      // to know WHICH rows, not just that some pair somewhere collides.
      expect((caught as Error).message).toMatch(/Bob@Example\.com/);

      // The two rows are untouched: still exactly as they were inserted,
      // neither dropped nor silently merged into the other.
      const rows = await collisionDb.query<{ email: string }>(
        `SELECT email FROM crm_suppressions ORDER BY email`,
      );
      expect(rows.rows.map((r) => r.email)).toEqual([
        " bob@example.com ",
        "Bob@Example.com",
      ]);
    } finally {
      await collisionDb.close();
    }
  });

  it("aborts, naming the colliding Instagram handles", async () => {
    const collisionDb = new PGlite();
    try {
      const schemaMigrationSql = readFileSync(
        path.resolve(__dirname, "../../../web/db/migrations/0019_crm_schema.sql"),
        "utf-8",
      );
      await collisionDb.exec(schemaMigrationSql);

      await collisionDb.query(
        `INSERT INTO crm_suppressions (instagram_handle, reason, created_by) VALUES ($1, $2, $3), ($4, $5, $6)`,
        ["@Bob", "first entry", "ops@tesserix.app", "bob", "second entry", "ops@tesserix.app"],
      );

      const normalizeMigrationSql = readFileSync(
        path.resolve(__dirname, "../../../web/db/migrations/0022_crm_suppressions_normalize.sql"),
        "utf-8",
      );

      await expect(collisionDb.exec(normalizeMigrationSql)).rejects.toThrow(
        /refuses to normalise crm_suppressions\.instagram_handle/,
      );
    } finally {
      await collisionDb.close();
    }
  });

  it("still applies cleanly when there is no collision — guards the guard", async () => {
    const cleanDb = new PGlite();
    try {
      const schemaMigrationSql = readFileSync(
        path.resolve(__dirname, "../../../web/db/migrations/0019_crm_schema.sql"),
        "utf-8",
      );
      await cleanDb.exec(schemaMigrationSql);
      await cleanDb.query(
        `INSERT INTO crm_suppressions (email, reason, created_by) VALUES ($1, $2, $3)`,
        ["Ava@Example.com", "unsubscribed", "ops@tesserix.app"],
      );

      const normalizeMigrationSql = readFileSync(
        path.resolve(__dirname, "../../../web/db/migrations/0022_crm_suppressions_normalize.sql"),
        "utf-8",
      );
      await expect(cleanDb.exec(normalizeMigrationSql)).resolves.not.toThrow();

      const rows = await cleanDb.query<{ email: string }>(
        `SELECT email FROM crm_suppressions`,
      );
      expect(rows.rows[0].email).toBe("ava@example.com");
    } finally {
      await cleanDb.close();
    }
  });
});

describe("listOrganisations", () => {
  let searchOrgA: string;
  let searchOrgB: string;

  beforeAll(async () => {
    const a = await db.query<{ id: string }>(
      `INSERT INTO crm_organisations (name, location) VALUES ($1, $2) RETURNING id`,
      ["Glebe Flowers", "Sydney"],
    );
    searchOrgA = a.rows[0].id;
    await db.query(
      `INSERT INTO crm_contacts (organisation_id, name, email, instagram_handle, is_primary)
       VALUES ($1, $2, $3, $4, true)`,
      [searchOrgA, "Priya Raman", "priya@glebeflowers.example", "glebeflowers"],
    );
    // Two opportunities: one open with a product, one lost. The count must
    // be 1 (lost is excluded) and products must list only non-null values.
    await db.query(
      `INSERT INTO crm_opportunities (organisation_id, stage, product)
       VALUES ($1, 'contacted', NULL), ($1, 'lost', 'mark8ly')`,
      [searchOrgA],
    );

    const b = await db.query<{ id: string }>(
      `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
      ["Unrelated Cafe"],
    );
    searchOrgB = b.rows[0].id;
  });

  it("returns organisations with their primary contact and open count", async () => {
    const page = await listOrganisations({ search: "Glebe Flowers" }, 50);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].id).toBe(searchOrgA);
    expect(page.rows[0].contactName).toBe("Priya Raman");
    expect(page.rows[0].location).toBe("Sydney");
    // The lost opportunity must not be counted — an operator browsing for
    // work should not see a closed deal inflate the number.
    expect(page.rows[0].openOpportunities).toBe(1);
    // The lost opportunity still carries a product, so it must appear here
    // even though it's excluded from openOpportunities above.
    expect(page.rows[0].products).toEqual(["mark8ly"]);
  });

  it("returns the primary contact's handle and the contact count", async () => {
    const page = await listOrganisations({ search: "Glebe Flowers" }, 50);
    expect(page.rows[0].contactHandle).toBe("glebeflowers");
    expect(page.rows[0].contactCount).toBeGreaterThanOrEqual(1);
  });

  it("returns an empty array, not null, when an organisation has no products", async () => {
    // Pins the `(row.products ?? []).filter(...)` coalesce: array_agg
    // returns raw NULL (not `[null]`) when nothing matches its FILTER, and
    // an unguarded coalesce miss would surface as `null` here instead.
    const page = await listOrganisations({ search: "Unrelated Cafe" }, 50);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].products).toEqual([]);
  });

  it("finds an organisation by its contact's email, not just by name", async () => {
    // The whole point of search: an imported lead is found by the handle or
    // address that came in the CSV, which is rarely the business name.
    const page = await listOrganisations({ search: "priya@glebeflowers" }, 50);
    expect(page.rows.map((r) => r.id)).toEqual([searchOrgA]);
  });

  it("finds an organisation by its contact's instagram handle", async () => {
    const page = await listOrganisations({ search: "glebeflowers" }, 50);
    expect(page.rows.map((r) => r.id)).toContain(searchOrgA);
  });

  it("returns one row per organisation even when several contacts match", async () => {
    // A join against contacts fans out. Without a DISTINCT/aggregate the
    // same organisation appears once per matching contact, which reads as
    // duplicate businesses.
    await db.query(
      `INSERT INTO crm_contacts (organisation_id, name, email)
       VALUES ($1, $2, $3)`,
      [searchOrgA, "Sam Ng", "sam@glebeflowers.example"],
    );
    const page = await listOrganisations({ search: "glebeflowers" }, 50);
    expect(page.rows.filter((r) => r.id === searchOrgA)).toHaveLength(1);
  });

  it("treats % and _ in search as literal characters", async () => {
    // Bound parameters stop injection but not LIKE wildcards: a bare "%"
    // would otherwise match every organisation.
    const page = await listOrganisations({ search: "%" }, 50);
    expect(page.rows).toHaveLength(0);
  });

  it("returns everything when no filter is given", async () => {
    const page = await listOrganisations({}, 50);
    expect(page.rows.map((r) => r.id)).toEqual(expect.arrayContaining([searchOrgA, searchOrgB]));
  });

  it("filters to only the organisations created by the given import batch", async () => {
    // crm_organisations.import_id is a FK to crm_imports, so the batch has
    // to exist for real, not just be a bare uuid string.
    const importResult = await db.query<{ id: string }>(
      `INSERT INTO crm_imports (filename, row_count, created_by) VALUES ($1, $2, $3) RETURNING id`,
      ["glebe-leads.csv", 1, "ops@tesserix.app"],
    );
    const importId = importResult.rows[0].id;

    const attached = await db.query<{ id: string }>(
      `INSERT INTO crm_organisations (name, import_id) VALUES ($1, $2) RETURNING id`,
      ["Imported From Glebe", importId],
    );
    const attachedId = attached.rows[0].id;

    // searchOrgA/searchOrgB (and the org above, without an import_id) must
    // not leak into the result — a wrong predicate here silently shows an
    // import result page every organisation instead of just its own batch.
    const page = await listOrganisations({ importId }, 50);
    expect(page.rows.map((r) => r.id)).toEqual([attachedId]);
  });

  // Task 1: total count and keyset pagination (#213 unreachable-past-100).
  describe("pagination", () => {
    let pagingOrgIds: string[];

    // Five organisations with distinct, explicit, ordered `created_at`
    // values, isolated from the other rows in this describe block (and the
    // top-level seed) by their own name filter — the assertions below need
    // to know exactly which rows and how many, which an unfiltered count
    // sharing the suite's other orgs would not give.
    beforeAll(async () => {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name, created_at)
         VALUES
           ('Pagination Org 1', $1::timestamptz),
           ('Pagination Org 2', $2::timestamptz),
           ('Pagination Org 3', $3::timestamptz),
           ('Pagination Org 4', $4::timestamptz),
           ('Pagination Org 5', $5::timestamptz)
         RETURNING id`,
        [daysAgo(5), daysAgo(4), daysAgo(3), daysAgo(2), daysAgo(1)],
      );
      // Oldest to newest, matching the INSERT order above — the query
      // itself returns newest-first (`ORDER BY created_at DESC`), so tests
      // below reverse this list where they need "row N by recency".
      pagingOrgIds = inserted.rows.map((r) => r.id);
    });

    it("returns a total that ignores the page limit", async () => {
      const page = await listOrganisations({ search: "Pagination Org" }, 2);
      expect(page.rows).toHaveLength(2);
      // The count an operator reads as "2 of 5" — it must reflect the whole
      // matching set, not the page, or the pager lies about how much is
      // left.
      expect(page.total).toBe(5);
    });

    it("pages forward without repeating or skipping a row", async () => {
      const first = await listOrganisations({ search: "Pagination Org" }, 2);
      const second = await listOrganisations(
        { search: "Pagination Org" },
        2,
        first.nextCursor ?? undefined,
      );
      const ids = [...first.rows, ...second.rows].map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      // Newest-first: page 1 is orgs 5 and 4, page 2 is orgs 3 and 2.
      expect(first.rows.map((r) => r.id)).toEqual([pagingOrgIds[4], pagingOrgIds[3]]);
      expect(second.rows.map((r) => r.id)).toEqual([pagingOrgIds[2], pagingOrgIds[1]]);
    });

    it("reports nextCursor null on the last page", async () => {
      const all = await listOrganisations({ search: "Pagination Org" }, 100);
      expect(all.nextCursor).toBeNull();
    });

    it("counts the filtered set, not the whole table", async () => {
      // A total that ignores the filter would tell the operator there are
      // (at least) 5 matches for a search returning 1.
      const page = await listOrganisations({ search: "Glebe Flowers" }, 50);
      expect(page.total).toBe(page.rows.length);
    });

    // The OFFSET failure keyset pagination exists to avoid: under OFFSET, a
    // row inserted between two page reads shifts every later page by one,
    // and the row pushed across the boundary is never seen. A row inserted
    // with a `created_at` of `now()` sorts newest-first and lands on PAGE
    // ONE, not between pages — it does not exercise that failure mode, so
    // this seeds the new row with an explicit `created_at` that falls
    // between paging-org 4 and paging-org 3, i.e. genuinely between the two
    // pages read below.
    it("does not skip a row inserted between pages, with a created_at between the two pages", async () => {
      const first = await listOrganisations({ search: "Pagination Org" }, 2);
      expect(first.rows.map((r) => r.id)).toEqual([pagingOrgIds[4], pagingOrgIds[3]]);

      const midCreatedAt = new Date(
        (new Date(daysAgo(3)).getTime() + new Date(daysAgo(2)).getTime()) / 2,
      ).toISOString();
      const insertedMid = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name, created_at) VALUES ($1, $2::timestamptz) RETURNING id`,
        ["Pagination Org Mid", midCreatedAt],
      );
      const midId = insertedMid.rows[0].id;

      const second = await listOrganisations(
        { search: "Pagination Org" },
        2,
        first.nextCursor ?? undefined,
      );
      expect(second.rows.map((r) => r.id)).toContain(midId);
    });

    // Fix round 1: nothing above catches `id` being dropped from the
    // keyset — every other fixture uses distinct `created_at` values, so a
    // tuple that silently degraded to `g.created_at < $cursorTs` alone would
    // still pass "pages forward without repeating" and the boundary test
    // (those only catch `<` vs `<=`). Production wrote 259 rows in one
    // migration batch, so two organisations sharing an identical
    // `created_at` is the normal case this design exists for, not an edge
    // one — this seeds exactly that and pages through one row at a time.
    it("uses id as a tiebreaker so two rows sharing an identical created_at are each returned exactly once", async () => {
      const sharedCreatedAt = daysAgo(10);
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name, created_at)
         VALUES ($1, $3::timestamptz), ($2, $3::timestamptz)
         RETURNING id`,
        ["Tiebreak Org A", "Tiebreak Org B", sharedCreatedAt],
      );
      const seededIds = new Set(inserted.rows.map((r) => r.id));

      const first = await listOrganisations({ search: "Tiebreak Org" }, 1);
      expect(first.rows).toHaveLength(1);
      // A `created_at`-only keyset (`id` dropped from both ORDER BY and the
      // predicate) would have no next page here — with two rows tied on the
      // only ordering column, Postgres could just as easily hand back the
      // same tied row twice as the "first" one.
      expect(first.nextCursor).not.toBeNull();

      const second = await listOrganisations(
        { search: "Tiebreak Org" },
        1,
        first.nextCursor ?? undefined,
      );
      expect(second.rows).toHaveLength(1);

      const seenIds = [first.rows[0].id, second.rows[0].id];
      // `<=` degrading from `<` would repeat the first row here; a bare `<`
      // on `created_at` alone (both rows tied) would exclude the second row
      // from every subsequent page — never seen at all. Either failure mode
      // is caught by asserting both seeded ids were returned, exactly once.
      expect(seenIds[0]).not.toBe(seenIds[1]);
      expect(new Set(seenIds)).toEqual(seededIds);
    });

    it("rejects a malformed cursor instead of coercing it into a query", async () => {
      await expect(
        listOrganisations({ search: "Pagination Org" }, 2, "not-a-real-cursor"),
      ).rejects.toThrow();
    });
  });

  // Task 5: product/country/followers/email predicates. Seeded in its own
  // describe block, isolated by name filters where needed, so assertions
  // below know exactly which rows and how many are in play.
  describe("filters", () => {
    let mark8lyOrgId: string;
    let unassignedOrgId: string;
    let chennaiOrgId: string;
    let keralaOrgId: string;
    let mumbaiOrgId: string;
    let australiaOrgId: string;
    let noLocationOrgId: string;
    let bigCreatorOrgId: string;
    let nullFollowersOrgId: string;
    let emailOrgId: string;
    let nonPrimaryEmailOrgId: string;

    beforeAll(async () => {
      const mark8ly = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
        ["Filter Test Mark8ly Org"],
      );
      mark8lyOrgId = mark8ly.rows[0].id;
      await db.query(
        `INSERT INTO crm_opportunities (organisation_id, stage, product) VALUES ($1, 'new', 'mark8ly')`,
        [mark8lyOrgId],
      );

      const unassigned = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
        ["Filter Test Unassigned Org"],
      );
      unassignedOrgId = unassigned.rows[0].id;
      await db.query(
        `INSERT INTO crm_opportunities (organisation_id, stage, product) VALUES ($1, 'new', NULL)`,
        [unassignedOrgId],
      );

      const chennai = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name, location, country) VALUES ($1, $2, $3) RETURNING id`,
        ["Filter Test Chennai Org", "Chennai", "IN"],
      );
      chennaiOrgId = chennai.rows[0].id;

      const kerala = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name, location, country) VALUES ($1, $2, $3) RETURNING id`,
        ["Filter Test Kerala Org", "Kerala", "IN"],
      );
      keralaOrgId = kerala.rows[0].id;

      const mumbai = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name, location, country) VALUES ($1, $2, $3) RETURNING id`,
        ["Filter Test Mumbai Org", "Mumbai, Maharashtra", "IN"],
      );
      mumbaiOrgId = mumbai.rows[0].id;

      const australia = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name, location, country) VALUES ($1, $2, $3) RETURNING id`,
        ["Filter Test Australia Org", "Australia", "AU"],
      );
      australiaOrgId = australia.rows[0].id;

      const noLocation = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
        ["Filter Test No Location Org"],
      );
      noLocationOrgId = noLocation.rows[0].id;

      const bigCreator = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
        ["Filter Test Big Creator Org"],
      );
      bigCreatorOrgId = bigCreator.rows[0].id;
      await db.query(
        `INSERT INTO crm_contacts (organisation_id, name, is_primary, followers_count)
         VALUES ($1, $2, true, $3)`,
        [bigCreatorOrgId, "Big Creator", 15000],
      );

      const nullFollowers = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
        ["Filter Test Null Followers Org"],
      );
      nullFollowersOrgId = nullFollowers.rows[0].id;
      await db.query(
        `INSERT INTO crm_contacts (organisation_id, name, is_primary, followers_count)
         VALUES ($1, $2, true, NULL)`,
        [nullFollowersOrgId, "Unmeasured Contact"],
      );

      const emailOrg = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
        ["Filter Test Email Org"],
      );
      emailOrgId = emailOrg.rows[0].id;
      await db.query(
        `INSERT INTO crm_contacts (organisation_id, name, is_primary, email)
         VALUES ($1, $2, true, $3)`,
        [emailOrgId, "Has Email Contact", "filtertest@example.com"],
      );

      // Primary contact has no email; a second, non-primary contact does.
      // The displayed contactEmail comes from the primary contact only, so
      // hasEmail must not match here — matching would filter for
      // "reachable by email" and hand back a row with a blank email column.
      const nonPrimaryEmailOrg = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
        ["Filter Test Non-Primary Email Org"],
      );
      nonPrimaryEmailOrgId = nonPrimaryEmailOrg.rows[0].id;
      await db.query(
        `INSERT INTO crm_contacts (organisation_id, name, is_primary, email)
         VALUES ($1, $2, true, NULL)`,
        [nonPrimaryEmailOrgId, "Primary No Email"],
      );
      await db.query(
        `INSERT INTO crm_contacts (organisation_id, name, is_primary, email)
         VALUES ($1, $2, false, $3)`,
        [nonPrimaryEmailOrgId, "Secondary Has Email", "secondary@example.com"],
      );
    });

    it("matches an organisation by a product on any of its opportunities", async () => {
      // product lives on the opportunity, and an org may have several — so
      // this is an EXISTS, never a join that would duplicate the org row.
      const page = await listOrganisations({ product: "mark8ly" }, 50);
      expect(page.rows.map((r) => r.id)).toContain(mark8lyOrgId);
      expect(page.rows.map((r) => r.id)).not.toContain(unassignedOrgId);
    });

    it("matches unassigned organisations on the shared sentinel", async () => {
      // Every migrated lead is unassigned today — this is the most-used
      // option, not an edge case.
      const page = await listOrganisations({ product: UNASSIGNED_PRODUCT }, 50);
      expect(page.rows.map((r) => r.id)).toContain(unassignedOrgId);
      expect(page.rows.map((r) => r.id)).not.toContain(mark8lyOrgId);
    });

    it("returns one row per organisation when several opportunities match", async () => {
      // Two mark8ly opportunities on one org must not render it twice.
      await db.query(
        `INSERT INTO crm_opportunities (organisation_id, stage, product) VALUES ($1, 'new', 'mark8ly')`,
        [mark8lyOrgId],
      );
      const page = await listOrganisations({ product: "mark8ly" }, 50);
      expect(page.rows.filter((r) => r.id === mark8lyOrgId)).toHaveLength(1);
    });

    it("matches organisations by derived country, across location granularities", async () => {
      // The point of the derived column: "Chennai", "Kerala" and "Mumbai,
      // Maharashtra" are one country and must come back together, which no
      // substring match on the raw location could do.
      const page = await listOrganisations({ country: "IN" }, 50);
      const ids = page.rows.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([chennaiOrgId, keralaOrgId, mumbaiOrgId]));
      expect(ids).not.toContain(australiaOrgId);
    });

    it("excludes organisations whose country could not be derived", async () => {
      // Most rows have no location at all. They must not fall into some
      // default country and be read as leads in a market they are not in.
      const page = await listOrganisations({ country: "IN" }, 50);
      expect(page.rows.map((r) => r.id)).not.toContain(noLocationOrgId);
    });

    it("filters by follower band on the primary contact", async () => {
      // Scoped with `search`, like the hasEmail tests below: an unscoped
      // over10k query also matches fixtures other describe blocks in this
      // file seed (the queue's own country/follower-band coverage), and
      // this test's `toEqual` is only meaningful against this block's own
      // fixtures.
      const page = await listOrganisations({ followers: "over10k", search: "Filter Test" }, 50);
      expect(page.rows.map((r) => r.id)).toEqual([bigCreatorOrgId]);
    });

    it("excludes unknown follower counts from every band", async () => {
      // A contact with no follower count must not silently land in the
      // lowest band and be read as a qualified-out lead.
      const page = await listOrganisations({ followers: "under1k" }, 50);
      expect(page.rows.map((r) => r.id)).not.toContain(nullFollowersOrgId);
    });

    it("filters to organisations whose contact has an email", async () => {
      // Scoped to this describe block's fixtures with `search` — the suite
      // seeds another organisation with an emailed contact (Glebe Flowers)
      // earlier in the file, and hasEmail alone would catch that too.
      const page = await listOrganisations({ hasEmail: true, search: "Filter Test" }, 50);
      expect(page.rows.map((r) => r.id)).toEqual([emailOrgId]);
    });

    it("does not match on a non-primary contact's email", async () => {
      // hasEmail is bound to the primary contact, mirroring followers — an
      // org whose only emailed contact is non-primary must be excluded, or
      // the operator gets a row back with a blank email column.
      const page = await listOrganisations({ hasEmail: true, search: "Filter Test" }, 50);
      expect(page.rows.map((r) => r.id)).not.toContain(nonPrimaryEmailOrgId);
    });

    it("composes filters", async () => {
      const page = await listOrganisations({ product: UNASSIGNED_PRODUCT, hasEmail: true }, 50);
      expect(page.total).toBe(page.rows.length);
    });

    it("counts the filtered set when filters compose", async () => {
      // The count query and the page query must build their predicate from
      // the same helper — a hand-copied second predicate is how a pager
      // starts lying.
      const page = await listOrganisations({ country: "IN" }, 1);
      expect(page.total).toBe(3);
    });
  });

  // `crm_contacts.created_at` is not unique — an import writes a batch of
  // contacts in one transaction, sharing it exactly. Without a total order,
  // each of the subqueries that picks "the primary contact" breaks such a tie
  // independently, so the followers/hasEmail filter can match on one contact
  // while the row on screen displays another. Only a real database with a
  // real tie tells the two apart; a shape assertion on the SQL cannot.
  describe("a tie on contact created_at resolves to the same contact everywhere", () => {
    let tiedOrgId: string;
    // Explicit, ordered UUIDs rather than the column default: the contacts
    // must sort deterministically on `id` alone, and a generated UUID has no
    // guaranteed relationship to insertion order. "...001" sorts first, so
    // it is the primary contact whenever the tiebreaker is in play.
    const primaryContactId = "00000000-0000-0000-0000-000000000001";
    const otherContactId = "00000000-0000-0000-0000-000000000002";
    const primaryName = "Tied Contact A";
    const primaryFollowers = 20000;
    const primaryHasEmail = true;

    beforeAll(async () => {
      const org = await db.query<{ id: string }>(
        `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
        ["Tied Contacts Org"],
      );
      tiedOrgId = org.rows[0].id;

      // Identical created_at, neither flagged primary, so only the id
      // tiebreaker can decide. Follower bands and email presence are set to
      // disagree between the two, so picking the wrong one is observable.
      //
      // The row that should win the tie (`primaryContactId`, "...001") is
      // inserted SECOND, after the row that should lose ("...002"). That's
      // deliberate: without an `ORDER BY id`, a sequential scan tends to
      // return ties in physical/insertion order, so an insertion order that
      // happened to match id order would let this test pass by accident even
      // with `, c.id ASC` stripped from `primaryContactOrder()`. Inserting
      // out of id order means the two orderings disagree on the winner,
      // which is what makes the id tiebreaker's absence observable.
      const sharedCreatedAt = daysAgo(5);
      await db.query(
        `INSERT INTO crm_contacts (id, organisation_id, name, is_primary, followers_count, email, created_at)
         VALUES ($7, $2, 'Tied Contact B', false, 500, NULL, $6::timestamptz),
                ($1, $2, $3, false, $4, $5, $6::timestamptz)`,
        [
          primaryContactId,
          tiedOrgId,
          primaryName,
          primaryFollowers,
          "tied@example.com",
          sharedCreatedAt,
          otherContactId,
        ],
      );
    });

    it("displays the same contact the follower filter matched on", async () => {
      const page = await listOrganisations({ search: "Tied Contacts Org" }, 50);
      expect(page.rows.map((r) => r.id)).toEqual([tiedOrgId]);
      expect(page.rows[0].contactName).toBe(primaryName);

      const matchingBand = primaryFollowers >= 10000 ? "over10k" : "under1k";
      const otherBand = matchingBand === "over10k" ? "under1k" : "over10k";
      const matched = await listOrganisations(
        { search: "Tied Contacts Org", followers: matchingBand },
        50,
      );
      expect(matched.rows.map((r) => r.id)).toEqual([tiedOrgId]);
      const excluded = await listOrganisations(
        { search: "Tied Contacts Org", followers: otherBand },
        50,
      );
      expect(excluded.rows.map((r) => r.id)).toEqual([]);
    });

    it("agrees with the hasEmail filter about which contact is primary", async () => {
      const page = await listOrganisations({ search: "Tied Contacts Org", hasEmail: true }, 50);
      expect(page.rows.map((r) => r.id)).toEqual(primaryHasEmail ? [tiedOrgId] : []);
    });
  });

  // Keyset pagination carries no page number, so the surface's "101–200 of
  // 259" range comes from the repo counting the rows ahead of the cursor —
  // not from a `?page=` param an operator could edit into a range the page
  // hasn't got.
  describe("precedingCount", () => {
    it("is 0 on the first page and counts the rows already paged past on the next", async () => {
      const first = await listOrganisations({ search: "Pagination Org" }, 2);
      expect(first.precedingCount).toBe(0);
      expect(first.nextCursor).not.toBeNull();

      const second = await listOrganisations(
        { search: "Pagination Org" },
        2,
        first.nextCursor ?? undefined,
      );
      expect(second.precedingCount).toBe(first.rows.length);
      expect(second.total).toBe(first.total);
    });
  });
});

// `organisationDetail`'s contact list uses `primaryContactOrder` — the same
// helper the list page and its filters use — so the head of the list agrees
// with what those queries call "the primary contact". That much is required
// for consistency (Ruling covered by the tie test above). Ordering the
// *tail* the same way — oldest-first for every non-primary contact, not just
// the head — is a separate, deliberate choice: one shared ordering for the
// whole helper rather than a special case for the detail page. Nothing
// enforced either choice before this test, so a future edit to
// `primaryContactOrder` or to this query would change the detail page's
// contact order silently.
describe("organisationDetail orders contacts is_primary, then created_at, then id", () => {
  it("lists contacts flagged-primary first, then oldest first, with id breaking ties", async () => {
    const org = await db.query<{ id: string }>(
      `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
      ["Detail Order Org"],
    );
    const detailOrgId = org.rows[0].id;

    const oldest = daysAgo(30);
    const middle = daysAgo(10);
    // The flagged-primary contact is the newest of the three by created_at —
    // if the query ordered by created_at alone (ignoring is_primary), it
    // would sort last instead of first.
    const newest = daysAgo(1);

    await db.query(
      `INSERT INTO crm_contacts (id, organisation_id, name, is_primary, created_at)
       VALUES
         ('10000000-0000-0000-0000-000000000002', $1, 'Oldest, id 2', false, $2::timestamptz),
         ('10000000-0000-0000-0000-000000000001', $1, 'Oldest, id 1', false, $2::timestamptz),
         ('10000000-0000-0000-0000-000000000003', $1, 'Middle', false, $3::timestamptz),
         ('10000000-0000-0000-0000-000000000004', $1, 'Flagged Primary', true, $4::timestamptz)`,
      [detailOrgId, oldest, middle, newest],
    );

    const detail = await organisationDetail(detailOrgId);

    expect(detail?.contacts.map((c) => c.name)).toEqual([
      "Flagged Primary",
      "Oldest, id 1",
      "Oldest, id 2",
      "Middle",
    ]);
  });
});

/**
 * The ordering tiebreak, and the paginated shape built on top of it.
 *
 * Declared last in the file deliberately: its `beforeAll` seeds more queue
 * rows, and several describes above assert an exact due/drifting set from
 * the top-level seed alone. Vitest runs a file's describes — and their
 * `beforeAll`s — in declaration order, so seeding here cannot disturb them.
 * (That guarantee does not hold under `--sequence.shuffle`; see the note on
 * the `dueOpportunities against a real database` describe.)
 *
 * Every row seeded here carries its own product so each assertion can filter
 * to exactly its own fixture.
 */
describe("queue ordering breaks ties on id", () => {
  let tieOrgId: string;

  // Four rows sharing one identical sort timestamp, INSERTed in descending
  // id order. Without `, o.id ASC` Postgres sorts on the tied key alone,
  // finds the input already "sorted", and hands back insertion order — i.e.
  // descending ids, the reverse of what the tiebreak specifies. That is what
  // makes this test discriminate rather than merely restate the query.
  beforeAll(async () => {
    const org = await db.query<{ id: string }>(
      `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
      ["Tiebreak Queue Org"],
    );
    tieOrgId = org.rows[0].id;

    await db.query(
      `INSERT INTO crm_opportunities
         (id, organisation_id, stage, product, next_action_at, last_contacted_at, created_at)
       VALUES
         ('dddddddd-dddd-dddd-dddd-000000000004', $1, 'new', 'drift-tie', NULL, NULL, $2::timestamptz),
         ('dddddddd-dddd-dddd-dddd-000000000003', $1, 'new', 'drift-tie', NULL, NULL, $2::timestamptz),
         ('dddddddd-dddd-dddd-dddd-000000000002', $1, 'new', 'drift-tie', NULL, NULL, $2::timestamptz),
         ('dddddddd-dddd-dddd-dddd-000000000001', $1, 'new', 'drift-tie', NULL, NULL, $2::timestamptz)`,
      [tieOrgId, daysAgo(120)],
    );

    await db.query(
      `INSERT INTO crm_opportunities
         (id, organisation_id, stage, product, next_action_at, last_contacted_at, created_at)
       VALUES
         ('eeeeeeee-eeee-eeee-eeee-000000000004', $1, 'new', 'due-tie', $2::timestamptz, NULL, $2::timestamptz),
         ('eeeeeeee-eeee-eeee-eeee-000000000003', $1, 'new', 'due-tie', $2::timestamptz, NULL, $2::timestamptz),
         ('eeeeeeee-eeee-eeee-eeee-000000000002', $1, 'new', 'due-tie', $2::timestamptz, NULL, $2::timestamptz),
         ('eeeeeeee-eeee-eeee-eeee-000000000001', $1, 'new', 'due-tie', $2::timestamptz, NULL, $2::timestamptz)`,
      [tieOrgId, daysAgo(120)],
    );
  });

  it("orders drifting rows sharing a quiet_since by ascending id", async () => {
    const { rows } = await driftingOpportunities({ product: "drift-tie" }, 14, 50);
    expect(rows.map((r) => r.id)).toEqual([
      "dddddddd-dddd-dddd-dddd-000000000001",
      "dddddddd-dddd-dddd-dddd-000000000002",
      "dddddddd-dddd-dddd-dddd-000000000003",
      "dddddddd-dddd-dddd-dddd-000000000004",
    ]);
  });

  it("orders due rows sharing a next_action_at by ascending id", async () => {
    const { rows } = await dueOpportunities({ product: "due-tie" }, 50);
    expect(rows.map((r) => r.id)).toEqual([
      "eeeeeeee-eeee-eeee-eeee-000000000001",
      "eeeeeeee-eeee-eeee-eeee-000000000002",
      "eeeeeeee-eeee-eeee-eeee-000000000003",
      "eeeeeeee-eeee-eeee-eeee-000000000004",
    ]);
  });
});

/**
 * The defect this change exists for: a queue that returns a bare capped page
 * tells the operator nothing about what it left behind. Production holds 259
 * organisations, every one of them drifting, against a limit of 100 — 159
 * rows silently absent with no count and no truncation notice.
 *
 * A three-row fixture cannot show that. These seed more rows than one page
 * and page all the way through, with the timestamp spread production
 * actually has: a handful of distinct values, five rows tied on each.
 */
describe("queue pagination over more rows than fit on a page", () => {
  const DRIFT_ROWS = 25;
  const DUE_ROWS = 12;
  let pageOrgId: string;

  const driftId = (n: number) =>
    `cccccccc-cccc-cccc-cccc-${String(n).padStart(12, "0")}`;
  const dueId = (n: number) =>
    `bbbbbbbb-bbbb-bbbb-bbbb-${String(n).padStart(12, "0")}`;

  beforeAll(async () => {
    const org = await db.query<{ id: string }>(
      `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
      ["Paged Queue Org"],
    );
    pageOrgId = org.rows[0].id;

    // Five distinct created_at values, five rows tied on each — the shape
    // one migration batch leaves behind, and the shape a cursor without a
    // tiebreak cannot page through correctly.
    const driftValues = Array.from({ length: DRIFT_ROWS }, (_, i) => {
      const bucket = Math.floor(i / 5);
      return `('${driftId(i + 1)}', $1, 'new', 'drift-page', NULL, NULL, $${bucket + 2}::timestamptz)`;
    }).join(",\n         ");
    await db.query(
      `INSERT INTO crm_opportunities
         (id, organisation_id, stage, product, next_action_at, last_contacted_at, created_at)
       VALUES
         ${driftValues}`,
      [pageOrgId, daysAgo(60), daysAgo(59), daysAgo(58), daysAgo(57), daysAgo(56)],
    );

    // Four distinct next_action_at values, three rows tied on each.
    const dueValues = Array.from({ length: DUE_ROWS }, (_, i) => {
      const bucket = Math.floor(i / 3);
      return `('${dueId(i + 1)}', $1, 'new', 'due-page', $${bucket + 2}::timestamptz, NULL, $2::timestamptz)`;
    }).join(",\n         ");
    await db.query(
      `INSERT INTO crm_opportunities
         (id, organisation_id, stage, product, next_action_at, last_contacted_at, created_at)
       VALUES
         ${dueValues}`,
      [pageOrgId, daysAgo(40), daysAgo(39), daysAgo(38), daysAgo(37)],
    );
  });

  it("reports the whole matching set as total, not the page size", async () => {
    // The number the operator is being told. Reporting 10 here is the bug:
    // it reads as "that is all of them".
    const page = await driftingOpportunities({ product: "drift-page" }, 14, 10);
    expect(page.rows).toHaveLength(10);
    expect(page.total).toBe(DRIFT_ROWS);
  });

  it("does not repeat the last row of page one on page two, nor skip between them", async () => {
    const first = await driftingOpportunities({ product: "drift-page" }, 14, 10);
    const second = await driftingOpportunities(
      { product: "drift-page" },
      14,
      10,
      first.nextCursor ?? undefined,
    );
    const firstIds = first.rows.map((r) => r.id);
    const secondIds = second.rows.map((r) => r.id);
    expect(secondIds).not.toContain(firstIds[firstIds.length - 1]);
    // Consecutive by the query's own order: page two starts exactly where
    // page one stopped. A skipped row would leave a gap here.
    expect([...firstIds, ...secondIds]).toEqual(
      Array.from({ length: 20 }, (_, i) => driftId(i + 1)),
    );
  });

  it("pages through to the end and yields exactly `total` distinct rows", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let total = 0;
    // Bounded so a cursor that fails to advance fails the test instead of
    // hanging the suite.
    for (let guard = 0; guard < 10; guard += 1) {
      const page: {
        rows: { id: string }[];
        total: number;
        nextCursor: string | null;
      } = await driftingOpportunities({ product: "drift-page" }, 14, 10, cursor);
      total = page.total;
      seen.push(...page.rows.map((r) => r.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(total);
    expect(new Set(seen)).toEqual(
      new Set(Array.from({ length: DRIFT_ROWS }, (_, i) => driftId(i + 1))),
    );
  });

  it("reports nextCursor null only on the last page", async () => {
    const partial = await driftingOpportunities({ product: "drift-page" }, 14, 10);
    expect(partial.nextCursor).not.toBeNull();
    const all = await driftingOpportunities({ product: "drift-page" }, 14, 100);
    expect(all.nextCursor).toBeNull();
    // limit + 1 must be dropped, not handed back as an extra row.
    expect(all.rows).toHaveLength(DRIFT_ROWS);
  });

  it("counts the rows already paged past as precedingCount", async () => {
    const first = await driftingOpportunities({ product: "drift-page" }, 14, 10);
    expect(first.precedingCount).toBe(0);
    const second = await driftingOpportunities(
      { product: "drift-page" },
      14,
      10,
      first.nextCursor ?? undefined,
    );
    expect(second.precedingCount).toBe(10);
    expect(second.total).toBe(DRIFT_ROWS);
  });

  it("pages the due queue the same way, with a total that ignores the limit", async () => {
    const first = await dueOpportunities({ product: "due-page" }, 5);
    expect(first.total).toBe(DUE_ROWS);
    expect(first.rows).toHaveLength(5);

    const seen: string[] = [...first.rows.map((r) => r.id)];
    let cursor = first.nextCursor;
    for (let guard = 0; guard < 10 && cursor !== null; guard += 1) {
      const page = await dueOpportunities({ product: "due-page" }, 5, cursor);
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(DUE_ROWS);
    expect(seen).toEqual(Array.from({ length: DUE_ROWS }, (_, i) => dueId(i + 1)));
  });

  it("counts the filtered set, not every drifting row in the table", async () => {
    // A total ignoring the filter would tell the operator there is more
    // behind a filter than the filter can ever return.
    const page = await driftingOpportunities({ product: "drift-tie" }, 14, 10);
    expect(page.total).toBe(4);
  });

  it("rejects a malformed cursor instead of silently returning page one", async () => {
    // Silently falling back to page one is the same class of defect as the
    // truncation this change fixes: the surface reports success while
    // showing something other than what was asked for.
    await expect(
      driftingOpportunities({ product: "drift-page" }, 14, 10, "not-a-real-cursor"),
    ).rejects.toThrow();
    await expect(
      dueOpportunities({ product: "due-page" }, 5, "not-a-real-cursor"),
    ).rejects.toThrow();
  });

  it("rejects a cursor whose id is not a uuid, even with a valid timestamp", async () => {
    const forged = Buffer.from(
      `${new Date().toISOString()}|1 OR 1=1`,
      "utf-8",
    ).toString("base64");
    await expect(
      driftingOpportunities({ product: "drift-page" }, 14, 10, forged),
    ).rejects.toThrow();
  });
});

/**
 * Paging BACKWARDS, against a real database.
 *
 * Everything here asserts a SEQUENCE of ids, never a set. A backward page is
 * fetched with the ORDER BY flipped, so the rows arrive reversed and have to
 * be re-reversed before they are returned; every set-equality assertion in
 * this file would pass with that step missing. The fixtures keep the tied
 * timestamps the forward tests use, because a tie-break that is wrong only in
 * one direction is invisible until something pages back through it.
 */
describe("paging backwards through the queues", () => {
  const DRIFT_PAGE = 10;
  const driftIds = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) =>
      `cccccccc-cccc-cccc-cccc-${String(from + i).padStart(12, "0")}`);

  it("returns the previous page in display order, not in the order it was fetched", async () => {
    const first = await driftingOpportunities({ product: "drift-page" }, 14, DRIFT_PAGE);
    const second = await driftingOpportunities(
      { product: "drift-page" }, 14, DRIFT_PAGE, first.nextCursor ?? undefined);
    const third = await driftingOpportunities(
      { product: "drift-page" }, 14, DRIFT_PAGE, second.nextCursor ?? undefined);

    const back = await driftingOpportunities(
      { product: "drift-page" }, 14, DRIFT_PAGE, third.previousCursor ?? undefined);
    // Page two, oldest-quiet first — exactly as paging forward rendered it.
    expect(back.rows.map((r) => r.id)).toEqual(driftIds(11, 20));
    expect(back.precedingCount).toBe(10);
    expect(back.total).toBe(25);
  });

  it("round trips: forward to page three, back to page one, same rows in the same order", async () => {
    const first = await driftingOpportunities({ product: "drift-page" }, 14, DRIFT_PAGE);
    const second = await driftingOpportunities(
      { product: "drift-page" }, 14, DRIFT_PAGE, first.nextCursor ?? undefined);
    const third = await driftingOpportunities(
      { product: "drift-page" }, 14, DRIFT_PAGE, second.nextCursor ?? undefined);
    const backToTwo = await driftingOpportunities(
      { product: "drift-page" }, 14, DRIFT_PAGE, third.previousCursor ?? undefined);
    const backToOne = await driftingOpportunities(
      { product: "drift-page" }, 14, DRIFT_PAGE, backToTwo.previousCursor ?? undefined);

    expect(backToOne.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
    expect(backToOne.precedingCount).toBe(0);
    // Back at the start, so there is nothing before it — and a page ahead.
    expect(backToOne.previousCursor).toBeNull();
    expect(backToOne.nextCursor).not.toBeNull();
  });

  it("offers no previous cursor on page one, and no next cursor on the last page", async () => {
    const first = await driftingOpportunities({ product: "drift-page" }, 14, DRIFT_PAGE);
    expect(first.previousCursor).toBeNull();
    expect(first.nextCursor).not.toBeNull();

    const last = await driftingOpportunities(
      { product: "drift-page" }, 14, DRIFT_PAGE,
      (await driftingOpportunities(
        { product: "drift-page" }, 14, DRIFT_PAGE,
        first.nextCursor ?? undefined)).nextCursor ?? undefined);
    expect(last.rows).toHaveLength(5);
    expect(last.nextCursor).toBeNull();
    expect(last.previousCursor).not.toBeNull();
  });

  it("offers neither cursor when the whole result fits on one page", async () => {
    const all = await driftingOpportunities({ product: "drift-page" }, 14, 100);
    expect(all.rows).toHaveLength(25);
    expect(all.nextCursor).toBeNull();
    expect(all.previousCursor).toBeNull();
  });

  it("pages the due queue back the same way", async () => {
    const dueIdsFrom = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) =>
        `bbbbbbbb-bbbb-bbbb-bbbb-${String(from + i).padStart(12, "0")}`);
    const first = await dueOpportunities({ product: "due-page" }, 5);
    const second = await dueOpportunities(
      { product: "due-page" }, 5, first.nextCursor ?? undefined);
    const back = await dueOpportunities(
      { product: "due-page" }, 5, second.previousCursor ?? undefined);
    expect(second.rows.map((r) => r.id)).toEqual(dueIdsFrom(6, 10));
    expect(back.rows.map((r) => r.id)).toEqual(dueIdsFrom(1, 5));
    expect(back.precedingCount).toBe(0);
  });

  it("crosses a tie in the same place going back as going forward", async () => {
    // Five rows share each created_at, and the page boundary at 10 falls in
    // the middle of the third tied group. Paging back across it must split
    // the tie on `id` exactly where the forward read did, or a tied row is
    // either shown twice or never shown at all.
    const first = await driftingOpportunities({ product: "drift-page" }, 14, 12);
    const second = await driftingOpportunities(
      { product: "drift-page" }, 14, 12, first.nextCursor ?? undefined);
    const back = await driftingOpportunities(
      { product: "drift-page" }, 14, 12, second.previousCursor ?? undefined);
    expect(first.rows.map((r) => r.id)).toEqual(driftIds(1, 12));
    expect(second.rows.map((r) => r.id)).toEqual(driftIds(13, 24));
    expect(back.rows.map((r) => r.id)).toEqual(driftIds(1, 12));
  });
});

describe("paging backwards through listOrganisations", () => {
  // Its own fixture: six rows, three pairs sharing a created_at, so every
  // page boundary at an even limit falls inside a tie. The browse surface
  // reads newest-first, so display order is the reverse of the insert order
  // below.
  let backIds: string[];

  beforeAll(async () => {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO crm_organisations (name, created_at)
       VALUES ('Backward Org 1', $1::timestamptz),
              ('Backward Org 2', $1::timestamptz),
              ('Backward Org 3', $2::timestamptz),
              ('Backward Org 4', $2::timestamptz),
              ('Backward Org 5', $3::timestamptz),
              ('Backward Org 6', $3::timestamptz)
       RETURNING id`,
      [daysAgo(30), daysAgo(29), daysAgo(28)],
    );
    backIds = inserted.rows.map((r) => r.id);
  });

  /** The six rows as the surface displays them: newest first. */
  const displayed = async () =>
    (await listOrganisations({ search: "Backward Org" }, 100)).rows.map((r) => r.id);

  it("returns the previous page in display order, not in the order it was fetched", async () => {
    const order = await displayed();
    const first = await listOrganisations({ search: "Backward Org" }, 2);
    const second = await listOrganisations(
      { search: "Backward Org" }, 2, first.nextCursor ?? undefined);
    const third = await listOrganisations(
      { search: "Backward Org" }, 2, second.nextCursor ?? undefined);
    const back = await listOrganisations(
      { search: "Backward Org" }, 2, third.previousCursor ?? undefined);

    expect(back.rows.map((r) => r.id)).toEqual(order.slice(2, 4));
    expect(back.precedingCount).toBe(2);
    expect(back.total).toBe(6);
  });

  it("round trips: forward to page three, back to page one, same rows in the same order", async () => {
    const first = await listOrganisations({ search: "Backward Org" }, 2);
    const second = await listOrganisations(
      { search: "Backward Org" }, 2, first.nextCursor ?? undefined);
    const third = await listOrganisations(
      { search: "Backward Org" }, 2, second.nextCursor ?? undefined);
    const backToTwo = await listOrganisations(
      { search: "Backward Org" }, 2, third.previousCursor ?? undefined);
    const backToOne = await listOrganisations(
      { search: "Backward Org" }, 2, backToTwo.previousCursor ?? undefined);

    expect(backToOne.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
    expect(backToOne.precedingCount).toBe(0);
    expect(backToOne.previousCursor).toBeNull();
  });

  it("splits a tied created_at in the same place in both directions", async () => {
    // Every pair shares a created_at, so a page of 3 cuts through the middle
    // of a tie. Only `id` decides where — and it has to decide the same way
    // backwards, or a tied row is repeated or lost.
    const order = await displayed();
    const first = await listOrganisations({ search: "Backward Org" }, 3);
    const second = await listOrganisations(
      { search: "Backward Org" }, 3, first.nextCursor ?? undefined);
    const back = await listOrganisations(
      { search: "Backward Org" }, 3, second.previousCursor ?? undefined);
    expect(first.rows.map((r) => r.id)).toEqual(order.slice(0, 3));
    expect(second.rows.map((r) => r.id)).toEqual(order.slice(3, 6));
    expect(back.rows.map((r) => r.id)).toEqual(order.slice(0, 3));
    expect(backIds).toHaveLength(6);
  });

  it("offers neither cursor when the whole result fits on one page", async () => {
    const all = await listOrganisations({ search: "Backward Org" }, 100);
    expect(all.nextCursor).toBeNull();
    expect(all.previousCursor).toBeNull();
  });
});
