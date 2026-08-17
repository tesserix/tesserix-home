import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const { dueOpportunities, driftingOpportunities } = await import(
  "./crm-repo"
);

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
    const rows = await driftingOpportunities(14, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("11111111-1111-1111-1111-111111111111");
  });

  it("excludes any row with a next_action_at set, however stale", async () => {
    const rows = await driftingOpportunities(14, 50);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("44444444-4444-4444-4444-444444444444");
  });

  it("returns exactly the two stale rows, ordered most-overdue-first by quietSince", async () => {
    const rows = await driftingOpportunities(14, 50);
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
    const rows = await driftingOpportunities(14, 50);
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
  it("returns only the overdue, non-terminal opportunity", async () => {
    const rows = await dueOpportunities(50);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(["55555555-5555-5555-5555-555555555555"]);
  });
});
