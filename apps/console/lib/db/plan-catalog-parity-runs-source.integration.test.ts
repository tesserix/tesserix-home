import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { CATALOG_SOURCES, SINGLE_SOURCE } from "@/lib/billing/source-policy";

/**
 * Integration coverage for `0044_parity_runs_source.sql` and
 * `0045_parity_runs_source_drop_default.sql`.
 *
 * Same shape as `plan-catalog-parity-runs-mode.integration.test.ts` — the
 * migrations run against a real (in-process) Postgres via pglite, because what
 * is being asserted is what the ENGINE will and will not accept, not what the
 * application remembers to send.
 *
 * # Why these two files are tested together, and their ORDER with them
 *
 * tesserix-home#392 is one schema change deliberately split across two applies.
 * 0044 adds `source` and KEEPS its default so the console image already running
 * in prod — whose `recordParityRun` (`plan-catalog-repo.ts:310`) names no
 * source — keeps writing rows during the window between the migration landing
 * and Kargo rolling out the new image. 0045 drops the default afterwards.
 *
 * That ordering is the interesting property, so it is what the suite asserts:
 * after 0044 alone an insert omitting `source` must SUCCEED and land
 * `'mark8ly'`; after 0045 the same insert must FAIL. Either assertion alone
 * proves nothing useful — a default that never went is invisible until a second
 * source is mis-filed, and a default dropped too early is invisible until a
 * nightly CronJob silently writes no row and the 7-day streak reads as broken.
 *
 * # Which migrations are loaded, and why that many
 *
 * 0032 creates `plan_catalog_prices`, which 0035 alters; 0033 creates the runs
 * table; 0034 adds `mode`; 0035 adds `publication_id` and the publications
 * table; 0036 constrains `clean` to name a publication. The same chain
 * `plan-catalog-revisions.integration.test.ts` loads, plus 0036 — which is here
 * on purpose. 0044 claims in its own comment that 0036 needs no change because
 * `plan_catalog_publications` is keyed by mode alone and one publication
 * legitimately serves both sources within a mode. This suite is where that
 * claim is exercised rather than merely asserted.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../web/db/migrations");

const readMigration = (name: string) =>
  readFileSync(path.join(MIGRATIONS_DIR, name), "utf-8");

/** Everything the runs table needs before `source` is added to it. */
const BASE_MIGRATIONS = [
  "0032_plan_catalog.sql",
  "0033_plan_catalog_parity_runs.sql",
  "0034_parity_runs_mode.sql",
  "0035_plan_catalog_revisions.sql",
  "0036_parity_runs_clean_names_publication.sql",
];

const ADD_SOURCE = "0044_parity_runs_source.sql";
const DROP_DEFAULT = "0045_parity_runs_source_drop_default.sql";

/**
 * A database with the base chain applied and then whichever of #392's two files
 * the caller wants. Built per describe block rather than shared, because the
 * two files' effects are precisely what is being told apart.
 */
async function migratedTo(...extra: readonly string[]): Promise<PGlite> {
  const db = new PGlite();
  for (const name of [...BASE_MIGRATIONS, ...extra]) {
    await db.exec(readMigration(name));
  }
  return db;
}

/**
 * The `test`-mode publication 0035 seeds. 0036 requires every `clean` row to
 * name one, so every clean insert below needs an id and this is the honest one
 * to use — it is the publication those runs would genuinely have checked.
 */
async function seededTestPublicationId(db: PGlite): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM plan_catalog_publications WHERE mode = 'test' AND superseded_at IS NULL",
  );
  return rows[0].id;
}

const insertInto = (db: PGlite) => (columns: string, values: readonly unknown[]) => {
  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  return db.query(
    `INSERT INTO plan_catalog_parity_runs (${columns}) VALUES (${placeholders})`,
    values as unknown[],
  );
};

describe("0044 alone — the column exists and the old image still writes", () => {
  let db: PGlite;
  let insert: ReturnType<typeof insertInto>;
  let publicationId: string;

  beforeAll(async () => {
    db = await migratedTo(ADD_SOURCE);
    insert = insertInto(db);
    publicationId = await seededTestPublicationId(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM plan_catalog_parity_runs");
  });

  it("stores a run against a known source", async () => {
    await insert("mode, source, outcome, publication_id", [
      "test",
      SINGLE_SOURCE,
      "clean",
      publicationId,
    ]);

    const { rows } = await db.query<{ source: string }>(
      "SELECT source FROM plan_catalog_parity_runs",
    );
    expect(rows.map((r) => r.source)).toEqual(["mark8ly"]);
  });

  it("accepts every source the application will iterate", async () => {
    // `CATALOG_SOURCES` is what the per-pair check loops over, so a value in it
    // that the CHECK rejects would be a pair that can be run and never
    // recorded. Asserted against the array rather than the literal so adding a
    // source to the code without a migration fails HERE, loudly, rather than at
    // 02:15 UTC in the CronJob.
    for (const source of CATALOG_SOURCES) {
      await insert("mode, source, outcome, publication_id", [
        "test",
        source,
        "clean",
        publicationId,
      ]);
    }

    const { rows } = await db.query<{ source: string }>(
      "SELECT source FROM plan_catalog_parity_runs ORDER BY source",
    );
    expect(rows.map((r) => r.source)).toEqual([...CATALOG_SOURCES]);
  });

  it("rejects a source no migration has admitted", async () => {
    // A source outside the CHECK would be a source the per-pair window query
    // never counts, which is indistinguishable from a source that is never
    // clean. Adding one is meant to be a deliberate migration.
    await expect(
      insert("mode, source, outcome", ["test", "kora", "not_bootstrapped"]),
    ).rejects.toThrow(/plan_catalog_parity_runs_source_is_a_known_source/);
  });

  it("rejects a NULL source", async () => {
    // Explicitly passing NULL is not the same as omitting the column: the
    // default only fills the latter. A writer that has a source variable and
    // finds it undefined must fail rather than have it silently become
    // mark8ly.
    await expect(
      insert("mode, source, outcome", ["test", null, "not_bootstrapped"]),
    ).rejects.toThrow(/source/);
  });

  it("still accepts an insert that names no source, and files it as mark8ly", async () => {
    // THE REASON 0044 AND 0045 ARE SEPARATE FILES.
    //
    // This is the insert the currently-deployed image performs — the column
    // list at `plan-catalog-repo.ts:310` names mode, outcome, difference_count,
    // differences, error and publication_id, and no source. Migrations here are
    // applied to prod before the PR merges, so that image serves the nightly
    // `console-parity-check` CronJob for a window after this column exists. If
    // this insert raised, no row would be written for that day and
    // `readWindowStatus` would read the day as not clean — a broken 7-day
    // streak caused by a deploy rather than by drift.
    //
    // `'mark8ly'` is the right value for it to land, because mark8ly is the
    // only source that exists for it to have checked.
    await insert("mode, outcome, difference_count, differences, error, publication_id", [
      "test",
      "clean",
      0,
      JSON.stringify([]),
      null,
      publicationId,
    ]);

    const { rows } = await db.query<{ source: string }>(
      "SELECT source FROM plan_catalog_parity_runs",
    );
    expect(rows.map((r) => r.source)).toEqual(["mark8ly"]);
  });

  it("takes the column without losing the rows that predate it", async () => {
    // Unlike 0034's situation — prod was at v33 with zero rows then — prod
    // genuinely has rows now: 20 parity runs spanning 2026-08-27..2026-09-03,
    // every one of them recorded against mark8ly because mark8ly is the only
    // source there has ever been. So the default is doing real backfill work
    // here and the backfilled value is a fact rather than an assumption.
    const fresh = await migratedTo();
    try {
      const pub = await seededTestPublicationId(fresh);
      await fresh.query(
        `INSERT INTO plan_catalog_parity_runs (mode, outcome, publication_id)
         VALUES ('test', 'clean', $1), ('live', 'not_bootstrapped', NULL)`,
        [pub],
      );

      await fresh.exec(readMigration(ADD_SOURCE));

      const { rows } = await fresh.query<{ source: string }>(
        "SELECT source FROM plan_catalog_parity_runs",
      );
      expect(rows.map((r) => r.source)).toEqual(["mark8ly", "mark8ly"]);
    } finally {
      await fresh.close();
    }
  });

  it("is idempotent — applying it twice is harmless", async () => {
    // Applied by hand, and a retried apply must not abort partway. #509 is the
    // standing reminder of what a non-re-runnable migration costs: the runner
    // exits on the first throw and every LATER migration silently stops being
    // applied.
    await db.exec(readMigration(ADD_SOURCE));

    await insert("mode, source, outcome", ["test", SINGLE_SOURCE, "not_bootstrapped"]);
    const { rows } = await db.query<{ total: string | number }>(
      "SELECT count(*) AS total FROM plan_catalog_parity_runs",
    );
    expect(Number(rows[0].total)).toBe(1);
  });
});

describe("0044 then 0045 — the default is gone", () => {
  let db: PGlite;
  let insert: ReturnType<typeof insertInto>;
  let publicationId: string;

  beforeAll(async () => {
    db = await migratedTo(ADD_SOURCE, DROP_DEFAULT);
    insert = insertInto(db);
    publicationId = await seededTestPublicationId(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM plan_catalog_parity_runs");
  });

  it("refuses a row that does not state its source, rather than inheriting one", async () => {
    // The single most important assertion in this file. A surviving default is
    // invisible until a second source lands, at which point a run that forgot
    // its source is filed as a mark8ly run and "every (mode, source) pair
    // clean" becomes satisfiable by one source answering twice — the exact
    // failure the column exists to prevent, arriving as a confident wrong
    // answer rather than a gap.
    await expect(
      insert("mode, outcome, publication_id", ["test", "clean", publicationId]),
    ).rejects.toThrow(/source/);
  });

  it("still stores a run that does state its source", async () => {
    await insert("mode, source, outcome, publication_id", [
      "test",
      SINGLE_SOURCE,
      "clean",
      publicationId,
    ]);

    const { rows } = await db.query<{ mode: string; source: string }>(
      "SELECT mode, source FROM plan_catalog_parity_runs",
    );
    expect(rows).toEqual([{ mode: "test", source: "mark8ly" }]);
  });

  it("is idempotent, and a second application does not restore the default", async () => {
    await db.exec(readMigration(DROP_DEFAULT));
    await expect(
      insert("mode, outcome, publication_id", ["test", "clean", publicationId]),
    ).rejects.toThrow(/source/);
  });
});

describe("what 0034 and 0036 established still holds", () => {
  // 0044 recreates none of their constraints — it adds a column, one CHECK and
  // one index, and touches nothing about what a run FOUND. These assertions are
  // the evidence for that claim rather than a restatement of it.
  let db: PGlite;
  let insert: ReturnType<typeof insertInto>;
  let publicationId: string;

  beforeAll(async () => {
    db = await migratedTo(ADD_SOURCE, DROP_DEFAULT);
    insert = insertInto(db);
    publicationId = await seededTestPublicationId(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM plan_catalog_parity_runs");
  });

  it("still refuses a run that does not state its mode", async () => {
    // 0034's dropped default, still dropped. 0044 adds a second NOT NULL column
    // with a default of its own, and a migration that restored `mode`'s default
    // as a side effect would be undetectable otherwise.
    await expect(
      insert("source, outcome, publication_id", [SINGLE_SOURCE, "clean", publicationId]),
    ).rejects.toThrow(/mode/);
  });

  it("still rejects a mode that is neither test nor live", async () => {
    await expect(
      insert("mode, source, outcome", ["sandbox", SINGLE_SOURCE, "not_bootstrapped"]),
    ).rejects.toThrow(/plan_catalog_parity_runs_mode_is_a_known_mode/);
  });

  it("still rejects an unknown outcome", async () => {
    await expect(
      insert("mode, source, outcome", ["test", SINGLE_SOURCE, "probably_fine"]),
    ).rejects.toThrow(/plan_catalog_parity_runs_outcome_is_a_known_state/);
  });

  it("still rejects a clean run carrying differences", async () => {
    await expect(
      insert("mode, source, outcome, difference_count, differences, publication_id", [
        "test",
        SINGLE_SOURCE,
        "clean",
        1,
        JSON.stringify([{ kind: "amount_mismatch" }]),
        publicationId,
      ]),
    ).rejects.toThrow(/plan_catalog_parity_runs_outcome_matches_difference_count/);
  });

  it("still rejects a failed run with no reason", async () => {
    await expect(
      insert("mode, source, outcome", ["test", SINGLE_SOURCE, "failed"]),
    ).rejects.toThrow(/plan_catalog_parity_runs_error_belongs_to_failed/);
  });

  it("still refuses a clean run that names no publication", async () => {
    // 0036, unchanged and still biting. A `clean` row must say which catalog it
    // was clean against.
    await expect(
      insert("mode, source, outcome", ["test", SINGLE_SOURCE, "clean"]),
    ).rejects.toThrow(/plan_catalog_parity_runs_clean_names_its_publication/);
  });

  it("lets one publication serve both axes of a mode, which is why 0036 needs no change", async () => {
    // `plan_catalog_publications` is keyed by mode alone (0035): a publication
    // is a fact about a (mode, revision) pair, and a revision holds prices for
    // every source. So two runs of the SAME mode and DIFFERENT sources sharing
    // one `publication_id` is coherent, and 0036's constraint is satisfied by
    // both. Written as a query rather than as prose in the migration, because
    // the alternative reading — that 0036 should have grown a source too — is
    // the plausible wrong change a later reader might make.
    //
    // The second row uses mark8ly as well, since it is the only value the CHECK
    // admits today; what the assertion pins is that the shared publication is
    // accepted per run, not that two distinct sources exist yet.
    await insert("mode, source, outcome, publication_id", [
      "test",
      SINGLE_SOURCE,
      "clean",
      publicationId,
    ]);
    await insert("mode, source, outcome, publication_id", [
      "test",
      SINGLE_SOURCE,
      "clean",
      publicationId,
    ]);

    const { rows } = await db.query<{ n: string | number }>(
      "SELECT count(DISTINCT publication_id) AS n FROM plan_catalog_parity_runs WHERE outcome = 'clean'",
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});
