import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Integration coverage for `0052_plan_catalog_entitlements.sql`, against real
 * (in-process) Postgres via pglite.
 *
 * What is asserted here is what the ENGINE will and will not accept, which is
 * the whole of what 0052 adds: there is no repository yet, and there is
 * deliberately none until the values are proven to agree with what mark8ly
 * enforces (tesserix-home#146, step 5 of the design's sequencing). So this file
 * is schema-only, unlike `promo-codes.integration.test.ts`, whose migration and
 * repo are asserted together because that feature's invariants reach a caller
 * through the repo.
 *
 * ══ EVERY NAMED CONSTRAINT IS VIOLATED HERE, BY NAME ══
 *
 * `plan-catalog.integration.test.ts` pins
 * `plan_catalog_amounts_currency_is_lowercase_iso_4217` by inserting `USD` and
 * asserting the constraint NAME appears in the rejection, and 0046's suite
 * copied that for all six of its own. The same pattern for 0052's four:
 * asserting the name rather than merely "it threw" is what stops a case passing
 * because some OTHER rule rejected the row first — which is a live hazard here,
 * since a single bad insert can violate the plan rule and the value rule at
 * once and Postgres reports whichever it reaches.
 *
 * 0032–0035 are loaded first, in order, because `plan_catalog_entitlements`
 * hangs off `plan_catalog_revisions` and 0035 is the file that creates it —
 * which in turn alters `plan_catalog_prices` (0032) and
 * `plan_catalog_parity_runs` (0033/0034). This is the same chain
 * `plan-catalog-revisions.integration.test.ts` loads, unchanged.
 */

const MIGRATIONS = [
  "0032_plan_catalog.sql",
  "0033_plan_catalog_parity_runs.sql",
  "0034_parity_runs_mode.sql",
  "0035_plan_catalog_revisions.sql",
  "0052_plan_catalog_entitlements.sql",
].map((name) => path.resolve(__dirname, "../../../web/db/migrations", name));

let db: PGlite;
let revisionId: string;

/** Positional query, so the cases below read as the SQL they are asserting. */
async function sql<T = Record<string, unknown>>(
  query: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(query, params as unknown[]);
  return result.rows;
}

beforeAll(async () => {
  db = new PGlite();
  for (const file of MIGRATIONS) await db.exec(readFileSync(file, "utf-8"));
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  // A fresh revision per case, rather than a shared one, so the cascade case
  // can delete its own revision without stranding the others. 0035 seeds a
  // baseline revision that everything else in this schema references; it is
  // left alone.
  await db.query("DELETE FROM plan_catalog_entitlements");
  await db.query(
    "DELETE FROM plan_catalog_revisions WHERE id <> '00000000-0000-0000-0000-000000000001'",
  );
  const rows = await sql<{ id: string }>(
    "INSERT INTO plan_catalog_revisions (note, created_by) VALUES ($1, $2) RETURNING id",
    ["entitlements test", "test"],
  );
  revisionId = rows[0].id;
});

describe("0052_plan_catalog_entitlements.sql", () => {
  it("stores an entitlement and reads it back", async () => {
    await sql(
      `INSERT INTO plan_catalog_entitlements
    (revision_id, source, plan, feature, value)
    VALUES ($1,'mark8ly','pro','stores',-1)`,
      [revisionId],
    );
    const rows = await sql<{ value: number }>(
      `SELECT value FROM plan_catalog_entitlements
    WHERE revision_id=$1 AND plan='pro' AND feature='stores'`,
      [revisionId],
    );
    expect(rows[0].value).toBe(-1);
  });

  it.each([
    ["unknown plan", `'mark8ly','enterprise','stores',1`, "plan_catalog_entitlements_plan_is_a_known_plan"],
    // `marketplace` is a real SubscriptionPlan constant, which is what makes it
    // the interesting refusal: it is absent from `featureMatrix`, so there is no
    // authored policy to mirror. Storing zeros for it would compare EQUAL
    // against a matrix that never described it.
    ["a plan absent from the matrix", `'mark8ly','marketplace','stores',0`, "plan_catalog_entitlements_plan_is_a_known_plan"],
    ["unknown feature", `'mark8ly','pro','teleport',1`, "plan_catalog_entitlements_feature_is_a_known_feature"],
    ["unknown source", `'kora','pro','stores',1`, "plan_catalog_entitlements_source_is_a_known_source"],
    ["a fourth sentinel", `'mark8ly','pro','stores',-3`, "plan_catalog_entitlements_value_is_a_known_sentinel_or_cap"],
  ])("refuses %s by name", async (_label, values, constraint) => {
    await expect(
      sql(
        `INSERT INTO plan_catalog_entitlements
      (revision_id, source, plan, feature, value) VALUES ($1,${values})`,
        [revisionId],
      ),
    ).rejects.toThrow(constraint);
  });

  it("accepts trial, which plangate gates but nothing prices", async () => {
    await sql(
      `INSERT INTO plan_catalog_entitlements (revision_id, source, plan, feature, value)
       VALUES ($1,'mark8ly','trial','stores',1)`,
      [revisionId],
    );
    const rows = await sql(
      `SELECT value FROM plan_catalog_entitlements WHERE revision_id=$1 AND plan='trial'`,
      [revisionId],
    );
    expect(rows[0].value).toBe(1);
  });

  it("refuses a duplicate (revision, source, plan, feature)", async () => {
    const ins = `INSERT INTO plan_catalog_entitlements
    (revision_id, source, plan, feature, value) VALUES ($1,'mark8ly','pro','stores',1)`;
    await sql(ins, [revisionId]);
    await expect(sql(ins, [revisionId])).rejects.toThrow(
      /duplicate key|plan_catalog_entitlements_pkey/,
    );
  });

  it("cascades when its revision is deleted", async () => {
    await sql(
      `INSERT INTO plan_catalog_entitlements
    (revision_id, source, plan, feature, value) VALUES ($1,'mark8ly','pro','stores',1)`,
      [revisionId],
    );
    await sql(`DELETE FROM plan_catalog_revisions WHERE id=$1`, [revisionId]);
    const rows = await sql(
      `SELECT 1 FROM plan_catalog_entitlements WHERE revision_id=$1`,
      [revisionId],
    );
    expect(rows).toHaveLength(0);
  });
});
