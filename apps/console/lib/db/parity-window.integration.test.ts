import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `readWindowStatus` — the query #327 will actually cite, run against a real
 * (in-process) Postgres via pglite.
 *
 * Shape assertions would be worthless here. This is date arithmetic with a
 * generated day series and two correlated subqueries, and the two ways to get
 * it wrong both produce SQL that looks entirely reasonable:
 *
 *  - Counting clean ROWS instead of clean DAYS. Seven runs on one day then
 *    reads as a satisfied week.
 *  - Reading the window as "no non-clean rows in the last 7 days", which is
 *    satisfied by a table containing NO ROWS AT ALL. That is the absence of
 *    evidence being taken as evidence of agreement, and it is the single
 *    failure that would let a write key be revoked on a check that never ran.
 *
 * Both of those pass any conceivable substring assertion. Only a real engine
 * with real rows tells them apart.
 */

const MIGRATIONS = ["0033_plan_catalog_parity_runs.sql", "0034_parity_runs_mode.sql"].map(
  (name) => path.resolve(__dirname, "../../../web/db/migrations", name),
);

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

const { readWindowStatus } = await import("./plan-catalog-repo");

let db: PGlite;

/** A run `n` days ago, UTC, at midday — far enough from either boundary that
 *  the test is about the query and not about a rounding accident. */
const daysAgo = (n: number) => {
  const at = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  at.setUTCHours(12, 0, 0, 0);
  return at.toISOString();
};

async function record(
  mode: string,
  outcome: string,
  n: number,
  { error = null as string | null, differenceCount = 0 } = {},
) {
  await db.query(
    `INSERT INTO plan_catalog_parity_runs
       (mode, outcome, ran_at, error, difference_count, differences)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      mode,
      outcome,
      daysAgo(n),
      error,
      differenceCount,
      JSON.stringify(
        Array.from({ length: differenceCount }, () => ({ kind: "amount_mismatch" })),
      ),
    ],
  );
}

/** Seven consecutive clean days, today back to six days ago. */
async function cleanWeek(mode: string) {
  for (let n = 0; n < 7; n += 1) await record(mode, "clean", n);
}

const modeOf = (status: Awaited<ReturnType<typeof readWindowStatus>>, mode: string) =>
  status.modes.find((m) => m.mode === mode)!;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;
  for (const file of MIGRATIONS) await db.exec(readFileSync(file, "utf-8"));
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.query("DELETE FROM plan_catalog_parity_runs");
});

describe("the gate #327 cites", () => {
  it("is satisfied only when BOTH modes are clean for the whole window", async () => {
    await cleanWeek("test");
    await cleanWeek("live");

    const status = await readWindowStatus(7);

    expect(status.satisfied).toBe(true);
    expect(modeOf(status, "test").satisfied).toBe(true);
    expect(modeOf(status, "live").satisfied).toBe(true);
  });

  it("is NOT satisfied when one mode is clean and the other is not", async () => {
    // Today's actual estate, near enough: test has a catalog and live does
    // not. This is the assertion that parks #327 behind a live bootstrap
    // rather than letting test's seven days answer for both.
    await cleanWeek("test");
    for (let n = 0; n < 7; n += 1) await record("live", "not_bootstrapped", n);

    const status = await readWindowStatus(7);

    expect(modeOf(status, "test").satisfied).toBe(true);
    expect(modeOf(status, "live").satisfied).toBe(false);
    expect(status.satisfied).toBe(false);
  });

  it("reports both modes even when one has never run at all", async () => {
    // Live has no rows today. A query that returned only the modes PRESENT in
    // the table would omit live entirely, and a caller reducing over "every
    // mode returned" would then find every mode satisfied — the gate passing
    // because the failing side was invisible.
    await cleanWeek("test");

    const status = await readWindowStatus(7);

    expect(status.modes.map((m) => m.mode)).toEqual(["test", "live"]);
    expect(modeOf(status, "live").satisfied).toBe(false);
    expect(status.satisfied).toBe(false);
  });
});

describe("a missing day is absence of evidence", () => {
  it("is not clean, and not satisfied", async () => {
    // Six days ran and one did not — a CronJob that failed to start, which
    // writes nothing at all. Never counted as agreement.
    await cleanWeek("test");
    await db.query(
      "DELETE FROM plan_catalog_parity_runs WHERE mode = 'test' AND ran_at < $1",
      [daysAgo(2)],
    );
    await cleanWeek("live");

    const status = await readWindowStatus(7);
    const test = modeOf(status, "test");

    expect(test.satisfied).toBe(false);
    expect(test.days.filter((d) => !d.clean).length).toBeGreaterThan(0);
    expect(status.satisfied).toBe(false);
  });

  it("is not satisfied by an entirely empty table", async () => {
    // The single most dangerous wrong query: "no non-clean rows in the last 7
    // days" is TRUE of a table with no rows. A window satisfied by a check
    // that never ran is the one outcome that must be impossible.
    const status = await readWindowStatus(7);

    expect(status.satisfied).toBe(false);
    for (const mode of status.modes) {
      expect(mode.satisfied).toBe(false);
      expect(mode.days.every((d) => !d.clean)).toBe(true);
    }
  });

  it("counts DAYS, not runs", async () => {
    // Seven clean runs on a single day is one clean day. A count of rows would
    // read this as a satisfied week within an hour of deploying the check.
    for (let i = 0; i < 7; i += 1) await record("test", "clean", 0);
    for (let i = 0; i < 7; i += 1) await record("live", "clean", 0);

    const status = await readWindowStatus(7);

    expect(status.satisfied).toBe(false);
    expect(modeOf(status, "test").days.filter((d) => d.clean)).toHaveLength(1);
  });
});

describe("what breaks a day", () => {
  it.each([
    ["failed", { error: "stripe unreachable" }],
    ["differences", { differenceCount: 1 }],
    ["not_bootstrapped", {}],
  ])("a %s run leaves the day not clean", async (outcome, extra) => {
    await cleanWeek("test");
    await cleanWeek("live");
    await db.query(
      "DELETE FROM plan_catalog_parity_runs WHERE mode = 'test' AND ran_at >= $1",
      [daysAgo(3)],
    );
    await record("test", outcome, 3, extra);

    const status = await readWindowStatus(7);
    expect(modeOf(status, "test").satisfied).toBe(false);
  });

  it("a day holding both a clean run and a failed one is not clean", async () => {
    // The strict reading, and it is a choice: a re-run that succeeded does not
    // erase the run that did not. The window gates a credential revocation, so
    // a day anyone could argue about is a day that does not count. It is also
    // the recoverable direction — the cost is waiting another week.
    await cleanWeek("test");
    await cleanWeek("live");
    await record("test", "failed", 3, { error: "stripe unreachable" });

    const status = await readWindowStatus(7);
    const day = modeOf(status, "test").days.find((d) => !d.clean);

    expect(day).toBeDefined();
    expect(modeOf(status, "test").satisfied).toBe(false);
  });

  it("a run outside the window does not break a day inside it", async () => {
    await cleanWeek("test");
    await cleanWeek("live");
    await record("test", "failed", 30, { error: "ancient history" });

    const status = await readWindowStatus(7);
    expect(status.satisfied).toBe(true);
  });
});

describe("the window's own shape", () => {
  it("reports exactly the days asked for, most recent last", async () => {
    const status = await readWindowStatus(7);

    for (const mode of status.modes) {
      expect(mode.days).toHaveLength(7);
      const dates = mode.days.map((d) => d.day);
      expect([...dates].sort()).toEqual(dates);
    }
    expect(status.days).toBe(7);
  });

  it("answers for a window of another length", async () => {
    // 7 is #327's number, not this function's. A caller asking for 3 must not
    // get 7 days silently.
    for (let n = 0; n < 3; n += 1) {
      await record("test", "clean", n);
      await record("live", "clean", n);
    }

    const status = await readWindowStatus(3);

    expect(status.days).toBe(3);
    expect(status.satisfied).toBe(true);
    expect(modeOf(status, "test").days).toHaveLength(3);
  });

  it.each([0, -1, 1.5, Number.NaN, 400])("refuses a window of %s days", async (days) => {
    // Validated at the boundary rather than interpolated into SQL and hoped
    // about. A non-integer reaches `make_interval` and a huge one generates a
    // series nobody asked for.
    await expect(readWindowStatus(days)).rejects.toThrow(/window/i);
  });
});
