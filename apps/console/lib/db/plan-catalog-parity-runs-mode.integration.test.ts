import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Integration coverage for `0034_parity_runs_mode.sql`.
 *
 * Same shape as `plan-catalog-parity-runs.integration.test.ts` — the migration
 * run against a real (in-process) Postgres via pglite, because what is being
 * asserted is what the ENGINE will and will not accept.
 *
 * That file stays as it is, testing 0033 ALONE. This one applies 0033 and then
 * 0034, which is the table prod actually holds. Both are worth having: the
 * first says what 0033 established, this one says what survived 0034 — and
 * 0034 DROPS AND RECREATES two of 0033's CHECKs, so "survived" is a real
 * question rather than a rhetorical one. A recreated constraint that quietly
 * dropped a clause would leave 0033's suite passing against a schema nobody
 * runs.
 *
 * # The one state this file exists for
 *
 * `not_bootstrapped` must be storable, and must be storable ONLY with a zero
 * difference count. A mode nobody has launched has nothing to differ from; a
 * row claiming both "nothing here yet" and "42 findings" is the incoherence
 * that makes a window's answer worthless a week later.
 */

const MIGRATIONS = ["0033_plan_catalog_parity_runs.sql", "0034_parity_runs_mode.sql"].map(
  (name) => path.resolve(__dirname, "../../../web/db/migrations", name),
);

let db: PGlite;

const insert = (columns: string, values: readonly unknown[]) => {
  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  return db.query(
    `INSERT INTO plan_catalog_parity_runs (${columns}) VALUES (${placeholders})`,
    values as unknown[],
  );
};

beforeAll(async () => {
  db = new PGlite();
  for (const file of MIGRATIONS) await db.exec(readFileSync(file, "utf-8"));
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.query("DELETE FROM plan_catalog_parity_runs");
});

describe("the mode column", () => {
  it("stores a run against each mode", async () => {
    await insert("mode, outcome", ["test", "clean"]);
    await insert("mode, outcome", ["live", "clean"]);

    const { rows } = await db.query<{ mode: string }>(
      "SELECT mode FROM plan_catalog_parity_runs ORDER BY mode",
    );
    expect(rows.map((r) => r.mode)).toEqual(["live", "test"]);
  });

  it("rejects a mode that is neither test nor live", async () => {
    // Stripe has exactly two. A third value here would be a mode the window
    // query silently never counts, which reads as a mode that is never clean.
    await expect(insert("mode, outcome", ["sandbox", "clean"])).rejects.toThrow(
      /plan_catalog_parity_runs_mode_is_a_known_mode/,
    );
  });

  it("rejects a NULL mode", async () => {
    await expect(insert("mode, outcome", [null, "clean"])).rejects.toThrow(/mode/);
  });

  it("refuses a row that does not state its mode, rather than inheriting one", async () => {
    // The column is added WITH a default so the ALTER succeeds on a populated
    // table, and the default is then DROPPED. This is the assertion that the
    // drop happened: a writer that forgets the mode must fail, not silently
    // file its run under `test`. A live run recorded as a test run is the one
    // error that would make "both modes clean" answerable by one mode alone.
    await expect(insert("outcome", ["clean"])).rejects.toThrow(/mode/);
  });
});

describe("not_bootstrapped", () => {
  it("is storable, with no differences and no error", async () => {
    // Live Stripe today: zero `mark8ly_*` prices, zero products, zero
    // subscriptions. Not 42 findings — nothing here yet.
    await insert("mode, outcome", ["live", "not_bootstrapped"]);

    const { rows } = await db.query<{
      outcome: string;
      difference_count: number;
      differences: unknown;
      error: string | null;
    }>("SELECT * FROM plan_catalog_parity_runs");

    expect(rows[0].outcome).toBe("not_bootstrapped");
    expect(Number(rows[0].difference_count)).toBe(0);
    expect(rows[0].differences).toEqual([]);
    expect(rows[0].error).toBeNull();
  });

  it("is unstorable with differences", async () => {
    // The coherence rule that makes the state mean anything. "Nothing here
    // yet" and "something here is wrong" are different facts, and a row
    // asserting both is a row that cannot be read.
    await expect(
      insert("mode, outcome, difference_count, differences", [
        "live",
        "not_bootstrapped",
        1,
        JSON.stringify([{ kind: "price_missing_in_stripe" }]),
      ]),
    ).rejects.toThrow(/plan_catalog_parity_runs_outcome_matches_difference_count/);
  });

  it("is unstorable with an error, because it is a finding and not a failure", async () => {
    // 0033's rule, unchanged and still biting: `error` is set exactly when the
    // outcome is `failed`. `not_bootstrapped` is an ANSWER — the check ran and
    // found an empty account.
    await expect(
      insert("mode, outcome, error", ["live", "not_bootstrapped", "nothing there"]),
    ).rejects.toThrow(/plan_catalog_parity_runs_error_belongs_to_failed/);
  });

  it("is not clean, which is what makes the two-mode gate bite", async () => {
    // Stated as a query rather than as prose because #327's gate is "7
    // consecutive days where BOTH modes are clean", and it falls out of the
    // schema without special-casing precisely because this row does not match
    // `outcome = 'clean'`.
    await insert("mode, outcome", ["live", "not_bootstrapped"]);
    const { rows } = await db.query<{ n: string | number }>(
      "SELECT count(*) AS n FROM plan_catalog_parity_runs WHERE outcome = 'clean'",
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe("0033's rules survive the constraints being recreated", () => {
  // 0034 drops and re-adds both the outcome CHECK and the coherence CHECK. A
  // clause silently lost in that rewrite would leave 0033's own suite green
  // against a schema that no longer exists anywhere.
  it("still rejects an unknown outcome", async () => {
    await expect(insert("mode, outcome", ["test", "probably_fine"])).rejects.toThrow(
      /plan_catalog_parity_runs_outcome_is_a_known_state/,
    );
  });

  it("still rejects a clean run carrying differences", async () => {
    await expect(
      insert("mode, outcome, difference_count, differences", [
        "test",
        "clean",
        1,
        JSON.stringify([{ kind: "amount_mismatch" }]),
      ]),
    ).rejects.toThrow(/plan_catalog_parity_runs_outcome_matches_difference_count/);
  });

  it("still rejects a differences run carrying none", async () => {
    await expect(
      insert("mode, outcome, difference_count", ["test", "differences", 0]),
    ).rejects.toThrow(/plan_catalog_parity_runs_outcome_matches_difference_count/);
  });

  it("still rejects a failed run with no reason", async () => {
    await expect(insert("mode, outcome", ["test", "failed"])).rejects.toThrow(
      /plan_catalog_parity_runs_error_belongs_to_failed/,
    );
  });

  it("still refuses a summary that disagrees with its evidence", async () => {
    await expect(
      insert("mode, outcome, difference_count, differences", [
        "test",
        "differences",
        2,
        JSON.stringify([{ kind: "amount_mismatch" }]),
      ]),
    ).rejects.toThrow(/plan_catalog_parity_runs_count_matches_differences/);
  });

  it("still names the array constraint rather than raising on jsonb_array_length", async () => {
    await expect(
      insert("mode, outcome, difference_count, differences", [
        "test",
        "differences",
        1,
        JSON.stringify({}),
      ]),
    ).rejects.toThrow(/plan_catalog_parity_runs_differences_is_an_array/);
  });
});

describe("a populated table", () => {
  it("takes the column without losing the rows that predate it", async () => {
    // Prod is at v33 with ZERO rows, so this is not a prod concern — but dev
    // databases have rows, and a migration that fails there is a migration
    // nobody can rehearse before applying it to prod by hand.
    const fresh = new PGlite();
    try {
      await fresh.exec(readFileSync(MIGRATIONS[0], "utf-8"));
      await fresh.query(
        "INSERT INTO plan_catalog_parity_runs (outcome) VALUES ('clean'), ('clean')",
      );
      await fresh.exec(readFileSync(MIGRATIONS[1], "utf-8"));

      const { rows } = await fresh.query<{ mode: string }>(
        "SELECT mode FROM plan_catalog_parity_runs",
      );
      // Backfilled as `test`, which is the truth: every run that exists
      // before this migration was made against the only key there was, and
      // that key was `sk_test_`.
      expect(rows.map((r) => r.mode)).toEqual(["test", "test"]);
    } finally {
      await fresh.close();
    }
  });
});

describe("re-runnability", () => {
  it("is idempotent — applying it twice is harmless", async () => {
    // Migrations are applied by hand before merge in this estate, and a
    // retried run must not error out halfway.
    await db.exec(readFileSync(MIGRATIONS[1], "utf-8"));
    await insert("mode, outcome", ["test", "clean"]);
    const { rows } = await db.query<{ total: string | number }>(
      "SELECT count(*) AS total FROM plan_catalog_parity_runs",
    );
    expect(Number(rows[0].total)).toBe(1);
  });

  it("still has no default after a second application", async () => {
    // The re-run re-adds nothing that would restore the dropped default.
    await db.exec(readFileSync(MIGRATIONS[1], "utf-8"));
    await expect(insert("outcome", ["clean"])).rejects.toThrow(/mode/);
  });
});
