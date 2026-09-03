import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
 *
 * `readLatestRuns` is added below rather than in its own file: it reads the
 * same table through the same `record`/`cleanWeek` fixtures, and its own
 * "every pair, always" discipline is the same property `readWindowStatus`
 * asserts above — a second file would just re-declare the same helpers.
 *
 * Both reads became per-(mode, source) in tesserix-home#392, and the same
 * argument applies one axis over: a mode-keyed window cannot speak for two
 * catalogs, and the failure is an OMISSION rather than a wrong answer — the
 * remaining source still comes back clean and the window still reads as
 * satisfied. See "a run recorded for one source" below for the regression
 * test that names it.
 */

// 0044 and 0045 are both applied, in that order and both of them. 0044 adds
// `source` WITH a default so the previously-deployed image keeps writing rows
// during a rollout; 0045 drops that default once the source-aware image is
// live. Applying only 0044 here would let an INSERT that forgot `source`
// silently succeed and be filed as mark8ly's, which is the exact thing the
// column exists to prevent — so this suite runs against the schema prod ends
// up with, not the one it passes through.
const MIGRATIONS = [
  "0033_plan_catalog_parity_runs.sql",
  "0034_parity_runs_mode.sql",
  "0044_parity_runs_source.sql",
  "0045_parity_runs_source_drop_default.sql",
].map((name) => path.resolve(__dirname, "../../../web/db/migrations", name));

/** The one source `CATALOG_SOURCES` holds today, spelled out here rather than
 *  imported so this file's fixtures stay readable as SQL values. Kept in step
 *  with `source-policy.ts` by the assertions below, which iterate the real
 *  constant. */
const SOURCE = "mark8ly";

/** A source the CHECK in 0044 does NOT admit, used only by the regression test
 *  below — which relaxes that constraint on purpose, because the whole point
 *  is to observe what a SECOND source's rows do to a window that has not been
 *  told about them. */
const OTHER_SOURCE = "otherproduct";

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

// Iterated, never hardcoded, in the "every pair" assertions below: writing
// out today's list would let those assertions keep passing the day a second
// source is added and NOT covered, which is the tesserix-home#392 failure
// reproduced inside the test written to prevent it.
import { CATALOG_SOURCES } from "@/lib/billing/source-policy";
import { STRIPE_MODES } from "@/lib/billing/stripe-read";

const { readWindowStatus, readLatestRuns } = await import("./plan-catalog-repo");

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
  { error = null as string | null, differenceCount = 0, source = SOURCE } = {},
) {
  await db.query(
    `INSERT INTO plan_catalog_parity_runs
       (mode, source, outcome, ran_at, error, difference_count, differences)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      mode,
      // Named, never defaulted — 0045 has removed the column default by the
      // time this runs, so an omission here would fail the insert outright.
      source,
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

/** Seven consecutive clean days for one (mode, source) pair, today back to six
 *  days ago. */
async function cleanWeek(mode: string, source = SOURCE) {
  for (let n = 0; n < 7; n += 1) await record(mode, "clean", n, { source });
}

const pairOf = (
  status: Awaited<ReturnType<typeof readWindowStatus>>,
  mode: string,
  source = SOURCE,
) => status.pairs.find((p) => p.mode === mode && p.source === source)!;

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

describe("ran — whether ANY run happened, independent of clean", () => {
  it("is true for a clean day", async () => {
    await record("test", "clean", 0);
    const status = await readWindowStatus(7);
    const today = pairOf(status, "test").days.at(-1)!;
    expect(today.ran).toBe(true);
    expect(today.clean).toBe(true);
  });

  it("is true for a dirty day — a day that ran and was not clean", async () => {
    await record("test", "differences", 0, { differenceCount: 1 });
    const status = await readWindowStatus(7);
    const today = pairOf(status, "test").days.at(-1)!;
    expect(today.ran).toBe(true);
    expect(today.clean).toBe(false);
  });

  it("is false for a day with no rows at all — the gap the console must not paint red", async () => {
    // The exact production bug this field exists to fix: a brand-new check
    // with six days of silence and one clean day rendered as "a week of
    // failure" because `clean: false` alone cannot be told apart from
    // "never ran". `ran: false` is what lets a caller draw that line.
    const status = await readWindowStatus(7);
    for (const pair of status.pairs) {
      for (const day of pair.days) {
        expect(day.ran).toBe(false);
        expect(day.clean).toBe(false);
      }
    }
  });

  it("is false for a day the whole window skips over, even when other days in the window ran", async () => {
    await cleanWeek("test");
    await db.query(
      "DELETE FROM plan_catalog_parity_runs WHERE mode = 'test' AND ran_at < $1",
      [daysAgo(2)],
    );

    const status = await readWindowStatus(7);
    const days = pairOf(status, "test").days;

    // `ran_at < daysAgo(2)` deletes the four oldest of the seven rows
    // `cleanWeek` wrote (n=3..6) and keeps the three most recent (n=0..2, kept
    // because `<` is strict). The three most recent days must still read as
    // ran; the four before them must read as gaps, not as dirty days.
    const gapDays = days.slice(0, 4);
    const ranDays = days.slice(4);
    expect(gapDays.every((d) => !d.ran)).toBe(true);
    expect(ranDays.every((d) => d.ran)).toBe(true);
  });
});

describe("the gate #327 cites", () => {
  it("is satisfied only when EVERY (mode, source) pair is clean for the whole window", async () => {
    await cleanWeek("test");
    await cleanWeek("live");

    const status = await readWindowStatus(7);

    expect(status.satisfied).toBe(true);
    expect(pairOf(status, "test").satisfied).toBe(true);
    expect(pairOf(status, "live").satisfied).toBe(true);
  });

  it("is NOT satisfied when one mode is clean and the other is not", async () => {
    // Today's actual estate, near enough: test has a catalog and live does
    // not. This is the assertion that parks #327 behind a live bootstrap
    // rather than letting test's seven days answer for both.
    await cleanWeek("test");
    for (let n = 0; n < 7; n += 1) await record("live", "not_bootstrapped", n);

    const status = await readWindowStatus(7);

    expect(pairOf(status, "test").satisfied).toBe(true);
    expect(pairOf(status, "live").satisfied).toBe(false);
    expect(status.satisfied).toBe(false);
  });

  it("reports every pair even when one has never run at all", async () => {
    // Live has no rows today. A query that returned only the pairs PRESENT in
    // the table would omit live entirely, and a caller reducing over "every
    // pair returned" would then find every pair satisfied — the gate passing
    // because the failing side was invisible.
    await cleanWeek("test");

    const status = await readWindowStatus(7);

    expect(status.pairs.map((p) => `${p.mode}/${p.source}`)).toEqual(
      STRIPE_MODES.flatMap((mode) => CATALOG_SOURCES.map((source) => `${mode}/${source}`)),
    );
    expect(pairOf(status, "live").satisfied).toBe(false);
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
    const test = pairOf(status, "test");

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
    for (const pair of status.pairs) {
      expect(pair.satisfied).toBe(false);
      expect(pair.days.every((d) => !d.clean)).toBe(true);
    }
  });

  it("counts DAYS, not runs", async () => {
    // Seven clean runs on a single day is one clean day. A count of rows would
    // read this as a satisfied week within an hour of deploying the check.
    for (let i = 0; i < 7; i += 1) await record("test", "clean", 0);
    for (let i = 0; i < 7; i += 1) await record("live", "clean", 0);

    const status = await readWindowStatus(7);

    expect(status.satisfied).toBe(false);
    expect(pairOf(status, "test").days.filter((d) => d.clean)).toHaveLength(1);
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
    expect(pairOf(status, "test").satisfied).toBe(false);
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
    const day = pairOf(status, "test").days.find((d) => !d.clean);

    expect(day).toBeDefined();
    expect(pairOf(status, "test").satisfied).toBe(false);
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

    for (const pair of status.pairs) {
      expect(pair.days).toHaveLength(7);
      const dates = pair.days.map((d) => d.day);
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
    expect(pairOf(status, "test").days).toHaveLength(3);
  });

  it.each([0, -1, 1.5, Number.NaN, 400])("refuses a window of %s days", async (days) => {
    // Validated at the boundary rather than interpolated into SQL and hoped
    // about. A non-integer reaches `make_interval` and a huge one generates a
    // series nobody asked for.
    await expect(readWindowStatus(days)).rejects.toThrow(/window/i);
  });
});

describe("readLatestRuns", () => {
  const runOf = (
    runs: Awaited<ReturnType<typeof readLatestRuns>>,
    mode: string,
    source = SOURCE,
  ) => runs.find((r) => r.mode === mode && r.source === source)!.run;

  it("picks the most recent run per (mode, source) pair, not merely a row", async () => {
    // Older first, so a query that read insertion order rather than `ran_at`
    // would report the wrong one.
    await record("test", "failed", 3, { error: "stripe unreachable" });
    await record("test", "clean", 0);

    const runs = await readLatestRuns();

    expect(runOf(runs, "test")?.outcome).toBe("clean");
  });

  it("reports every pair even when one has never run — the #326 empty state", async () => {
    await record("test", "clean", 0);

    const runs = await readLatestRuns();

    expect(runs.map((r) => `${r.mode}/${r.source}`)).toEqual(
      STRIPE_MODES.flatMap((mode) => CATALOG_SOURCES.map((source) => `${mode}/${source}`)),
    );
    expect(runOf(runs, "live")).toBeNull();
  });

  it("returns every pair null on a table with no rows at all", async () => {
    const runs = await readLatestRuns();
    expect(runs).toEqual(
      STRIPE_MODES.flatMap((mode) =>
        CATALOG_SOURCES.map((source) => ({ mode, source, run: null })),
      ),
    );
  });

  it("carries the stored differences report, so a red day can be read without psql", async () => {
    await record("live", "differences", 0, { differenceCount: 2 });

    const runs = await readLatestRuns();
    const run = runOf(runs, "live");

    expect(run?.differenceCount).toBe(2);
    expect(run?.differences).toHaveLength(2);
    expect(run?.differences[0]).toEqual({ kind: "amount_mismatch" });
  });
});

describe("a run recorded for one source does not answer for another — tesserix-home#392", () => {
  /**
   * The regression this issue exists for, and the reason it is worth a
   * relaxed constraint to write.
   *
   * `CATALOG_SOURCES` holds exactly one entry today, and 0044's
   * `..._source_is_a_known_source` CHECK admits exactly that one — deliberately,
   * so a second source becomes a migration rather than a surprise. That makes
   * the failure UNREPRODUCIBLE through the public API: with one source, a
   * mode-keyed query and a pair-keyed one return identical rows, which is
   * precisely why the omission survived until now.
   *
   * So these tests drop the CHECK for their own duration and write rows for a
   * source the console has never been told about. That is the shape of the
   * real hazard: rows land in the shared table under a source nothing iterates,
   * their drift is compared against nothing, and — the dangerous part — the
   * mark8ly rows still come back clean and the window still reads as satisfied.
   *
   * The constraint is restored in `afterEach` so no later test in this file
   * runs against a schema prod does not have.
   */

  beforeEach(async () => {
    await db.exec(
      "ALTER TABLE plan_catalog_parity_runs DROP CONSTRAINT plan_catalog_parity_runs_source_is_a_known_source",
    );
  });

  afterEach(async () => {
    await db.query("DELETE FROM plan_catalog_parity_runs");
    await db.exec(
      `ALTER TABLE plan_catalog_parity_runs
         ADD CONSTRAINT plan_catalog_parity_runs_source_is_a_known_source
         CHECK (source IN ('mark8ly'))`,
    );
  });

  it("a clean week under another source leaves this source's window unsatisfied", async () => {
    // Before this change, `readWindowStatus` correlated on `mode` alone, so
    // these seven rows would have counted as seven clean days for
    // (test, mark8ly) — one catalog answering for a catalog it never read.
    await cleanWeek("test", OTHER_SOURCE);
    await cleanWeek("live", OTHER_SOURCE);

    const status = await readWindowStatus(7);

    expect(pairOf(status, "test").satisfied).toBe(false);
    expect(pairOf(status, "live").satisfied).toBe(false);
    expect(status.satisfied).toBe(false);
    // And not merely "not clean": those days must read as GAPS. Nothing ran
    // for this pair, and a day painted as a failure would send an operator
    // looking for drift that was never measured.
    expect(pairOf(status, "test").days.every((d) => !d.ran)).toBe(true);
  });

  it("another source's dirty week does not break this source's clean one", async () => {
    // The mirror image, and the half that makes the first test mean something:
    // the correlation has to be an equality on `source`, not an exclusion of
    // whatever happens to be in the table. A pair that really was clean for
    // seven days stays satisfied while a neighbouring source is failing.
    await cleanWeek("test");
    await cleanWeek("live");
    for (let n = 0; n < 7; n += 1) {
      await record("test", "failed", n, { error: "other product is broken", source: OTHER_SOURCE });
    }

    const status = await readWindowStatus(7);

    expect(pairOf(status, "test").satisfied).toBe(true);
    expect(pairOf(status, "live").satisfied).toBe(true);
    // `satisfied` is the conjunction over the pairs the console KNOWS about,
    // and `otherproduct` is not one of them — it is not in `CATALOG_SOURCES`,
    // so it produces no cells and no verdict. That is the honest answer for a
    // source that has not been added by a migration: this read cannot report
    // on a source it was never given.
    // Asserted as "the reported sources are exactly `CATALOG_SOURCES`" rather
    // than "`OTHER_SOURCE` is absent", because `ParityWindowPair.source` is
    // `CatalogSource` and the comparison would not typecheck — which is itself
    // the point: the console cannot even NAME a source it has not been given.
    expect([...new Set(status.pairs.map((p) => p.source))]).toEqual([...CATALOG_SOURCES]);
    expect(status.satisfied).toBe(true);
  });

  it("readLatestRuns does not hand one source's latest run to another", async () => {
    // `DISTINCT ON (mode)` would return whichever source ran LAST for the
    // mode. Here that is `otherproduct`'s failure, and an operator reading the
    // (test, mark8ly) card would see a red badge belonging to a catalog they
    // were not looking at — or, with the outcomes swapped, a green one.
    await record("test", "clean", 1);
    await record("test", "failed", 0, { error: "other product is broken", source: OTHER_SOURCE });

    const runs = await readLatestRuns();
    const run = runs.find((r) => r.mode === "test" && r.source === SOURCE)!.run;

    expect(run?.outcome).toBe("clean");
    expect([...new Set(runs.map((r) => r.source))]).toEqual([...CATALOG_SOURCES]);
  });
});
