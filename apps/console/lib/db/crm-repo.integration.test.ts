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

const { dueOpportunities, driftingOpportunities, isSuppressed, addSuppression, listOrganisations } =
  await import("./crm-repo");

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
    const rows = await driftingOpportunities({}, 14, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("11111111-1111-1111-1111-111111111111");
  });

  it("excludes any row with a next_action_at set, however stale", async () => {
    const rows = await driftingOpportunities({}, 14, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("44444444-4444-4444-4444-444444444444");
  });

  it("returns exactly the two stale rows, ordered most-overdue-first by quietSince", async () => {
    const rows = await driftingOpportunities({}, 14, 50);
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
    const rows = await driftingOpportunities({}, 14, 50);
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
    const rows = await dueOpportunities({}, 50);
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
    const unfiltered = await dueOpportunities({}, 2);
    expect(unfiltered.map((r) => r.id)).not.toContain(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );

    const filtered = await dueOpportunities({ product: "kora" }, 2);
    expect(filtered.map((r) => r.id)).toEqual([
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    ]);
  });

  it("binds product/stage/owner filters against driftingOpportunities the same way", async () => {
    const rows = await driftingOpportunities({ product: "kora" }, 14, 50);
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
    const rows = await dueOpportunities({ owner: "%" }, 50);
    // The due set (top-level seed) has exactly one owned row ("Asha Rao"),
    // plus whatever the sibling describe above seeded with no owner set. An
    // unescaped "%" would return all of them; escaped, "%" has no literal
    // match and the filter returns nothing.
    expect(rows).toEqual([]);
  });

  it("still matches a literal substring once escaped", async () => {
    const rows = await dueOpportunities({ owner: "Asha" }, 50);
    expect(rows.map((r) => r.id)).toEqual([
      "55555555-5555-5555-5555-555555555555",
    ]);
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
      const page = await listOrganisations({ followers: "over10k" }, 50);
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
});
