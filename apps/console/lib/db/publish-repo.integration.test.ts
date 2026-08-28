import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// The one source this catalog has today (see `source-policy.ts`), imported
// rather than writing `"mark8ly"` inline — #393 removed the last four such
// literals and this fixture must not add a fifth.
import { SINGLE_SOURCE } from "@/lib/billing/source-policy";

/**
 * Integration coverage for the draft lifecycle (`publish-repo.ts`) against a
 * real (in-process) Postgres via pglite — the same discipline
 * `crm-repo.write.integration.test.ts` and
 * `plan-catalog-revisions.integration.test.ts` use, and for the identical
 * reason: "one transaction" is a claim about what the ENGINE does with a
 * BEGIN/COMMIT/ROLLBACK sequence, and a mocked unit test cannot prove it —
 * only a real database, forced to fail mid-transaction, can.
 *
 * Migrations applied in sequence through 0037 — not just 0035 — because
 * 0036 and 0037 are already applied to production (see this task's brief)
 * and `createDraftFrom` runs against THAT schema, not against 0035 alone.
 * `plan_catalog_publications_one_live_per_mode` and the CHECK 0036 adds are
 * both live constraints this module's queries have to satisfy.
 */

const dbHolder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("./tesserix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tesserix")>();
  return {
    ...actual,
    tesserixQuery: async (sql: string, params: readonly unknown[] = []) => {
      const db = dbHolder.db as {
        query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
      };
      const result = await db.query(sql, params as unknown[]);
      return result.rows;
    },
    // pglite is a single embedded session with no pool to acquire a client
    // from, so it IS a client, structurally — `runTesserixTx` only ever
    // calls `.query(sql, params)` on whatever it's given. Delegating to the
    // REAL `runTesserixTx` (not a hand-rolled BEGIN/COMMIT/ROLLBACK) is what
    // makes the atomicity test below a test of the shared transaction core,
    // not of a reimplementation that could quietly diverge from it.
    tesserixTx: async (fn: Parameters<typeof actual.runTesserixTx>[1]) =>
      actual.runTesserixTx(dbHolder.db as Parameters<typeof actual.runTesserixTx>[0], fn),
    isDatabaseConfigured: () => true,
  };
});

const { createDraftFrom, discardDraft, currentDraft } = await import("./publish-repo");

const MIGRATIONS = [
  "0032_plan_catalog.sql",
  "0033_plan_catalog_parity_runs.sql",
  "0034_parity_runs_mode.sql",
  "0035_plan_catalog_revisions.sql",
  "0036_parity_runs_clean_names_publication.sql",
  "0037_publish_catalog_to_live.sql",
].map((name) => path.resolve(__dirname, "../../../web/db/migrations", name));

const BASELINE_REVISION_ID = "00000000-0000-0000-0000-000000000001";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;
  for (const file of MIGRATIONS) await db.exec(readFileSync(file, "utf-8"));

  // A failure-injection trigger, the same technique
  // `crm-repo.write.integration.test.ts` uses to prove atomicity: any INSERT
  // into `plan_catalog_prices` naming this one lookup key fails, deliberately,
  // so the "one transaction" test can force a failure AFTER the revision row
  // has already been inserted and prove it does not survive either.
  //
  // Created DISABLED: the fixture for that test has to insert the poison row
  // itself (to seed the revision `createDraftFrom` will copy FROM), and that
  // insert must not itself trip the trigger. The test enables it only after
  // that fixture row exists, immediately before calling `createDraftFrom`.
  await db.exec(`
    CREATE OR REPLACE FUNCTION publish_repo_test_inject_price_failure() RETURNS trigger AS $$
    BEGIN
      IF NEW.lookup_key = 'zzz_poison_v1' THEN
        RAISE EXCEPTION 'injected failure for draft atomicity test';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER publish_repo_test_inject_price_failure_trg
    BEFORE INSERT ON plan_catalog_prices
    FOR EACH ROW EXECUTE FUNCTION publish_repo_test_inject_price_failure();

    ALTER TABLE plan_catalog_prices DISABLE TRIGGER publish_repo_test_inject_price_failure_trg;
  `);
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  // Restore the canonical baseline state migrations 0035/0037 leave behind:
  // both modes published to the one seeded revision, nothing else. Order
  // matters under FKs — publications reference revisions, prices reference
  // revisions, amounts reference prices — and `lookup_key NOT LIKE
  // 'mark8ly_%_v1'` is what sweeps up the poison row a rolled-back
  // transaction never actually committed, plus anything a test inserted by
  // hand outside `createDraftFrom`'s own transaction.
  await db.query(
    `DELETE FROM plan_catalog_publications
      WHERE NOT (revision_id = $1 AND superseded_at IS NULL)`,
    [BASELINE_REVISION_ID],
  );
  await db.query("DELETE FROM plan_catalog_prices WHERE lookup_key NOT LIKE 'mark8ly_%_v1'");
  await db.query(`DELETE FROM plan_catalog_revisions WHERE id <> $1`, [BASELINE_REVISION_ID]);
  await db.query(
    `INSERT INTO plan_catalog_publications (mode, revision_id, published_by)
     SELECT m, $1, 'test-fixture'
       FROM unnest(ARRAY['test', 'live']) AS m
      WHERE NOT EXISTS (
        SELECT 1 FROM plan_catalog_publications WHERE mode = m AND superseded_at IS NULL
      )`,
    [BASELINE_REVISION_ID],
  );
});

const countRevisions = async (): Promise<number> => {
  const { rows } = await db.query<{ n: string | number }>(
    "SELECT count(*) AS n FROM plan_catalog_revisions",
  );
  return Number(rows[0].n);
};

const countPricesFor = async (revisionId: string): Promise<number> => {
  const { rows } = await db.query<{ n: string | number }>(
    "SELECT count(*) AS n FROM plan_catalog_prices WHERE revision_id = $1",
    [revisionId],
  );
  return Number(rows[0].n);
};

const countAmountsFor = async (revisionId: string): Promise<number> => {
  const { rows } = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n
       FROM plan_catalog_amounts a
       JOIN plan_catalog_prices p ON p.id = a.price_id
      WHERE p.revision_id = $1`,
    [revisionId],
  );
  return Number(rows[0].n);
};

/** Every amount left with no owning price row — what a partial delete of
 *  `plan_catalog_prices` would leave behind if 0032's `ON DELETE CASCADE`
 *  ever stopped covering `plan_catalog_amounts`. */
const countOrphanAmounts = async (): Promise<number> => {
  const { rows } = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n
       FROM plan_catalog_amounts a
       LEFT JOIN plan_catalog_prices p ON p.id = a.price_id
      WHERE p.id IS NULL`,
  );
  return Number(rows[0].n);
};

const publicationFor = async (
  mode: "test" | "live",
): Promise<{ id: string; revisionId: string }> => {
  const { rows } = await db.query<{ id: string; revision_id: string }>(
    "SELECT id, revision_id FROM plan_catalog_publications WHERE mode = $1 AND superseded_at IS NULL",
    [mode],
  );
  return { id: rows[0].id, revisionId: rows[0].revision_id };
};

describe("createDraftFrom", () => {
  it("copies the mode's published revision into a new draft, prices and amounts together", async () => {
    const draft = await createDraftFrom("test", "operator@tesserix");

    expect(await countPricesFor(draft)).toBe(42);
    expect(await countAmountsFor(draft)).toBe(78);
  });

  it("records what the draft was based on, so the plan can be three-way", async () => {
    const published = await publicationFor("test");

    const draft = await createDraftFrom("test", "operator@tesserix");

    await expect(currentDraft()).resolves.toEqual({ id: draft, basedOn: published.revisionId });
  });

  it("refuses to draft a mode that has never been published", async () => {
    // Bootstrapping a never-published mode is out of scope here — a silently
    // empty draft would diff as "archive everything" against a mode that may
    // already hold prices in Stripe.
    await db.query("UPDATE plan_catalog_publications SET superseded_at = now(), superseded_by = 'test' WHERE mode = 'live'");

    await expect(createDraftFrom("live", "operator@tesserix")).rejects.toThrow(/no published revision/);
  });

  it("creates the revision and its rows in ONE transaction", async () => {
    // Seed a second revision, carrying one row that the failure-injection
    // trigger rejects, and publish it in place of the baseline so
    // `createDraftFrom`'s copy has to touch it.
    const { rows: poisonRevisionRows } = await db.query<{ id: string }>(
      "INSERT INTO plan_catalog_revisions (created_by) VALUES ('test-fixture') RETURNING id",
    );
    const poisonRevisionId = poisonRevisionRows[0].id;
    const { rows: poisonPriceRows } = await db.query<{ id: string }>(
      `INSERT INTO plan_catalog_prices (revision_id, source, lookup_key, plan, period, tier)
       VALUES ($1, $2, 'zzz_poison_v1', 'pro', 'monthly', 'developed')
       RETURNING id`,
      [poisonRevisionId, SINGLE_SOURCE],
    );
    await db.query(
      `INSERT INTO plan_catalog_amounts (price_id, currency, unit_amount_minor, tax_behavior)
       VALUES ($1, 'usd', 1000, 'unspecified')`,
      [poisonPriceRows[0].id],
    );
    // Only now, with the poison row already seeded: arm the trigger so
    // `createDraftFrom`'s own copy is what trips it.
    await db.exec(
      "ALTER TABLE plan_catalog_prices ENABLE TRIGGER publish_repo_test_inject_price_failure_trg",
    );
    await db.query(
      "UPDATE plan_catalog_publications SET superseded_at = now(), superseded_by = 'test-fixture' WHERE mode = 'test' AND superseded_at IS NULL",
    );
    await db.query(
      "INSERT INTO plan_catalog_publications (mode, revision_id, published_by) VALUES ('test', $1, 'test-fixture')",
      [poisonRevisionId],
    );

    const before = await countRevisions();

    // A revision row with no prices would diff as "archive everything" —
    // this proves the failure rolls the revision insert back too, not just
    // the price copy that triggered it.
    await expect(createDraftFrom("test", "operator@tesserix")).rejects.toThrow(
      /injected failure/,
    );

    expect(await countRevisions()).toBe(before);
    await expect(currentDraft()).resolves.toBeNull();
  });

  it("refuses a second draft while one exists", async () => {
    await createDraftFrom("test", "operator@tesserix");

    await expect(createDraftFrom("live", "operator@tesserix")).rejects.toThrow(
      /draft already exists/,
    );
  });

  it("names the existing draft in the refusal", async () => {
    const first = await createDraftFrom("test", "operator@tesserix");

    await expect(createDraftFrom("live", "operator@tesserix")).rejects.toThrow(
      new RegExp(first),
    );
  });
});

describe("discardDraft", () => {
  it("discards a draft and its amounts together", async () => {
    const draft = await createDraftFrom("test", "op");

    await discardDraft(draft);

    expect(await countPricesFor(draft)).toBe(0);
    expect(await countOrphanAmounts()).toBe(0);
    await expect(currentDraft()).resolves.toBeNull();
  });

  it("refuses to discard a revision that has been published, with a clear message rather than a raw FK error", async () => {
    const published = await publicationFor("test");

    await expect(discardDraft(published.revisionId)).rejects.toThrow(/published/i);

    // Refused, not partially applied — the revision and its rows survive.
    expect(await countPricesFor(published.revisionId)).toBe(42);
  });
});

describe("currentDraft", () => {
  it("returns null when there is no draft", async () => {
    await expect(currentDraft()).resolves.toBeNull();
  });

  it("returns the draft once one exists", async () => {
    const draft = await createDraftFrom("live", "operator@tesserix");

    await expect(currentDraft()).resolves.toMatchObject({ id: draft });
  });
});
