import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Schema-only coverage for 0048_crm_activities_opportunity_set_null.sql. Real
 * (in-process) Postgres via pglite, because a referential action is enforced
 * by Postgres and by nothing else — it cannot be proven by asserting SQL text
 * or by testing a repo function.
 *
 * What is being pinned is a SCHEMA INVARIANT, not a feature: if an
 * opportunity is ever deleted, its activities detach rather than being
 * destroyed, because the event log belongs to the organisation and is only
 * optionally scoped to a deal (0019's own header over `crm_activities`).
 *
 * Nothing exercises that action today — no code in this tree deletes a single
 * opportunity, and #251 settled on voiding a deal rather than deleting it —
 * which is exactly why the constraint is asserted here rather than through a
 * caller. There is no caller to assert it through, and the next person to
 * write one should inherit the guarantee rather than have to discover it.
 *
 * No `vi.mock("./tesserix")` and no repo import, for the same reason: this
 * file is about the database's shape, and it should keep passing unchanged
 * whether or not a delete path ever exists.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../web/db/migrations");
const FK_MIGRATION = "0048_crm_activities_opportunity_set_null.sql";

function readMigration(filename: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, filename), "utf-8");
}

// 0019 creates `crm_activities` and its foreign keys; 0048 re-points this one.
// Nothing between the two touches this constraint, so loading the intervening
// migrations would only make this file fail for reasons unrelated to what it
// asserts.
const MIGRATIONS = ["0019_crm_schema.sql", FK_MIGRATION];

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  for (const migration of MIGRATIONS) {
    await db.exec(readMigration(migration));
  }
});

afterAll(async () => {
  await db.close();
});

describe("crm_activities.opportunity_id referential action", () => {
  it("declares exactly one foreign key on opportunity_id, with SET NULL", async () => {
    // The constraint SET is what is asserted, not just the presence of a SET
    // NULL: 0048 adding a second foreign key under a different name while
    // leaving 0019's CASCADE in place would satisfy a laxer check and still
    // destroy rows, because Postgres applies every matching action and SET
    // NULL on a row CASCADE has already deleted is unobservable.
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
      await expect(fresh.exec(readMigration(FK_MIGRATION))).resolves.toBeDefined();
    } finally {
      await fresh.close();
    }
  });
});
