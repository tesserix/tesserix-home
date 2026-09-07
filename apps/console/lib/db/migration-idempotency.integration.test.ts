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

/**
 * The same claim for 0051_promo_codes_scoping.sql, and a slightly harder one.
 *
 * 0040 is two `ADD COLUMN IF NOT EXISTS`es and nothing else. 0051 also adds
 * four named CHECKs, and Postgres has no `ADD CONSTRAINT IF NOT EXISTS` — so
 * its re-runnability rests on the `DROP CONSTRAINT IF EXISTS` / `ADD
 * CONSTRAINT` pair, which is a different mechanism from the one 0040 proves and
 * therefore needs its own test rather than a note saying it follows the same
 * pattern. Written without it, the second application fails with
 * `constraint "promo_codes_allowed_plans_are_known_plans" ... already exists`
 * and wedges every migration after 0051.
 *
 * 0046 is loaded first because it creates `promo_codes`, the table 0051 alters.
 */
describe("0051_promo_codes_scoping.sql", () => {
  it("applies cleanly onto a database that already has its effect", async () => {
    const db = new PGlite();

    try {
      await db.exec(readMigration("0046_promo_codes.sql"));

      const migration = readMigration("0051_promo_codes_scoping.sql");
      await db.exec(migration);
      await expect(db.exec(migration)).resolves.toBeDefined();

      // Types asserted, not just presence: `ADD COLUMN IF NOT EXISTS` skips on
      // the column NAME alone, so it would no-op over a pre-existing
      // `allowed_plans` of the wrong type. 0051's header says the file claims
      // re-runnability and NOT convergence; this is where that distinction is
      // visible.
      const columns = await db.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'promo_codes'
            AND column_name IN ('allowed_plans', 'annual_only')
          ORDER BY column_name`,
      );

      expect(columns.rows).toEqual([
        {
          column_name: "allowed_plans",
          data_type: "ARRAY",
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "annual_only",
          data_type: "boolean",
          is_nullable: "NO",
          column_default: "false",
        },
      ]);

      // Each CHECK survives the drop-and-add exactly once. A count would pass
      // on a re-run that dropped a constraint and failed to re-add it, so the
      // NAMES are asserted — and 0046's own are listed alongside, which is the
      // assertion that 0051's `DROP CONSTRAINT IF EXISTS` did not reach past
      // its own four.
      const checks = await db.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'promo_codes'::regclass AND contype = 'c'
          ORDER BY conname`,
      );
      expect(checks.rows.map((r) => r.conname)).toEqual([
        "promo_codes_allowed_plans_are_known_plans",
        "promo_codes_allowed_plans_has_no_duplicates",
        "promo_codes_allowed_plans_has_no_null_elements",
        "promo_codes_allowed_plans_is_not_empty",
        "promo_codes_code_has_no_whitespace",
        "promo_codes_code_is_upper_case",
        "promo_codes_discount_amount_off_is_positive",
        "promo_codes_discount_currency_accompanies_amount_off",
        "promo_codes_discount_currency_is_lowercase_iso_4217",
        "promo_codes_discount_duration_is_a_stripe_duration",
        "promo_codes_discount_is_percent_off_xor_amount_off",
        "promo_codes_discount_months_iff_repeating",
        "promo_codes_discount_months_is_positive",
        "promo_codes_discount_percent_off_is_in_range",
        "promo_codes_discount_terms_are_all_or_nothing",
        "promo_codes_has_at_least_one_effect",
        "promo_codes_max_redemptions_is_positive",
        "promo_codes_source_is_a_known_source",
        "promo_codes_trial_extension_is_positive",
        "promo_codes_validity_window_is_ordered",
      ]);

      // A row already present when 0051 lands keeps the unscoped meaning, and
      // the constraints still bite after the SECOND application — the case a
      // drop-without-re-add would pass silently.
      await db.query(
        `INSERT INTO promo_codes (source, code, trial_extension_days, created_by)
         VALUES ('mark8ly', 'PREEXISTING', 30, 'operator@tesserix.app')`,
      );
      const existing = await db.query<{ allowed_plans: unknown; annual_only: boolean }>(
        "SELECT allowed_plans, annual_only FROM promo_codes WHERE code = 'PREEXISTING'",
      );
      expect(existing.rows[0]).toEqual({ allowed_plans: null, annual_only: false });

      await expect(
        db.query("UPDATE promo_codes SET allowed_plans = '{}' WHERE code = 'PREEXISTING'"),
      ).rejects.toThrow(/promo_codes_allowed_plans_is_not_empty/);
      await expect(
        db.query("UPDATE promo_codes SET allowed_plans = '{prro}' WHERE code = 'PREEXISTING'"),
      ).rejects.toThrow(/promo_codes_allowed_plans_are_known_plans/);
    } finally {
      await db.close();
    }
  });
});

/**
 * The same claim for 0052_plan_catalog_entitlements.sql, and a different
 * mechanism again.
 *
 * 0040 is `ADD COLUMN IF NOT EXISTS`; 0051 is the `DROP CONSTRAINT IF EXISTS` /
 * `ADD CONSTRAINT` pair. 0052 is neither — it is a `CREATE TABLE IF NOT EXISTS`
 * with all four of its CHECKs declared inside the table, which is 0046's shape
 * and re-runnable for a different reason: the constraints never exist as
 * separate statements, so there is no second `ADD CONSTRAINT` to collide. That
 * is cheap to assert and worth asserting, because the failure mode it rules out
 * is the one an author reaches for by reflex — lifting a CHECK out of the
 * CREATE TABLE into a trailing `ALTER TABLE ... ADD CONSTRAINT`, which is valid
 * SQL, passes its first application, and wedges every migration after 0052 on
 * its second.
 *
 * 0032–0035 are loaded first because `plan_catalog_entitlements` references
 * `plan_catalog_revisions`, which 0035 creates — and 0035 in turn alters the
 * tables 0032 and 0033/0034 create.
 */
describe("0052_plan_catalog_entitlements.sql", () => {
  it("applies cleanly onto a database that already has its effect", async () => {
    const db = new PGlite();

    try {
      for (const name of [
        "0032_plan_catalog.sql",
        "0033_plan_catalog_parity_runs.sql",
        "0034_parity_runs_mode.sql",
        "0035_plan_catalog_revisions.sql",
      ]) {
        await db.exec(readMigration(name));
      }

      const migration = readMigration("0052_plan_catalog_entitlements.sql");
      await db.exec(migration);
      await expect(db.exec(migration)).resolves.toBeDefined();

      // Types and nullability asserted, not just presence: `CREATE TABLE IF NOT
      // EXISTS` skips on the table NAME alone, so it would no-op over a
      // pre-existing table of a different shape. 0052's header says the file
      // claims re-runnability and NOT convergence; this is where that
      // distinction is visible.
      const columns = await db.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_name = 'plan_catalog_entitlements'
          ORDER BY column_name`,
      );
      expect(columns.rows).toEqual([
        { column_name: "feature", data_type: "text", is_nullable: "NO" },
        { column_name: "plan", data_type: "text", is_nullable: "NO" },
        { column_name: "revision_id", data_type: "uuid", is_nullable: "NO" },
        { column_name: "source", data_type: "text", is_nullable: "NO" },
        { column_name: "value", data_type: "integer", is_nullable: "NO" },
      ]);

      // Each CHECK exists exactly once after the second application. A count
      // would pass on a run that dropped one and failed to re-add it, so the
      // NAMES are asserted.
      const checks = await db.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'plan_catalog_entitlements'::regclass AND contype = 'c'
          ORDER BY conname`,
      );
      expect(checks.rows.map((r) => r.conname)).toEqual([
        "plan_catalog_entitlements_feature_is_a_known_feature",
        "plan_catalog_entitlements_plan_is_a_known_plan",
        "plan_catalog_entitlements_source_is_a_known_source",
        "plan_catalog_entitlements_value_is_a_known_sentinel_or_cap",
      ]);

      // The constraints still bite after the SECOND application, and the
      // cascade still points at the revision — the cases a table silently
      // recreated in a different shape would pass.
      const revision = await db.query<{ id: string }>(
        `INSERT INTO plan_catalog_revisions (note, created_by)
         VALUES ('idempotency', 'test') RETURNING id`,
      );
      const revisionId = revision.rows[0].id;

      await db.query(
        `INSERT INTO plan_catalog_entitlements (revision_id, source, plan, feature, value)
         VALUES ($1, 'mark8ly', 'pro', 'stores', -1)`,
        [revisionId],
      );
      await expect(
        db.query(
          `INSERT INTO plan_catalog_entitlements (revision_id, source, plan, feature, value)
           VALUES ($1, 'mark8ly', 'pro', 'sores', 1)`,
          [revisionId],
        ),
      ).rejects.toThrow(/plan_catalog_entitlements_feature_is_a_known_feature/);
      await expect(
        db.query(
          `INSERT INTO plan_catalog_entitlements (revision_id, source, plan, feature, value)
           VALUES ($1, 'mark8ly', 'pro', 'custom_css', -3)`,
          [revisionId],
        ),
      ).rejects.toThrow(/plan_catalog_entitlements_value_is_a_known_sentinel_or_cap/);

      await db.query(`DELETE FROM plan_catalog_revisions WHERE id = $1`, [revisionId]);
      const survivors = await db.query(
        `SELECT 1 FROM plan_catalog_entitlements WHERE revision_id = $1`,
        [revisionId],
      );
      expect(survivors.rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});

/**
 * The same claim for 0053_parity_runs_check_kind.sql, whose mechanism is
 * 0040's and 0051's TOGETHER — the combination none of the cases above covers.
 *
 * It is an `ADD COLUMN IF NOT EXISTS` (0040's shape) plus a
 * `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` pair (0051's) plus a
 * `CREATE INDEX IF NOT EXISTS`, in one file. Each of the three is individually
 * re-runnable and the file is only re-runnable if all three are — an
 * `ADD CONSTRAINT` without its matching drop passes its first application and
 * wedges every migration after 0053 on its second, which is the failure #509
 * paid for.
 *
 * The chain below is what the runs table needs before the column can be added:
 * 0032 creates the prices table 0035 alters, 0033 creates the runs table, 0034
 * adds `mode`, 0035 adds `publication_id`, 0044/0045 add `source` and drop its
 * default.
 */
describe("0053_parity_runs_check_kind.sql", () => {
  it("applies cleanly onto a database that already has its effect", async () => {
    const db = new PGlite();

    try {
      for (const name of [
        "0032_plan_catalog.sql",
        "0033_plan_catalog_parity_runs.sql",
        "0034_parity_runs_mode.sql",
        "0035_plan_catalog_revisions.sql",
        "0044_parity_runs_source.sql",
        "0045_parity_runs_source_drop_default.sql",
      ]) {
        await db.exec(readMigration(name));
      }

      const migration = readMigration("0053_parity_runs_check_kind.sql");
      await db.exec(migration);
      await expect(db.exec(migration)).resolves.toBeDefined();

      // Type and nullability, not just presence: `ADD COLUMN IF NOT EXISTS`
      // skips on the column NAME alone, so it would no-op over a pre-existing
      // column of the wrong type.
      const columns = await db.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'plan_catalog_parity_runs' AND column_name = 'check_kind'`,
      );
      expect(columns.rows).toEqual([
        {
          column_name: "check_kind",
          data_type: "text",
          is_nullable: "NO",
          // The default SURVIVES the second application. It is what keeps the
          // previously-deployed image's `recordParityRun` — which names no
          // check kind — writing rows during the rollout window, and a
          // migration that dropped it on re-run would break the nightly
          // CronJob rather than merely fail.
          column_default: "'price'::text",
        },
      ]);

      // The CHECK exists exactly once and still bites after the second
      // application — the case a `DROP CONSTRAINT` that reached too far, or an
      // `ADD` that never re-ran, would each pass a count.
      const checks = await db.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'plan_catalog_parity_runs'::regclass
            AND contype = 'c'
            AND conname = 'plan_catalog_parity_runs_check_kind_is_a_known_kind'`,
      );
      expect(checks.rows).toHaveLength(1);

      await expect(
        db.query(
          `INSERT INTO plan_catalog_parity_runs (check_kind, mode, source, outcome)
           VALUES ('subscribers', 'test', 'mark8ly', 'failed')`,
        ),
      ).rejects.toThrow(/plan_catalog_parity_runs_check_kind_is_a_known_kind/);

      // 0034's and 0044's CHECKs are untouched by this file, and a
      // `DROP CONSTRAINT IF EXISTS` aimed at the wrong name would silently
      // remove one of them instead of failing.
      const survivors = await db.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'plan_catalog_parity_runs'::regclass AND contype = 'c'
          ORDER BY conname`,
      );
      expect(survivors.rows.map((r) => r.conname)).toEqual(
        expect.arrayContaining([
          "plan_catalog_parity_runs_mode_is_a_known_mode",
          "plan_catalog_parity_runs_source_is_a_known_source",
        ]),
      );
    } finally {
      await db.close();
    }
  });
});
