import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for `0052_plan_catalog_entitlements.sql` AND the
 * entitlement half of `plan-catalog-repo.ts`, against real (in-process)
 * Postgres via pglite.
 *
 * ══ THE REPO CASES WERE ADDED LATER, AND THE HEADER THEY REPLACE WAS WRONG ══
 *
 * This file began schema-only, and said so: "there is no repository yet, and
 * there is deliberately none until the values are proven to agree with what
 * mark8ly enforces". The sequencing that sentence cites (the design's step 5,
 * authoring) is about EDITING entitlements, not about seeding them — step 2 is
 * the seed, and it needs a writer. So the repo arrived here, and its cases
 * live in this file rather than a mocked one for the reason
 * `promo-codes.integration.test.ts` gives at length: every invariant this
 * feature has lives in the DATABASE, and a repo asserted against a mock is a
 * repo whose only real job — being thin enough that a CHECK reaches its
 * caller intact — is the one thing nobody tested.
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

/**
 * `tesserixQuery` routed into THIS file's own pglite, per
 * `promo-codes.integration.test.ts` — a mock in one test file cannot be shared
 * with another, so the holder is hoisted and filled in `beforeAll` once the
 * instance exists.
 */
const dbHolder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("./tesserix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tesserix")>();
  return {
    ...actual,
    tesserixQuery: async (query: string, params: readonly unknown[] = []) => {
      const db = dbHolder.db as {
        query: (query: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
      };
      const result = await db.query(query, params as unknown[]);
      return result.rows;
    },
    isDatabaseConfigured: () => true,
  };
});

const { readEntitlements, writeEntitlements } = await import("./plan-catalog-repo");

type CatalogSource = import("@/lib/billing/source-policy").CatalogSource;

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
  dbHolder.db = db;
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

describe("plan-catalog-repo entitlements", () => {
  it("writes a full matrix and reads it back", async () => {
    await writeEntitlements(revisionId, "mark8ly", [
      { plan: "pro", feature: "stores", value: -1 },
      { plan: "starter", feature: "sso", value: 0 },
    ]);
    const rows = await readEntitlements(revisionId, "mark8ly");
    expect(rows).toEqual(
      expect.arrayContaining([
        { plan: "pro", feature: "stores", value: -1 },
        { plan: "starter", feature: "sso", value: 0 },
      ]),
    );
  });

  it("refuses a value below the sentinel floor rather than repairing it", async () => {
    await expect(
      writeEntitlements(revisionId, "mark8ly", [
        { plan: "pro", feature: "stores", value: -3 },
      ]),
    ).rejects.toThrow(/value_is_a_known_sentinel_or_cap/);
  });

  // The whole batch, or none of it. `writeEntitlements` sends ONE statement,
  // so a row the engine refuses takes the rows beside it down with it — which
  // is the behaviour a seed needs and the reason the function does not loop.
  // A per-row loop would leave the accepted prefix behind, and a half-seeded
  // revision compares as agreement on the rows that exist and says nothing
  // about the rows that do not.
  it("writes nothing at all when one row of the batch is refused", async () => {
    await expect(
      writeEntitlements(revisionId, "mark8ly", [
        { plan: "pro", feature: "stores", value: -1 },
        { plan: "pro", feature: "teleport", value: 1 },
      ]),
    ).rejects.toThrow(/feature_is_a_known_feature/);
    expect(await readEntitlements(revisionId, "mark8ly")).toEqual([]);
  });

  // Reading is scoped by BOTH keys, not just the revision. 0052's primary key
  // is `(revision_id, source, plan, feature)`, so a second source's rows can
  // sit on the same revision under the same (plan, feature) pair; a read that
  // filtered on the revision alone would hand a comparator two products' rows
  // as if they were one product's, which is the merge `EntitlementPage`
  // refuses to do on the federation side.
  //
  // It is asserted from the READ side only, and the cast says why: 0052's
  // source CHECK admits exactly `mark8ly` today, so a rival source's rows
  // cannot be written for this test to filter out. Asking for a source that
  // has none still distinguishes a filtered read from an unfiltered one, which
  // is the whole of what this function controls — and when the CHECK widens,
  // the case above it starts carrying the other half.
  it("reads only the named source's rows", async () => {
    await writeEntitlements(revisionId, "mark8ly", [
      { plan: "pro", feature: "stores", value: -1 },
    ]);
    expect(await readEntitlements(revisionId, "mark8ly")).toEqual([
      { plan: "pro", feature: "stores", value: -1 },
    ]);
    expect(
      await readEntitlements(revisionId, "kora" as CatalogSource),
    ).toEqual([]);
  });

  // No `ON CONFLICT`, deliberately: a second seed onto a revision that already
  // has rows is not an idempotent re-run, it is a caller who does not know
  // what is already there. The primary key says so and the repo lets it.
  it("refuses a second write over the same rows", async () => {
    const rows = [{ plan: "pro", feature: "stores", value: -1 }];
    await writeEntitlements(revisionId, "mark8ly", rows);
    await expect(writeEntitlements(revisionId, "mark8ly", rows)).rejects.toThrow(
      /duplicate key|plan_catalog_entitlements_pkey/,
    );
  });

  it("reads back nothing for a revision that was never seeded", async () => {
    expect(await readEntitlements(revisionId, "mark8ly")).toEqual([]);
  });
});
