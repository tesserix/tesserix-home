import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `readModeDivergence` — tesserix-home#527's check, run against a real
 * (in-process) Postgres via pglite.
 *
 * Shape assertions would prove nothing here. The two ways to get this wrong
 * both produce a function that looks entirely reasonable and answers wrongly
 * on states production has actually been in:
 *
 *  - Comparing `revision_id` instead of content. Measured against production
 *    on 2026-09-04, `test` and `live` named DIFFERENT revisions and served
 *    IDENTICAL content — 78 rows each, symmetric difference 0. A
 *    revision-keyed check would have reported divergence on a state where
 *    there was none, on day one. "the revisions diverged, the content did
 *    not" below is that exact state.
 *  - Letting a mode with no current publication read as agreement. `live` was
 *    unpublished for long stretches of this project; the empty diff that
 *    state produces is the absence of evidence, not evidence of agreement —
 *    the same distinction mark8ly's `Result.Compared`/`Result.Differences`
 *    split exists for. "live has never been published" below is that state,
 *    and it is the test the mutation exercise targets.
 *
 * Same `vi.mock("./tesserix", ...)` redirection as
 * `plan-catalog-revisions.integration.test.ts`, so the repository's own SQL —
 * not a re-typed copy of it — runs against this pglite instance.
 */

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

import { SINGLE_SOURCE } from "@/lib/billing/source-policy";

const { readModeDivergence } = await import("./plan-catalog-repo");

const MIGRATIONS = [
  "0032_plan_catalog.sql",
  "0033_plan_catalog_parity_runs.sql",
  "0034_parity_runs_mode.sql",
  "0035_plan_catalog_revisions.sql",
].map((name) => path.resolve(__dirname, "../../../web/db/migrations", name));

/** 0035's baseline revision, holding 0032's seeded catalog. */
const BASELINE = "00000000-0000-0000-0000-000000000001";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;
  for (const file of MIGRATIONS) await db.exec(readFileSync(file, "utf-8"));
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  // Every test states its own publications, including 0035's own `test` one:
  // "which modes are published" is the fact under test, so no test may
  // inherit it. Order matters under FKs.
  await db.query("DELETE FROM plan_catalog_publications");
  await db.query("DELETE FROM plan_catalog_prices WHERE revision_id <> $1", [BASELINE]);
  await db.query("DELETE FROM plan_catalog_revisions WHERE id <> $1", [BASELINE]);
});

const insertRevision = async (note: string): Promise<string> => {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO plan_catalog_revisions (note, created_by) VALUES ($1, $2) RETURNING id",
    [note, "test"],
  );
  return rows[0].id;
};

const publish = (mode: "test" | "live", revisionId: string) =>
  db.query(
    "INSERT INTO plan_catalog_publications (mode, revision_id, published_by) VALUES ($1, $2, $3)",
    [mode, revisionId, "test"],
  );

/**
 * A byte-for-byte copy of `from`'s served rows under a new revision id.
 *
 * This is what makes "the revisions diverged, the content did not" a real
 * reproduction rather than a mock: the two revisions are separate rows with
 * separate uuids, exactly as production's were, and the only thing that could
 * make them compare equal is the content itself.
 */
const cloneRevision = async (from: string, note: string): Promise<string> => {
  const to = await insertRevision(note);
  await db.query(
    `WITH copied AS (
       INSERT INTO plan_catalog_prices (revision_id, source, lookup_key, plan, period, tier)
       SELECT $2, source, lookup_key, plan, period, tier
         FROM plan_catalog_prices WHERE revision_id = $1
       RETURNING id, source, lookup_key
     )
     INSERT INTO plan_catalog_amounts (price_id, currency, unit_amount_minor, tax_behavior)
     SELECT c.id, a.currency, a.unit_amount_minor, a.tax_behavior
       FROM copied c
       JOIN plan_catalog_prices p
         ON p.revision_id = $1 AND p.source = c.source AND p.lookup_key = c.lookup_key
       JOIN plan_catalog_amounts a ON a.price_id = p.id`,
    [from, to],
  );
  return to;
};

/** One amount of one revision, by lookup key and currency. */
const setAmount = (revisionId: string, lookupKey: string, currency: string, minor: number) =>
  db.query(
    `UPDATE plan_catalog_amounts a
        SET unit_amount_minor = $4
       FROM plan_catalog_prices p
      WHERE a.price_id = p.id AND p.revision_id = $1
        AND p.lookup_key = $2 AND a.currency = $3`,
    [revisionId, lookupKey, currency, minor],
  );

/** Swap one revision's row between the two tiers 0032's CHECK admits, and
 *  report which it landed on. */
async function flipTier(revisionId: string, lookupKey: string): Promise<string> {
  const { rows } = await db.query<{ tier: string }>(
    `UPDATE plan_catalog_prices
        SET tier = CASE WHEN tier = 'developed' THEN 'ppp' ELSE 'developed' END
      WHERE revision_id = $1 AND lookup_key = $2
      RETURNING tier`,
    [revisionId, lookupKey],
  );
  return rows[0].tier;
}

/** Some lookup key the seeded catalog actually holds, plus one of its
 *  currencies — picked from the data rather than transcribed, so a reseed
 *  cannot leave these tests silently asserting about a row that is gone. */
async function someSeededAmount(): Promise<{ lookupKey: string; currency: string }> {
  const { rows } = await db.query<{ lookup_key: string; currency: string }>(
    `SELECT p.lookup_key, a.currency
       FROM plan_catalog_prices p
       JOIN plan_catalog_amounts a ON a.price_id = p.id
      WHERE p.revision_id = $1
      ORDER BY p.lookup_key, a.currency
      LIMIT 1`,
    [BASELINE],
  );
  return { lookupKey: rows[0].lookup_key, currency: rows[0].currency };
}

describe("readModeDivergence", () => {
  it("reports not_published — never agreement — when live has never been published", async () => {
    // The state `live` was in for most of this project's life, and the one
    // this check must not dress up as a clean result. There is no diff to
    // report because there was no second side to read, which is a different
    // fact from "the two sides matched".
    await publish("test", BASELINE);

    const result = await readModeDivergence(SINGLE_SOURCE);

    expect(result.outcome).toBe("not_published");
    expect(result).toEqual({ outcome: "not_published", unpublishedModes: ["live"] });
    // Belt and braces on the property that matters: the shape carries no
    // difference count at all, so nothing downstream can read a zero off it.
    expect(result).not.toHaveProperty("differences");
    expect(result).not.toHaveProperty("rows");
  });

  it("names every unpublished mode when neither has been published", async () => {
    const result = await readModeDivergence(SINGLE_SOURCE);
    expect(result).toEqual({ outcome: "not_published", unpublishedModes: ["test", "live"] });
  });

  it("reports identical when the revisions diverged and the content did not", async () => {
    // Production, 2026-09-04: live named fb9c1667-… and test named the
    // 00000000-…-0001 baseline, and both served the same 78 rows. A check
    // keyed on `revision_id` fails HERE, on a state where the modes agree
    // exactly.
    const liveRevision = await cloneRevision(BASELINE, "live, same content");
    expect(liveRevision).not.toBe(BASELINE);
    await publish("test", BASELINE);
    await publish("live", liveRevision);

    const result = await readModeDivergence(SINGLE_SOURCE);

    expect(result.outcome).toBe("identical");
    // 78 in production and 78 here, because the fixture IS the seeded
    // catalog — asserted as an equality between the two sides rather than
    // against a literal, so a reseed changes the number and not the meaning.
    expect(result).toMatchObject({ rows: { test: expect.any(Number) } });
    if (result.outcome !== "identical") throw new Error("unreachable");
    expect(result.rows.test).toBe(result.rows.live);
    expect(result.rows.test).toBeGreaterThan(0);
  });

  it("reports both sides of an amount that changed in one mode", async () => {
    const { lookupKey, currency } = await someSeededAmount();
    const liveRevision = await cloneRevision(BASELINE, "live, one amount moved");
    await setAmount(liveRevision, lookupKey, currency, 999_999);
    await publish("test", BASELINE);
    await publish("live", liveRevision);

    const result = await readModeDivergence(SINGLE_SOURCE);

    if (result.outcome !== "diverged") throw new Error(`expected diverged, got ${result.outcome}`);
    // Both directions, not one: the row test serves and the row live serves.
    // A one-directional EXCEPT would report only half of this.
    expect(result.differences).toHaveLength(2);
    expect(result.differences.map((row) => row.mode).sort()).toEqual(["live", "test"]);
    expect(result.differences.every((row) => row.lookupKey === lookupKey)).toBe(true);
    expect(result.differences.find((row) => row.mode === "live")?.unitAmountMinor).toBe(999_999);
    // The counts are unchanged — divergence here is a changed row, not a
    // missing one, and reporting it as a count difference would be wrong.
    expect(result.rows.test).toBe(result.rows.live);
  });

  it("watches tier, which is not an amount", async () => {
    // `plan`, `period` and `tier` are in the compared tuple deliberately:
    // tesserix/mark8ly#631 added them to the Go-side Diff because they are
    // the fields the serving lookup keys on. A comparison of amounts alone
    // passes this test's fixture while the two modes serve different tiers
    // under the same key.
    const { lookupKey } = await someSeededAmount();
    const liveRevision = await cloneRevision(BASELINE, "live, one tier moved");
    // Flipped to the OTHER value 0032's CHECK admits rather than to a literal
    // of this test's choosing: `tier IN ('developed', 'ppp')` is enforced, so
    // an invented tier would fail the insert instead of the comparison.
    const flipped = await flipTier(liveRevision, lookupKey);
    await publish("test", BASELINE);
    await publish("live", liveRevision);

    const result = await readModeDivergence(SINGLE_SOURCE);

    if (result.outcome !== "diverged") throw new Error(`expected diverged, got ${result.outcome}`);
    expect(result.differences.every((row) => row.lookupKey === lookupKey)).toBe(true);
    expect(result.differences.find((row) => row.mode === "live")?.tier).toBe(flipped);
    expect(result.differences.find((row) => row.mode === "test")?.tier).not.toBe(flipped);
  });

  it("reports a row one mode serves and the other does not", async () => {
    const liveRevision = await cloneRevision(BASELINE, "live, one row dropped");
    const { lookupKey } = await someSeededAmount();
    await db.query("DELETE FROM plan_catalog_prices WHERE revision_id = $1 AND lookup_key = $2", [
      liveRevision,
      lookupKey,
    ]);
    await publish("test", BASELINE);
    await publish("live", liveRevision);

    const result = await readModeDivergence(SINGLE_SOURCE);

    if (result.outcome !== "diverged") throw new Error(`expected diverged, got ${result.outcome}`);
    expect(result.differences.every((row) => row.mode === "test")).toBe(true);
    expect(result.rows.live).toBeLessThan(result.rows.test);
  });

  it("compares only the named source", async () => {
    // The same discipline every other read in this module keeps: two products
    // sharing a lookup-key convention must not be diffed against each other.
    const liveRevision = await cloneRevision(BASELINE, "live, plus another source");
    await db.query(
      `INSERT INTO plan_catalog_prices (revision_id, source, lookup_key, plan, period, tier)
       VALUES ($1, 'acme', 'acme_only_v1', 'pro', 'monthly', 'developed')`,
      [liveRevision],
    );
    await publish("test", BASELINE);
    await publish("live", liveRevision);

    const result = await readModeDivergence(SINGLE_SOURCE);

    expect(result.outcome).toBe("identical");
  });
});
