import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Schema-only coverage for 0048_crm_activities_opportunity_set_null.sql. Real
 * (in-process) Postgres via pglite, because the claim is a claim about what
 * the database does to child rows when a parent goes away — referential
 * action is enforced by Postgres and by nothing else, so it cannot be proven
 * by asserting SQL text or by testing a repo function.
 *
 * What is being pinned: deleting an opportunity DETACHES its activities
 * rather than destroying them (tesserix-home#251). Under 0019's original
 * `ON DELETE CASCADE` the delete that #251 introduces would take the whole
 * record of what was said to that business with it — unrecoverably, and for
 * the mis-clicked duplicate that the delete exists to remove.
 *
 * No `vi.mock("./tesserix")` and no repo import: there is no module to test
 * yet (Task 1 ships the migration alone; `deleteOpportunity` arrives in Task
 * 2), and this file should keep passing unchanged when one arrives.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../web/db/migrations");

function readMigration(filename: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, filename), "utf-8");
}

// 0019 creates `crm_activities` and its foreign keys; 0048 re-points this one.
// Nothing between the two touches this constraint, so loading the intervening
// migrations would only make this file fail for reasons unrelated to what it
// asserts.
const MIGRATIONS = ["0019_crm_schema.sql", "0048_crm_activities_opportunity_set_null.sql"];

let db: PGlite;
let orgId: string;
let opportunityId: string;

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
  // Deleting the opportunity is the point of every test here, so fixtures are
  // rebuilt per test rather than shared across the suite.
  await db.query(`TRUNCATE crm_organisations CASCADE`);

  const org = await db.query<{ id: string }>(
    `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
    ["Bondi Baker"],
  );
  orgId = org.rows[0].id;

  const opportunity = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, stage) VALUES ($1, 'new') RETURNING id`,
    [orgId],
  );
  opportunityId = opportunity.rows[0].id;
});

async function seedActivities(): Promise<void> {
  await db.query(
    `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body)
     VALUES ($1, $2, 'dm_sent', $3, $4),
            ($1, $2, 'note', $3, $5),
            ($1, NULL, 'note', $3, $6)`,
    [
      orgId,
      opportunityId,
      "operator@tesserix.app",
      "First DM",
      "They replied on Instagram",
      "Business-level note, never scoped to a deal",
    ],
  );
}

describe("crm_activities.opportunity_id on opportunity delete", () => {
  it("keeps the activity trail, detached, rather than deleting it", async () => {
    await seedActivities();

    await db.query(`DELETE FROM crm_opportunities WHERE id = $1`, [opportunityId]);

    const activities = await db.query<{ body: string; opportunity_id: string | null }>(
      `SELECT body, opportunity_id FROM crm_activities
        WHERE organisation_id = $1
        ORDER BY body`,
      [orgId],
    );

    // All three survive — the two that were scoped to the deleted deal now
    // carry a NULL, which is the shape the organisation timeline already
    // reads (`organisationTimeline` types the column `string | null`) and the
    // shape `crm-outreach.ts` and `crm-writes.ts` already write directly.
    expect(activities.rows).toEqual([
      { body: "Business-level note, never scoped to a deal", opportunity_id: null },
      { body: "First DM", opportunity_id: null },
      { body: "They replied on Instagram", opportunity_id: null },
    ]);
  });

  it("leaves the organisation and its other opportunities untouched", async () => {
    const other = await db.query<{ id: string }>(
      `INSERT INTO crm_opportunities (organisation_id, stage) VALUES ($1, 'contacted') RETURNING id`,
      [orgId],
    );
    await seedActivities();

    await db.query(`DELETE FROM crm_opportunities WHERE id = $1`, [opportunityId]);

    const orgs = await db.query(`SELECT id FROM crm_organisations WHERE id = $1`, [orgId]);
    expect(orgs.rows).toHaveLength(1);

    const remaining = await db.query<{ id: string }>(
      `SELECT id FROM crm_opportunities WHERE organisation_id = $1`,
      [orgId],
    );
    expect(remaining.rows).toEqual([{ id: other.rows[0].id }]);
  });

  it("declares exactly one foreign key on opportunity_id, with SET NULL", async () => {
    // The behavioural tests above would also pass if 0048 had added a SECOND
    // foreign key under a different name while leaving 0019's CASCADE in
    // place — Postgres applies every matching action, and SET NULL on a row
    // CASCADE has already deleted is unobservable. This asserts the
    // constraint set itself, so that mistake shows up as a failure here
    // rather than as data loss in production.
    const constraints = await db.query<{ conname: string; confdeltype: string }>(
      `SELECT con.conname, con.confdeltype
         FROM pg_constraint con
         JOIN pg_class cls ON cls.oid = con.conrelid
         JOIN pg_attribute att
           ON att.attrelid = cls.oid AND att.attnum = ANY (con.conkey)
        WHERE cls.relname = 'crm_activities'
          AND con.contype = 'f'
          AND att.attname = 'opportunity_id'
        ORDER BY con.conname`,
    );

    // 'n' is SET NULL; 'c' — what 0019 shipped — is CASCADE.
    expect(constraints.rows).toEqual([
      { conname: "crm_activities_opportunity_id_fkey", confdeltype: "n" },
    ]);
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
      await expect(
        fresh.exec(readMigration("0048_crm_activities_opportunity_set_null.sql")),
      ).resolves.toBeDefined();
    } finally {
      await fresh.close();
    }
  });
});
