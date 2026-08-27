import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for `0035_plan_catalog_revisions.sql`.
 *
 * Same shape as the 0034 suite — the migration run against a real (in-process)
 * Postgres via pglite, because what is being asserted is what the ENGINE will
 * and will not accept: constraints, not application code. Applies 0032, 0033,
 * 0034 in sequence and then 0035, which is the table prod actually holds.
 *
 * The `readCatalogAmounts` / `readLivePublication` suite below is the
 * exception: it exercises `plan-catalog-repo.ts` itself, not just the schema,
 * because the bug it guards against (a draft's rows leaking into a mode's
 * read once 0035 makes revisions coexist) is in the repository's SQL, not in
 * a CHECK constraint. Same `vi.mock("./tesserix", ...)` redirection as
 * `parity-window.integration.test.ts`, so the repo's own query runs against
 * this same pglite instance rather than a real `pg` pool.
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

const { readCatalogAmounts, readCatalogRows, readLivePublication } = await import(
  "./plan-catalog-repo"
);

const MIGRATIONS = [
  "0032_plan_catalog.sql",
  "0033_plan_catalog_parity_runs.sql",
  "0034_parity_runs_mode.sql",
  "0035_plan_catalog_revisions.sql",
].map((name) => path.resolve(__dirname, "../../../web/db/migrations", name));

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
  // Order matters under FKs: publications reference revisions, prices
  // reference revisions, amounts reference prices.
  await db.query("DELETE FROM plan_catalog_publications");
  await db.query(
    "DELETE FROM plan_catalog_prices WHERE lookup_key NOT LIKE 'mark8ly_%_v1'",
  );
  await db.query(
    "DELETE FROM plan_catalog_revisions WHERE id <> '00000000-0000-0000-0000-000000000001'",
  );
});

const insertRevision = async (note: string): Promise<string> => {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO plan_catalog_revisions (note, created_by) VALUES ($1, $2) RETURNING id",
    [note, "test"],
  );
  return rows[0].id;
};

const publish = async (mode: "test" | "live", revisionId: string): Promise<string> => {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO plan_catalog_publications (mode, revision_id, published_by) VALUES ($1, $2, $3) RETURNING id",
    [mode, revisionId, "test"],
  );
  return rows[0].id;
};

const insertPrice = async (
  revisionId: string,
  source: string,
  lookupKey: string,
): Promise<string> => {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO plan_catalog_prices (revision_id, source, lookup_key, plan, period, tier)
     VALUES ($1, $2, $3, 'pro', 'monthly', 'developed')
     RETURNING id`,
    [revisionId, source, lookupKey],
  );
  return rows[0].id;
};

/**
 * Like `insertPrice`, but with an explicit `period` and `tier` rather than
 * `insertPrice`'s hardcoded 'monthly'/'developed' — needed wherever a test's
 * assertion depends on `period` matching what the lookup key itself claims
 * (an `_annual_` key backed by a 'monthly' row is exactly the contradiction
 * a real bug in `createPrice`'s Stripe billing-interval derivation would
 * produce, and a fixture that quietly hardcodes 'monthly' cannot catch it).
 */
const insertPriceWithPeriod = async (
  revisionId: string,
  source: string,
  lookupKey: string,
  period: string,
  tier: string,
): Promise<string> => {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO plan_catalog_prices (revision_id, source, lookup_key, plan, period, tier)
     VALUES ($1, $2, $3, 'pro', $4, $5)
     RETURNING id`,
    [revisionId, source, lookupKey, period, tier],
  );
  return rows[0].id;
};

const insertPriceWithoutSource = (revisionId: string): Promise<unknown> =>
  db.query(
    `INSERT INTO plan_catalog_prices (revision_id, lookup_key, plan, period, tier)
     VALUES ($1, 'mark8ly_no_source_v1', 'pro', 'monthly', 'developed')`,
    [revisionId],
  );

const insertAmount = (
  priceId: string,
  currency: string,
  unitAmountMinor: number,
  taxBehavior: string,
) =>
  db.query(
    `INSERT INTO plan_catalog_amounts (price_id, currency, unit_amount_minor, tax_behavior)
     VALUES ($1, $2, $3, $4)`,
    [priceId, currency, unitAmountMinor, taxBehavior],
  );

const deleteRevision = (revisionId: string) =>
  db.query("DELETE FROM plan_catalog_revisions WHERE id = $1", [revisionId]);

const deletePricesFor = (revisionId: string) =>
  db.query("DELETE FROM plan_catalog_prices WHERE revision_id = $1", [revisionId]);

const countAmountsFor = async (priceId: string): Promise<number> => {
  const { rows } = await db.query<{ n: string | number }>(
    "SELECT count(*) AS n FROM plan_catalog_amounts WHERE price_id = $1",
    [priceId],
  );
  return Number(rows[0].n);
};

/** One price plus its one amount — the pair `readCatalogAmounts` reads back
 *  as a single {@link CatalogAmount}. `taxBehavior` defaults to
 *  `unspecified`, the state 0032's normalisation leaves everything but the
 *  6 AUD rows in. */
const insertPriceWithAmount = async (
  revisionId: string,
  lookupKey: string,
  currency: string,
  unitAmountMinor: number,
  taxBehavior = "unspecified",
): Promise<string> => {
  const priceId = await insertPrice(revisionId, "mark8ly", lookupKey);
  await insertAmount(priceId, currency, unitAmountMinor, taxBehavior);
  return priceId;
};

it("lets a draft and the published revision hold the same lookup key", async () => {
  // The whole point of the constraint swap. Under 0032's global UNIQUE this
  // INSERT fails, and draft creation would fail on its first row.
  const draft = await insertRevision("drafting a price change");
  await expect(
    insertPrice(draft, "mark8ly", "mark8ly_pro_annual_developed_v1"),
  ).resolves.toBeDefined();
});

it("refuses two live publications for one mode", async () => {
  const a = await insertRevision("a");
  const b = await insertRevision("b");
  await publish("test", a);
  await expect(publish("test", b)).rejects.toThrow(/one_live_per_mode/);
});

it("allows the same revision to be published to both modes", async () => {
  const r = await insertRevision("shared");
  await publish("test", r);
  await expect(publish("live", r)).resolves.toBeDefined();
});

it("refuses to delete a revision that has been published", async () => {
  const r = await insertRevision("published");
  await publish("test", r);
  // pglite phrases this "violates RESTRICT setting of foreign key
  // constraint", vs. real Postgres's "violates foreign key constraint" — the
  // substring below matches both engines' wording for the same rejection.
  await expect(deleteRevision(r)).rejects.toThrow(/foreign key/);
});

it("cascades amounts when a draft's prices are deleted", async () => {
  const draft = await insertRevision("throwaway");
  const price = await insertPrice(draft, "mark8ly", "mark8ly_x_v1");
  await insertAmount(price, "usd", 1000, "unspecified");
  await deletePricesFor(draft);
  expect(await countAmountsFor(price)).toBe(0);
});

it("requires a source, with no default to inherit", async () => {
  const draft = await insertRevision("no source");
  await expect(insertPriceWithoutSource(draft)).rejects.toThrow(/source/);
});

describe("readCatalogAmounts / readLivePublication", () => {
  it("reads only the revision published to the requested mode", async () => {
    // The bug this prevents: without the filter, a draft's rows join the
    // published ones, lookup keys duplicate, and the comparator's grouping
    // merges two catalogs into one — the same class of silent false positive
    // that 0032's tax_behavior normalisation was written to avoid.
    const published = await insertRevision("published");
    const draft = await insertRevision("draft");
    await insertPriceWithAmount(published, "mark8ly_a_v1", "usd", 1000);
    await insertPriceWithAmount(draft, "mark8ly_a_v1", "usd", 9999);
    await publish("test", published);

    const rows = await readCatalogAmounts("test");
    expect(rows).toHaveLength(1);
    expect(rows[0].unitAmountMinor).toBe(1000);
  });

  it("returns nothing for a mode with no publication", async () => {
    // This is what `not_bootstrapped` is derived from. An empty read here must
    // not throw — live has never been published and that is a normal state.
    await expect(readCatalogAmounts("live")).resolves.toEqual([]);
  });

  it("resolves the live publication's id and revision for a published mode", async () => {
    const revision = await insertRevision("published");
    const publicationId = await publish("test", revision);

    await expect(readLivePublication("test")).resolves.toEqual({
      id: publicationId,
      revisionId: revision,
    });
  });

  it("resolves null for a mode with no publication", async () => {
    await expect(readLivePublication("live")).resolves.toBeNull();
  });
});

describe("readCatalogRows", () => {
  it("projects plan, period, tier and source through the same publication filter", async () => {
    // The bug `readCatalogAmounts` was written to prevent applies here too —
    // it is the identical join with two more SELECT columns. If this ever
    // stopped sharing the `WHERE`, a draft's rows would leak into the
    // console's catalog table the same way they would have leaked into the
    // parity report.
    const published = await insertRevision("published");
    const draft = await insertRevision("draft");
    const priceId = await insertPriceWithPeriod(
      published,
      "mark8ly",
      "mark8ly_pro_annual_developed_v1",
      "annual",
      "developed",
    );
    await insertAmount(priceId, "usd", 118_800, "unspecified");
    const draftPriceId = await insertPriceWithPeriod(
      draft,
      "mark8ly",
      "mark8ly_pro_annual_developed_v1",
      "annual",
      "developed",
    );
    await insertAmount(draftPriceId, "usd", 999_999, "unspecified");
    await publish("live", published);

    const rows = await readCatalogRows("live");

    expect(rows).toEqual([
      {
        lookupKey: "mark8ly_pro_annual_developed_v1",
        plan: "pro",
        // `annual`, matching the lookup key's own `_annual_` segment — not
        // `insertPrice`'s hardcoded 'monthly' default, which would silently
        // pass this projection test through exactly the bug it exists to
        // catch (`period` is what `createPrice` derives the Stripe billing
        // interval from).
        period: "annual",
        tier: "developed",
        source: "mark8ly",
        currency: "usd",
        unitAmountMinor: 118_800,
        taxBehavior: "unspecified",
      },
    ]);
  });

  it("returns nothing for a mode with no publication, and never throws", async () => {
    await expect(readCatalogRows("test")).resolves.toEqual([]);
  });
});
