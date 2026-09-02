import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

/**
 * Re-run safety for 0040_operator_capabilities.sql, against real (in-process)
 * Postgres via pglite.
 *
 * This is a regression test for tesserix-home#509, and the failure it guards
 * is not a failure of 0040 itself — it is a failure of everything AFTER it.
 * `scripts/db-migrate.mjs` applies files in version order and `process.exit(1)`s
 * on the first one that throws, so a migration that cannot survive meeting its
 * own effect twice does not merely fail: it wedges the runner, and every later
 * migration stops being applied, indefinitely and silently. In production 0040
 * had been hand-applied and never recorded in `schema_migrations`, so the
 * runner re-attempted it, hit `column "capabilities" ... already exists`, and
 * 0041, 0042 and 0043 never ran. The symptom that eventually surfaced was a
 * console page reporting that its tables did not exist — four migrations and
 * one subsystem away from the cause.
 *
 * So the assertion is deliberately about the SECOND application, not the
 * first. A migration passing once proves only that it is valid SQL; what the
 * runner actually requires of it — and what nothing checked before this file —
 * is that applying it to a database that already has its effect is a no-op
 * rather than an abort.
 *
 * 0029 is loaded first because it creates `operator_api_tokens`, the table 0040
 * alters. Nothing else is loaded: 0040 touches one table, and pulling in the
 * intervening migrations would make this test fail for reasons that have
 * nothing to do with what it is asserting.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../web/db/migrations");

function readMigration(filename: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, filename), "utf-8");
}

describe("0040_operator_capabilities.sql", () => {
  it("applies cleanly onto a database that already has its effect", async () => {
    const db = new PGlite();

    try {
      await db.exec(readMigration("0029_operator_api_tokens.sql"));

      const migration = readMigration("0040_operator_capabilities.sql");
      await db.exec(migration);

      // The whole point. Before #509's fix this rejects with
      // `column "capabilities" of relation "operator_api_tokens" already
      // exists`, which is precisely what production's migration runner hit.
      await expect(db.exec(migration)).resolves.toBeDefined();

      // …and the second run left the columns as the first run created them,
      // rather than silently swallowing a partially-applied migration. Types
      // are asserted because `ADD COLUMN IF NOT EXISTS` skips on NAME alone:
      // it would also no-op over a pre-existing column of the wrong type, and
      // a test that only counted the columns would not notice.
      const columns = await db.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_name = 'operator_api_tokens'
            AND column_name IN ('capabilities', 'capabilities_checked_at')
          ORDER BY column_name`,
      );

      expect(columns.rows).toEqual([
        { column_name: "capabilities", data_type: "ARRAY" },
        { column_name: "capabilities_checked_at", data_type: "timestamp with time zone" },
      ]);
    } finally {
      await db.close();
    }
  });
});
