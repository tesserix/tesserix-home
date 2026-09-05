import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Schema-only coverage for 0049_crm_opportunities_voided.sql, against real
 * (in-process) Postgres via pglite.
 *
 * Everything asserted here is enforced by Postgres and by nothing else — a
 * column's nullability, a CHECK's exact shape, whether an index predicate
 * still matches — so none of it can be proven by reading SQL text or by
 * testing a repo function. There is no repo function yet: this migration
 * ships alone, and `voidOpportunity` arrives after it.
 *
 * The last two cases pin claims the migration's HEADER makes and the column
 * definitions do not show: that the two partial indexes over `crm_stage` are
 * left alone on purpose, and that 0021's `NOT VALID` CHECK still fires on the
 * UPDATE a void performs. Both are things a later reader would otherwise
 * rediscover by breaking them.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../web/db/migrations");
const VOID_MIGRATION = "0049_crm_opportunities_voided.sql";

function readMigration(filename: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, filename), "utf-8");
}

// 0019 creates `crm_opportunities` and the two partial indexes; 0049 adds the
// void columns. Nothing between them touches either, so loading the
// intervening migrations would only make this file fail for reasons unrelated
// to what it asserts. The 0021 case below loads its own chain.
const MIGRATIONS = ["0019_crm_schema.sql", VOID_MIGRATION];

let db: PGlite;
let orgId: string;

beforeAll(async () => {
  db = new PGlite();
  for (const migration of MIGRATIONS) {
    await db.exec(readMigration(migration));
  }
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query(`TRUNCATE crm_organisations CASCADE`);
  const org = await db.query<{ id: string }>(
    `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
    ["Bondi Baker"],
  );
  orgId = org.rows[0].id;
});

async function insertOpportunity(voidedAt: string | null, reason: string | null): Promise<void> {
  await db.query(
    `INSERT INTO crm_opportunities (organisation_id, stage, voided_at, voided_reason)
     VALUES ($1, 'new', $2, $3)`,
    [orgId, voidedAt, reason],
  );
}

describe("0049_crm_opportunities_voided.sql", () => {
  it("adds voided_at and voided_reason as nullable columns with no default", async () => {
    // Types are asserted, not just names: `ADD COLUMN IF NOT EXISTS` skips on
    // NAME alone, so a re-application over a column of the wrong type is a
    // silent pass. `column_default` is asserted null because a default here
    // would mark every existing deal voided.
    const columns = await db.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'crm_opportunities'
          AND column_name IN ('voided_at', 'voided_reason')
        ORDER BY column_name`,
    );

    expect(columns.rows).toEqual([
      {
        column_name: "voided_at",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "voided_reason",
        data_type: "text",
        is_nullable: "YES",
        column_default: null,
      },
    ]);
  });

  it("accepts a live deal, a void with no reason, and a void with one", async () => {
    // The three legal states. The middle one is why the constraint is an
    // implication and not a biconditional: a void with no reason given is
    // legitimate, and a biconditional would have made `voided_reason`
    // mandatory on every void.
    await insertOpportunity(null, null);
    await insertOpportunity("2026-09-05T00:00:00Z", null);
    await insertOpportunity("2026-09-05T00:00:00Z", "Duplicate of the other deal");

    const rows = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM crm_opportunities WHERE organisation_id = $1`,
      [orgId],
    );
    expect(rows.rows[0].count).toBe(3);
  });

  it("refuses a reason that has outlived its void", async () => {
    // The state a restore that cleared `voided_at` and forgot
    // `voided_reason` would leave behind: a live deal carrying an
    // explanation for a void no longer in force.
    await expect(insertOpportunity(null, "Duplicate of the other deal")).rejects.toThrow(
      /crm_opp_void_reason_requires_void/,
    );
  });

  it("leaves the two partial stage indexes exactly as 0019 created them", async () => {
    // The header argues no index work is needed: the void predicate
    // (`AND voided_at IS NULL`) narrows the queries that read these, so the
    // query predicate still implies each index predicate and both stay
    // eligible unmodified. This asserts the migration acted on that argument
    // rather than quietly rebuilding them — the definitions below are 0019's,
    // and neither mentions `voided_at`.
    const indexes = await db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE tablename = 'crm_opportunities'
          AND indexname IN ('crm_opp_due_idx', 'crm_opp_drifting_idx')
        ORDER BY indexname`,
    );

    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "crm_opp_drifting_idx",
      "crm_opp_due_idx",
    ]);
    for (const row of indexes.rows) {
      expect(row.indexdef).toContain("stage <> ALL (ARRAY['won'::crm_stage, 'lost'::crm_stage])");
      expect(row.indexdef).not.toContain("voided_at");
    }
  });

  it("does not exempt a void from 0021's product CHECK", async () => {
    // The header's second recorded interaction, pinned so it cannot be
    // rediscovered in production. `crm_opp_product_required_when_qualified`
    // is NOT VALID, which skips only the initial scan — Postgres still
    // evaluates it against the new row of every UPDATE, and a void IS an
    // UPDATE. So a grandfathered deal at `qualified` with no product cannot
    // be voided by the bare UPDATE below.
    //
    // Its own pglite instance, and its own migration chain — replayed in the
    // order production saw it, so the grandfathered row is grandfathered by
    // the migrations themselves rather than by hand-written DDL: 0020 drops
    // the CHECK, the backfill lands product-less `qualified` rows in the gap,
    // and 0021 re-adds the CHECK as NOT VALID over them.
    const fresh = new PGlite();
    try {
      await fresh.exec(readMigration("0019_crm_schema.sql"));
      // 0021 opens with a DO block reading `leads` to catch "the backfill was
      // never run at all". That table is 0001's, and loading 0001 here would
      // drag in the whole pre-CRM schema for one existence check. An empty
      // stand-in satisfies the guard the same way a from-scratch database
      // does — 0021's own header calls that pass vacuous and expected.
      await fresh.exec(`CREATE TABLE leads (id uuid PRIMARY KEY)`);
      await fresh.exec(readMigration("0020_crm_opportunities_migration_exemption.sql"));

      const org = await fresh.query<{ id: string }>(
        `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
        ["Grandfathered Pty"],
      );
      const opp = await fresh.query<{ id: string }>(
        `INSERT INTO crm_opportunities (organisation_id, stage, product)
         VALUES ($1, 'qualified', NULL) RETURNING id`,
        [org.rows[0].id],
      );

      await fresh.exec(readMigration("0021_crm_opportunities_product_check_reinstated.sql"));
      await fresh.exec(readMigration(VOID_MIGRATION));

      await expect(
        fresh.query(`UPDATE crm_opportunities SET voided_at = now() WHERE id = $1`, [
          opp.rows[0].id,
        ]),
      ).rejects.toThrow(/crm_opp_product_required_when_qualified/);
    } finally {
      await fresh.close();
    }
  });

  it("applies cleanly onto a database that already has its effect", async () => {
    // `scripts/db-migrate.mjs` exits on the first migration that throws, so a
    // migration that cannot meet its own effect twice wedges the runner and
    // every LATER migration silently stops being applied (tesserix-home#509).
    // Its own pglite instance: this re-applies a migration, which the shared
    // one above must not have done to it mid-suite.
    const fresh = new PGlite();
    try {
      for (const migration of MIGRATIONS) {
        await fresh.exec(readMigration(migration));
      }
      await expect(fresh.exec(readMigration(VOID_MIGRATION))).resolves.toBeDefined();
    } finally {
      await fresh.close();
    }
  });
});
