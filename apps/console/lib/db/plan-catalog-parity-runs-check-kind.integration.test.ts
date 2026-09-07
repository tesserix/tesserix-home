import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Integration coverage for `0053_parity_runs_check_kind.sql`, against a real
 * (in-process) Postgres via pglite — the same shape as
 * `plan-catalog-parity-runs-source.integration.test.ts`, and for the same
 * reason: what is asserted is what the ENGINE will and will not accept, not
 * what the application remembers to send.
 *
 * The column exists because `plan_catalog_parity_runs` now holds two kinds of
 * evidence — the catalog against Stripe's Prices, and the console's
 * entitlements against the matrix mark8ly's plan gate enforces — and all three
 * readers of the table key on (mode, source) alone. Undiscriminated, an
 * entitlement run would count towards #327's price window, refresh the
 * `last_clean` gauge that exists to alert when the price check goes silent, and
 * appear on the operator's price card with findings it has no labels for. That
 * the READS ignore it is asserted in `parity-window.integration.test.ts`; this
 * file asserts the column itself.
 *
 * 0032-0036 are the chain the runs table needs (0032 creates the prices table
 * 0035 alters, 0033 creates the runs table, 0034 adds `mode`, 0035 adds
 * `publication_id`, 0036 constrains a `clean` row to name one), then #392's
 * two files, then 0053.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../web/db/migrations");

const readMigration = (name: string) =>
  readFileSync(path.join(MIGRATIONS_DIR, name), "utf-8");

const MIGRATIONS = [
  "0032_plan_catalog.sql",
  "0033_plan_catalog_parity_runs.sql",
  "0034_parity_runs_mode.sql",
  "0035_plan_catalog_revisions.sql",
  "0036_parity_runs_clean_names_publication.sql",
  "0044_parity_runs_source.sql",
  "0045_parity_runs_source_drop_default.sql",
  "0053_parity_runs_check_kind.sql",
];

let db: PGlite;
let publicationId: string;

const insert = (columns: string, values: readonly unknown[]) =>
  db.query(
    `INSERT INTO plan_catalog_parity_runs (${columns})
     VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")})`,
    values as unknown[],
  );

const kinds = async () => {
  const { rows } = await db.query<{ check_kind: string }>(
    "SELECT check_kind FROM plan_catalog_parity_runs ORDER BY check_kind",
  );
  return rows.map((r) => r.check_kind);
};

beforeAll(async () => {
  db = new PGlite();
  for (const name of MIGRATIONS) await db.exec(readMigration(name));
  // 0036 requires every `clean` row to name a publication, and 0035 seeds the
  // `test` one. It is the honest id for these rows to carry.
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM plan_catalog_publications WHERE mode = 'test' AND superseded_at IS NULL",
  );
  publicationId = rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.query("DELETE FROM plan_catalog_parity_runs");
});

describe("0053 — a run says which comparison produced it", () => {
  it("stores both kinds", async () => {
    await insert("check_kind, mode, source, outcome, publication_id", [
      "price",
      "test",
      "mark8ly",
      "clean",
      publicationId,
    ]);
    await insert("check_kind, mode, source, outcome, publication_id", [
      "entitlement",
      "test",
      "mark8ly",
      "clean",
      publicationId,
    ]);

    expect(await kinds()).toEqual(["entitlement", "price"]);
  });

  it("rejects a kind no migration has admitted", async () => {
    // A third value would be evidence no reader counts, which is
    // indistinguishable from evidence that is never clean — 0034's and 0044's
    // argument on the other two axes.
    await expect(
      insert("check_kind, mode, source, outcome", ["subscribers", "test", "mark8ly", "failed"]),
    ).rejects.toThrow(/plan_catalog_parity_runs_check_kind_is_a_known_kind/);
  });

  it("rejects a NULL kind", async () => {
    // Explicitly passing NULL is not omitting the column: only the latter
    // takes the default. A writer holding an undefined kind must fail rather
    // than have it silently become a price run.
    await expect(
      insert("check_kind, mode, source, outcome", [null, "test", "mark8ly", "failed"]),
    ).rejects.toThrow(/check_kind/);
  });

  it("still accepts an insert that names no kind, and files it as a price run", async () => {
    // THE REASON THE DEFAULT STAYS IN THIS FILE, and 0044's argument verbatim:
    // migrations here are applied to prod before the PR carrying them merges,
    // so the previously-deployed image serves the nightly CronJob for a window
    // after this column exists. Its `recordParityRun` names no `check_kind`.
    // If this insert raised, that day would get no row and `readWindowStatus`
    // would read it as not clean — a 7-day streak broken by a deploy.
    //
    // `'price'` is the right value for it to land: every row this table has
    // ever held was written by the catalog-against-Stripe comparison.
    await insert("mode, source, outcome, difference_count, differences, error, publication_id", [
      "test",
      "mark8ly",
      "clean",
      0,
      JSON.stringify([]),
      null,
      publicationId,
    ]);

    expect(await kinds()).toEqual(["price"]);
  });

  it("backfills the rows that predate it as price runs", async () => {
    // Prod holds real rows — parity runs going back to 2026-08-27 — and every
    // one of them compared the catalog against Stripe. The ALTER has to give
    // them a value, and this is the only honest one.
    const fresh = new PGlite();
    try {
      for (const name of MIGRATIONS.filter((n) => n !== "0053_parity_runs_check_kind.sql")) {
        await fresh.exec(readMigration(name));
      }
      await fresh.query(
        `INSERT INTO plan_catalog_parity_runs (mode, source, outcome)
         VALUES ('test', 'mark8ly', 'not_bootstrapped')`,
      );

      await fresh.exec(readMigration("0053_parity_runs_check_kind.sql"));

      const { rows } = await fresh.query<{ check_kind: string }>(
        "SELECT check_kind FROM plan_catalog_parity_runs",
      );
      expect(rows.map((r) => r.check_kind)).toEqual(["price"]);
    } finally {
      await fresh.close();
    }
  });

  it("still refuses a clean entitlement run that names no publication", async () => {
    // 0036 is untouched by 0053 and must keep biting for both kinds: an
    // entitlement run reads the mode's live publication to know which
    // revision's rows to compare, so a clean one always has an id to name.
    await expect(
      insert("check_kind, mode, source, outcome", ["entitlement", "test", "mark8ly", "clean"]),
    ).rejects.toThrow(/plan_catalog_parity_runs_clean_names_its_publication/);
  });
});
