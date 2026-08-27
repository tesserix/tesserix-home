import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Integration coverage for `0035_plan_catalog_revisions.sql`.
 *
 * Same shape as the 0034 suite — the migration run against a real (in-process)
 * Postgres via pglite, because what is being asserted is what the ENGINE will
 * and will not accept: constraints, not application code. Applies 0032, 0033,
 * 0034 in sequence and then 0035, which is the table prod actually holds.
 */

const MIGRATIONS = [
  "0032_plan_catalog.sql",
  "0033_plan_catalog_parity_runs.sql",
  "0034_parity_runs_mode.sql",
  "0035_plan_catalog_revisions.sql",
].map((name) => path.resolve(__dirname, "../../../web/db/migrations", name));

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
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
