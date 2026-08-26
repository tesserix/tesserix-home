import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Integration coverage for `0033_plan_catalog_parity_runs.sql`.
 *
 * Same shape as `plan-catalog.integration.test.ts`: no repository module under
 * test, just the migration run against a real (in-process) Postgres via
 * pglite, because the thing being asserted is what the ENGINE will and will
 * not accept.
 *
 * The constraints here are the whole point of the table. #326's window is
 * "clean for 7 consecutive days", answered by a query over these rows rather
 * than by anyone's recollection — and a query is only as good as the rows'
 * coherence. A `clean` row carrying differences, or a `failed` row with no
 * reason, would make the window's own answer untrustworthy in the one
 * direction that matters: P2 revokes mark8ly's Stripe write key on it.
 *
 * A constraint nobody tries to violate is a comment with SQL syntax.
 */

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../web/db/migrations/0033_plan_catalog_parity_runs.sql",
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
  await db.exec(readFileSync(MIGRATION_PATH, "utf-8"));
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.query("DELETE FROM plan_catalog_parity_runs");
});

describe("the three outcomes", () => {
  it("stores a clean run with no differences", async () => {
    await insert("outcome", ["clean"]);
    const { rows } = await db.query<{
      outcome: string;
      difference_count: number;
      differences: unknown;
      error: string | null;
      ran_at: Date;
    }>("SELECT * FROM plan_catalog_parity_runs");

    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("clean");
    expect(Number(rows[0].difference_count)).toBe(0);
    expect(rows[0].differences).toEqual([]);
    expect(rows[0].error).toBeNull();
    expect(rows[0].ran_at).toBeInstanceOf(Date);
  });

  it("stores a differences run carrying the full report", async () => {
    const report = [
      {
        kind: "amount_mismatch",
        lookupKey: "mark8ly_starter_monthly_ppp_vnd_v1",
        currency: "vnd",
        catalogUnitAmountMinor: 32900000,
        stripeUnitAmountMinor: 329000,
        zeroDecimalSuspect: true,
      },
    ];
    await insert("outcome, difference_count, differences", [
      "differences",
      report.length,
      JSON.stringify(report),
    ]);

    const { rows } = await db.query<{ differences: typeof report }>(
      "SELECT differences FROM plan_catalog_parity_runs",
    );
    // The whole report, not a summary: the point of storing it is that a
    // finding stays actionable a week after the run that produced it.
    expect(rows[0].differences).toEqual(report);
  });

  it("stores a failed run with its reason", async () => {
    // THREE STATES, NOT A BOOLEAN. A run that could not reach Stripe is not
    // clean; collapsing it into `false` would let an outage read as a
    // difference or — far worse — a failure read as a clean day.
    await insert("outcome, error", [
      "failed",
      "STRIPE_RESTRICTED_READ_KEY is not set",
    ]);
    const { rows } = await db.query<{ outcome: string; error: string }>(
      "SELECT outcome, error FROM plan_catalog_parity_runs",
    );
    expect(rows[0]).toEqual({
      outcome: "failed",
      error: "STRIPE_RESTRICTED_READ_KEY is not set",
    });
  });

  it("rejects a fourth outcome", async () => {
    await expect(insert("outcome", ["unknown"])).rejects.toThrow(
      /plan_catalog_parity_runs_outcome_is_a_known_state/,
    );
  });
});

describe("an incoherent row is unstorable", () => {
  it("rejects a clean run that carries differences", async () => {
    await expect(
      insert("outcome, difference_count, differences", [
        "clean",
        1,
        JSON.stringify([{ kind: "amount_mismatch" }]),
      ]),
    ).rejects.toThrow(/plan_catalog_parity_runs_outcome_matches_difference_count/);
  });

  it("rejects a differences run that carries none", async () => {
    await expect(
      insert("outcome, difference_count", ["differences", 0]),
    ).rejects.toThrow(/plan_catalog_parity_runs_outcome_matches_difference_count/);
  });

  it("rejects a count that disagrees with the report it summarises", async () => {
    // `difference_count` is a materialised `jsonb_array_length`, kept as its
    // own indexed column for the 7-day query. Letting the two drift would mean
    // the fast query and the stored evidence could tell different stories.
    await expect(
      insert("outcome, difference_count, differences", [
        "differences",
        5,
        JSON.stringify([{ kind: "amount_mismatch" }]),
      ]),
    ).rejects.toThrow(/plan_catalog_parity_runs_count_matches_differences/);
  });

  it("rejects a differences payload that is not an array", async () => {
    await expect(
      insert("outcome, difference_count, differences", [
        "differences",
        1,
        JSON.stringify({ kind: "amount_mismatch" }),
      ]),
    ).rejects.toThrow(/plan_catalog_parity_runs_differences_is_an_array/);
  });

  it("rejects a negative difference count", async () => {
    await expect(
      insert("outcome, difference_count", ["differences", -1]),
    ).rejects.toThrow(/plan_catalog_parity_runs/);
  });
});

describe("`error` belongs to `failed` and nowhere else", () => {
  it("rejects a failed run with no reason", async () => {
    // A `failed` row whose reason is null is a gap in the window that nobody
    // can diagnose later — which is the same invisibility the three-state
    // outcome exists to prevent.
    await expect(insert("outcome", ["failed"])).rejects.toThrow(
      /plan_catalog_parity_runs_error_belongs_to_failed/,
    );
  });

  it("rejects an error on a clean run", async () => {
    await expect(
      insert("outcome, error", ["clean", "something went wrong"]),
    ).rejects.toThrow(/plan_catalog_parity_runs_error_belongs_to_failed/);
  });

  it("rejects an error on a differences run", async () => {
    await expect(
      insert("outcome, difference_count, differences, error", [
        "differences",
        1,
        JSON.stringify([{ kind: "amount_mismatch" }]),
        "something went wrong",
      ]),
    ).rejects.toThrow(/plan_catalog_parity_runs_error_belongs_to_failed/);
  });
});

describe("the 7-day window query this table exists to answer", () => {
  it("can distinguish a clean week from a week with a gap", async () => {
    // The query P1b will render. Written here because the table's whole
    // justification is that this question has a mechanical answer: a `failed`
    // day and a MISSING day must both fail to count as clean.
    const day = (n: number) => `now() - interval '${n} days'`;
    // The failed day carries its reason inline: the table refuses a `failed`
    // row without one, which is the constraint two describes above.
    await db.exec(`
      INSERT INTO plan_catalog_parity_runs (outcome, ran_at, error) VALUES
        ('clean', ${day(6)}, NULL), ('clean', ${day(5)}, NULL), ('clean', ${day(4)}, NULL),
        ('failed', ${day(3)}, 'stripe unreachable'),
        ('clean', ${day(2)}, NULL), ('clean', ${day(1)}, NULL),
        ('clean', now(), NULL);
    `);

    const { rows } = await db.query<{ clean_days: string | number }>(
      `SELECT count(DISTINCT date_trunc('day', ran_at)) AS clean_days
         FROM plan_catalog_parity_runs
        WHERE ran_at >= now() - interval '7 days'
          AND outcome = 'clean'`,
    );
    // Six clean days out of seven — not a clean week, and the failed day is
    // why. A boolean column could not have told these apart.
    expect(Number(rows[0].clean_days)).toBe(6);
  });
});

describe("re-runnability", () => {
  it("is idempotent — applying it twice is harmless", async () => {
    // Migrations are applied by hand before merge in this estate, and a
    // retried run must not error out halfway.
    await db.exec(readFileSync(MIGRATION_PATH, "utf-8"));
    await insert("outcome", ["clean"]);
    const { rows } = await db.query<{ total: string | number }>(
      "SELECT count(*) AS total FROM plan_catalog_parity_runs",
    );
    expect(Number(rows[0].total)).toBe(1);
  });
});
