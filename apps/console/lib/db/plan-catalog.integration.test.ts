import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

/**
 * Integration coverage for `0032_plan_catalog.sql` — the table AND its seed.
 *
 * There is no repository module under test here, so no `vi.mock("./tesserix")`
 * like the CRM suites: what is being asserted is the migration itself, run
 * against a real (in-process) Postgres via pglite. Two things that only a real
 * engine can prove:
 *
 *   - The seed actually loads. A `VALUES` list of 78 amounts joined back to 42
 *     prices by `lookup_key` is exactly the kind of statement that silently
 *     inserts 0 rows if a key is misspelled — an inner join drops the row
 *     rather than erroring.
 *   - The CHECK constraints reject. A constraint nobody tries to violate is a
 *     comment with SQL syntax.
 *
 * The expected side is `db/seeds/pricing-v1.csv`, read from disk rather than
 * transcribed. Transcribing it here would make this file a THIRD copy of the
 * catalog (after mark8ly's `catalog.go` and the migration's seed), and the
 * duplication is the whole reason #326 exists.
 *
 * It lives beside the migrations rather than in `.planning/` because it is a
 * build input, not a planning artifact: this suite reads it on every run, and
 * planning directories in this repo get relocated when their work resolves
 * (`.planning/debug/` -> `.planning/debug/resolved/`). A test whose fixture
 * moves when someone tidies up is a test that fails for a reason unrelated to
 * the catalog.
 *
 * Regenerate with, from the mark8ly checkout:
 *
 *\tcd services/marketplace-api && go run ./cmd/pricing-dump
 */

const CSV_PATH = path.resolve(__dirname, "../../../web/db/seeds/pricing-v1.csv");

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../web/db/migrations/0032_plan_catalog.sql",
);

type CatalogRow = {
  plan: string;
  period: string;
  tier: string;
  currency: string;
  unitAmountMinor: string;
  taxBehavior: string;
  lookupKey: string;
};

/**
 * The CSV has no quoted fields and no embedded commas — a real CSV parser
 * would be a dependency bought for nothing. If that ever stops being true the
 * header assertion below is what catches it first.
 */
function parseCatalogCsv(text: string): CatalogRow[] {
  const lines = text.trim().split("\n");
  const header = lines[0];
  expect(header).toBe("plan,period,tier,currency,unit_amount_minor,tax_behavior,lookup_key");

  return lines.slice(1).map((line) => {
    const [plan, period, tier, currency, unitAmountMinor, taxBehavior, lookupKey] =
      line.split(",");
    return { plan, period, tier, currency, unitAmountMinor, taxBehavior, lookupKey };
  });
}

/**
 * `""` in the catalog and `unspecified` in Stripe are the same state: Stripe
 * stores `unspecified` for a Price created without `tax_behavior`, and that is
 * what the API returns. The migration normalises on the way in; this mirrors
 * the normalisation on the expected side so the comparison is like-for-like.
 */
const normalizeTaxBehavior = (raw: string): string => (raw === "" ? "unspecified" : raw);

const tupleKey = (r: {
  plan: string;
  period: string;
  tier: string;
  currency: string;
  unit_amount_minor: string;
  tax_behavior: string;
  lookup_key: string;
}) =>
  [
    r.plan,
    r.period,
    r.tier,
    r.currency,
    r.unit_amount_minor,
    r.tax_behavior,
    r.lookup_key,
  ].join("|");

let db: PGlite;
let csvRows: CatalogRow[];

beforeAll(async () => {
  csvRows = parseCatalogCsv(readFileSync(CSV_PATH, "utf-8"));

  db = new PGlite();
  // The migration is loaded on its own: `plan_catalog_prices` and
  // `plan_catalog_amounts` reference nothing outside themselves, which is
  // itself worth knowing — the catalog is a standalone read model, not
  // something wired into the CRM graph.
  await db.exec(readFileSync(MIGRATION_PATH, "utf-8"));
});

afterAll(async () => {
  await db?.close();
});

/** Every seeded amount, joined back to its descriptor. */
async function seededRows() {
  const result = await db.query<{
    plan: string;
    period: string;
    tier: string;
    currency: string;
    unit_amount_minor: string | number | bigint;
    tax_behavior: string;
    lookup_key: string;
  }>(
    `SELECT p.plan, p.period, p.tier, p.lookup_key,
            a.currency, a.unit_amount_minor, a.tax_behavior
       FROM plan_catalog_amounts a
       JOIN plan_catalog_prices p ON p.id = a.price_id`,
  );
  return result.rows.map((r) => ({ ...r, unit_amount_minor: String(r.unit_amount_minor) }));
}

describe("plan catalog seed", () => {
  it("holds one row per descriptor — 42 prices, all lookup keys distinct", async () => {
    const { rows } = await db.query<{ total: string | number; distinct_keys: string | number }>(
      `SELECT count(*) AS total, count(DISTINCT lookup_key) AS distinct_keys
         FROM plan_catalog_prices`,
    );
    expect(Number(rows[0].total)).toBe(42);
    expect(Number(rows[0].distinct_keys)).toBe(42);
  });

  it("holds one row per (descriptor x currency) — 78 amounts", async () => {
    const { rows } = await db.query<{ total: string | number }>(
      "SELECT count(*) AS total FROM plan_catalog_amounts",
    );
    expect(Number(rows[0].total)).toBe(78);
  });

  it("matches pricing-v1.csv exactly, tuple for tuple", async () => {
    // Set comparison in both directions at once: a missing row and an extra
    // row are both a diff, and the sorted arrays make the failure readable
    // rather than "expected Set(78) to equal Set(78)".
    const expected = csvRows
      .map((r) =>
        tupleKey({
          plan: r.plan,
          period: r.period,
          tier: r.tier,
          currency: r.currency,
          unit_amount_minor: r.unitAmountMinor,
          tax_behavior: normalizeTaxBehavior(r.taxBehavior),
          lookup_key: r.lookupKey,
        }),
      )
      .sort();

    const actual = (await seededRows()).map(tupleKey).sort();

    expect(actual).toEqual(expected);
    expect(expected).toHaveLength(78);
  });

  it("keeps the developed/ppp shape: 6 descriptors with 7 currencies, 36 with 1", async () => {
    // This is the fact a flat 78-row table would lose. A developed descriptor
    // is ONE Stripe Price carrying six further currencies in
    // `currency_options`; a comparator that cannot see the 7-to-1 fan-out
    // tries to match 78 catalog rows against 42 Stripe Prices.
    const { rows } = await db.query<{ tier: string; amounts: string | number; prices: string | number }>(
      `SELECT tier, amounts, count(*) AS prices FROM (
         SELECT p.tier, count(a.id) AS amounts
           FROM plan_catalog_prices p
           JOIN plan_catalog_amounts a ON a.price_id = p.id
          GROUP BY p.id, p.tier
       ) per_price
       GROUP BY tier, amounts
       ORDER BY tier, amounts`,
    );

    expect(
      rows.map((r) => ({
        tier: r.tier,
        amounts: Number(r.amounts),
        prices: Number(r.prices),
      })),
    ).toEqual([
      { tier: "developed", amounts: 7, prices: 6 },
      { tier: "ppp", amounts: 1, prices: 36 },
    ]);
  });
});

describe("tax_behavior normalisation", () => {
  it("marks the 6 AUD rows exclusive and the other 72 unspecified", async () => {
    const { rows } = await db.query<{ tax_behavior: string; total: string | number }>(
      `SELECT tax_behavior, count(*) AS total
         FROM plan_catalog_amounts
        GROUP BY tax_behavior
        ORDER BY tax_behavior`,
    );
    expect(rows.map((r) => ({ tax_behavior: r.tax_behavior, total: Number(r.total) }))).toEqual([
      { tax_behavior: "exclusive", total: 6 },
      { tax_behavior: "unspecified", total: 72 },
    ]);
  });

  it("puts exclusive on AUD and nothing else", async () => {
    const { rows } = await db.query<{ currency: string }>(
      `SELECT DISTINCT currency FROM plan_catalog_amounts WHERE tax_behavior = 'exclusive'`,
    );
    expect(rows.map((r) => r.currency)).toEqual(["aud"]);
  });

  it("stores neither '' nor NULL — the two states part 2 would report as drift", async () => {
    // 72 of 78 rows would be a false positive on the comparator's first run if
    // the seed had kept the catalog's empty string. A check that opens with 72
    // false positives is ignored by day two.
    const { rows } = await db.query<{ total: string | number }>(
      `SELECT count(*) AS total FROM plan_catalog_amounts
        WHERE tax_behavior IS NULL OR tax_behavior = ''`,
    );
    expect(Number(rows[0].total)).toBe(0);
  });
});

describe("constraints", () => {
  const anyPriceId = async () => {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM plan_catalog_prices LIMIT 1",
    );
    return rows[0].id;
  };

  const insertAmount = async (
    currency: string,
    amount: string,
    taxBehavior: string,
  ) => {
    const priceId = await anyPriceId();
    // Wrapped in a savepoint-free standalone statement: pglite autocommits, so
    // a rejected INSERT leaves the seeded rows untouched for the next case.
    await db.query(
      `INSERT INTO plan_catalog_amounts (price_id, currency, unit_amount_minor, tax_behavior)
       VALUES ($1, $2, $3, $4)`,
      [priceId, currency, amount, taxBehavior],
    );
  };

  it("rejects an uppercase currency", async () => {
    // Stripe's currencies are lowercase. A `USD` row and a `usd` row coexisting
    // is a silent double-count in every aggregate the comparator computes.
    await expect(insertAmount("USD", "1900", "unspecified")).rejects.toThrow(
      /plan_catalog_amounts_currency_is_lowercase_iso_4217/,
    );
  });

  it("rejects a zero amount", async () => {
    // There is no free plan in this catalog, so 0 can only mean "not set" —
    // and "not set" read as "free" is the expensive direction of that mistake.
    await expect(insertAmount("chf", "0", "unspecified")).rejects.toThrow(
      /plan_catalog_amounts_unit_amount_is_positive/,
    );
  });

  it("rejects an empty-string tax_behavior", async () => {
    await expect(insertAmount("chf", "1900", "")).rejects.toThrow(
      /plan_catalog_amounts_tax_behavior_is_a_stripe_value/,
    );
  });

  it("rejects a second amount in the same currency for one price", async () => {
    const priceId = await anyPriceId();
    const { rows } = await db.query<{ currency: string }>(
      "SELECT currency FROM plan_catalog_amounts WHERE price_id = $1 LIMIT 1",
      [priceId],
    );
    await expect(
      insertAmount(rows[0].currency, "1900", "unspecified"),
    ).rejects.toThrow(/plan_catalog_amounts_price_id_currency_key/);
  });

  it("rejects an unknown period and an unknown tier", async () => {
    await expect(
      db.query(
        `INSERT INTO plan_catalog_prices (lookup_key, plan, period, tier)
         VALUES ('x_v1', 'pro', 'weekly', 'developed')`,
      ),
    ).rejects.toThrow(/plan_catalog_prices_period_is_a_billing_period/);

    await expect(
      db.query(
        `INSERT INTO plan_catalog_prices (lookup_key, plan, period, tier)
         VALUES ('y_v1', 'pro', 'monthly', 'emerging')`,
      ),
    ).rejects.toThrow(/plan_catalog_prices_tier_is_a_pricing_tier/);
  });
});

describe("re-runnability", () => {
  it("is idempotent — applying it twice changes no counts", async () => {
    // The estate applies migrations by hand before merge (`db:migrate`), and a
    // retried run must not double the seed. 0031's `IF NOT EXISTS` +
    // `ON CONFLICT DO NOTHING` style is what this inherits.
    await db.exec(readFileSync(MIGRATION_PATH, "utf-8"));

    const { rows } = await db.query<{ prices: string | number; amounts: string | number }>(
      `SELECT (SELECT count(*) FROM plan_catalog_prices)  AS prices,
              (SELECT count(*) FROM plan_catalog_amounts) AS amounts`,
    );
    expect(Number(rows[0].prices)).toBe(42);
    expect(Number(rows[0].amounts)).toBe(78);
  });
});
