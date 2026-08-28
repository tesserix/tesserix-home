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

const { createDraftFrom, discardDraft, currentDraft, promotePublication, setDraftAmount } = await import("./publish-repo");
// `readLivePublication` lives in `plan-catalog-repo.ts`, not this module —
// but it imports the SAME "./tesserix", which this file's `vi.mock` above
// intercepts by resolved path, not by importer. Importing it here proves
// `promotePublication`'s write is visible through the read path the rest of
// the app actually uses, not just through this file's own raw `db.query`
// assertions.
const { readLivePublication } = await import("./plan-catalog-repo");

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

  // A second failure-injection trigger, same technique, for
  // `promotePublication`'s OWN atomicity: it does a retire-then-insert pair
  // (see its doc comment in `publish-repo.ts`), and asserting only the
  // post-state (as the test above this comment did before review) cannot
  // distinguish "one transaction" from "two independent statements that
  // happen to both succeed" — only forcing the SECOND statement to fail and
  // checking the FIRST one didn't survive can. Fires on a specific
  // `published_by` marker, never a real operator's identity, so — unlike the
  // price trigger above — nothing else in this suite needs it disabled by
  // default: no other test promotes with this marker.
  await db.exec(`
    CREATE OR REPLACE FUNCTION publish_repo_test_inject_promotion_failure() RETURNS trigger AS $$
    BEGIN
      IF NEW.published_by = 'zzz_poison_promotion' THEN
        RAISE EXCEPTION 'injected failure for promotion atomicity test';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER publish_repo_test_inject_promotion_failure_trg
    BEFORE INSERT ON plan_catalog_publications
    FOR EACH ROW EXECUTE FUNCTION publish_repo_test_inject_promotion_failure();
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

// Same four columns `readLivePublication` (`plan-catalog-repo.ts`) reads,
// widened by task 2R — kept in lockstep here so `before`/`liveBefore`
// snapshots below can be compared against that function's own return value
// with a plain `toEqual`, publishedBy/publishedAt included, rather than only
// the two columns this fixture used to check.
const publicationFor = async (
  mode: "test" | "live",
): Promise<{ id: string; revisionId: string; publishedBy: string; publishedAt: string }> => {
  const { rows } = await db.query<{
    id: string;
    revision_id: string;
    published_by: string;
    published_at: string | Date;
  }>(
    "SELECT id, revision_id, published_by, published_at FROM plan_catalog_publications WHERE mode = $1 AND superseded_at IS NULL",
    [mode],
  );
  return {
    id: rows[0].id,
    revisionId: rows[0].revision_id,
    publishedBy: rows[0].published_by,
    publishedAt: new Date(rows[0].published_at).toISOString(),
  };
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

describe("setDraftAmount", () => {
  it("updates an existing cell's amount, leaving its tax_behavior untouched", async () => {
    const draft = await createDraftFrom("test", "operator@tesserix");

    await setDraftAmount({
      revisionId: draft,
      source: SINGLE_SOURCE,
      lookupKey: "mark8ly_pro_monthly_developed_v1",
      currency: "usd",
      unitAmountMinor: 12_345,
    });

    const { rows } = await db.query<{ unit_amount_minor: string | number; tax_behavior: string }>(
      `SELECT a.unit_amount_minor, a.tax_behavior
         FROM plan_catalog_amounts a
         JOIN plan_catalog_prices p ON p.id = a.price_id
        WHERE p.revision_id = $1 AND p.lookup_key = 'mark8ly_pro_monthly_developed_v1' AND a.currency = 'usd'`,
      [draft],
    );
    expect(Number(rows[0].unit_amount_minor)).toBe(12_345);
    // Untouched: 0032's seed sets this row's tax_behavior to 'unspecified'
    // already, so this only proves the UPDATE branch didn't overwrite it
    // with something else — a currency whose seed value differs would be a
    // stronger assertion, but every developed row's usd cell is
    // 'unspecified' per 0032's seed.
    expect(rows[0].tax_behavior).toBe("unspecified");
  });

  it("inserts a new currency cell when the draft's row does not carry it yet — the add_currency_option case", async () => {
    const draft = await createDraftFrom("test", "operator@tesserix");
    // A `ppp` row is single-currency by the catalog's own convention (0032's
    // seed) — `idr` is the only currency `mark8ly_pro_monthly_ppp_idr_v1`
    // carries, so adding `usd` here is a genuinely new cell, not an edit.
    const lookupKey = "mark8ly_pro_monthly_ppp_idr_v1";

    await setDraftAmount({
      revisionId: draft,
      source: SINGLE_SOURCE,
      lookupKey,
      currency: "usd",
      unitAmountMinor: 999,
    });

    const { rows } = await db.query<{ unit_amount_minor: string | number; tax_behavior: string }>(
      `SELECT a.unit_amount_minor, a.tax_behavior
         FROM plan_catalog_amounts a
         JOIN plan_catalog_prices p ON p.id = a.price_id
        WHERE p.revision_id = $1 AND p.lookup_key = $2 AND a.currency = 'usd'`,
      [draft, lookupKey],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].unit_amount_minor)).toBe(999);
    // 78 seeded amounts (0032) plus this one new cell — proves the INSERT
    // added a row rather than replacing the `idr` cell this lookup key
    // already had (an UPSERT keyed on the wrong column would still pass the
    // single-row assertion above, but would leave the total at 78, not 79).
    expect(await countAmountsFor(draft)).toBe(79);
  });

  it("refuses a lookup_key that is not a price in this revision, before writing anything", async () => {
    const draft = await createDraftFrom("test", "operator@tesserix");

    await expect(
      setDraftAmount({
        revisionId: draft,
        source: SINGLE_SOURCE,
        lookupKey: "not_a_real_lookup_key",
        currency: "usd",
        unitAmountMinor: 100,
      }),
    ).rejects.toThrow(/not a price in revision/);

    // Refused, not partially applied.
    expect(await countAmountsFor(draft)).toBe(78);
  });

  // CRITICAL, review 2026-08-28: `revisionId` reaches `setAmountAction`
  // straight off a client prop with no ownership check of its own — this is
  // the ONE guard standing between that and silently rewriting the amounts
  // of the revision the parity comparator and every future plan diff read as
  // the ANCESTOR. Same hazard `discardDraft`'s "refuses to discard a
  // revision that has been published" test above proves; this is its
  // `setDraftAmount` twin.
  it("refuses to edit a revision that is currently published, naming which mode", async () => {
    // A revision promoted to ONLY `test` — not the shared baseline, which
    // `beforeEach` publishes to BOTH modes at once and so cannot prove which
    // mode's name landed in the message (`plan_catalog_publications` has no
    // defined row order across two rows naming the same revision_id).
    const testOnlyDraft = await createDraftFrom("test", "operator@tesserix");
    await promotePublication("test", testOnlyDraft, "operator@tesserix");

    await expect(
      setDraftAmount({
        revisionId: testOnlyDraft,
        source: SINGLE_SOURCE,
        lookupKey: "mark8ly_pro_monthly_developed_v1",
        currency: "usd",
        unitAmountMinor: 1,
      }),
    ).rejects.toThrow(/published to test/);

    // Refused, not partially applied — the live catalog's own amount survives.
    const { rows } = await db.query<{ unit_amount_minor: string | number }>(
      `SELECT a.unit_amount_minor
         FROM plan_catalog_amounts a
         JOIN plan_catalog_prices p ON p.id = a.price_id
        WHERE p.revision_id = $1 AND p.lookup_key = 'mark8ly_pro_monthly_developed_v1' AND a.currency = 'usd'`,
      [testOnlyDraft],
    );
    expect(Number(rows[0].unit_amount_minor)).toBe(11_900);
  });

  it("refuses to edit a revision published to the OTHER mode too — the guard is not test-only", async () => {
    const liveDraft = await createDraftFrom("live", "operator@tesserix");
    // Promote it so it's a genuinely published (non-draft, non-superseded)
    // revision for `live`, distinct from `test`'s.
    await promotePublication("live", liveDraft, "operator@tesserix");

    await expect(
      setDraftAmount({
        revisionId: liveDraft,
        source: SINGLE_SOURCE,
        lookupKey: "mark8ly_pro_monthly_developed_v1",
        currency: "usd",
        unitAmountMinor: 1,
      }),
    ).rejects.toThrow(/published to live/);
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

describe("promotePublication", () => {
  it("retires the previous publication and promotes the new one atomically", async () => {
    const before = await publicationFor("test");
    // A real second revision, not a bare INSERT — `createDraftFrom` is the
    // one path this schema expects an unpublished revision to arrive by,
    // and it is exactly what a finished publish attempt promotes in
    // production (see `publish-executor.ts`'s header on why THIS function
    // must be the one to close that gap).
    const draft = await createDraftFrom("test", "operator@tesserix");

    const newPublicationId = await promotePublication("test", draft, "operator@tesserix");

    const after = await publicationFor("test");
    expect(after.id).toBe(newPublicationId);
    expect(after.id).not.toBe(before.id);
    expect(after.revisionId).toBe(draft);

    // `readLivePublication` is what `readCatalogAmounts` and the parity
    // check actually read through — proving the write is visible there,
    // not just in this file's own `db.query`, is the whole point of #327.
    const afterPublication = await readLivePublication("test");
    expect(afterPublication).toMatchObject({
      id: newPublicationId,
      revisionId: draft,
      // `promotePublication`'s own `by` argument, above.
      publishedBy: "operator@tesserix",
    });
    // `published_at` defaults to `now()` at INSERT time, so it is asserted as
    // a well-formed ISO 8601 UTC string rather than a fixed value.
    expect(afterPublication?.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const { rows: retiredRows } = await db.query<{
      superseded_at: string | null;
      superseded_by: string | null;
    }>(`SELECT superseded_at, superseded_by FROM plan_catalog_publications WHERE id = $1`, [
      before.id,
    ]);
    expect(retiredRows[0].superseded_at).not.toBeNull();
    expect(retiredRows[0].superseded_by).toBe("operator@tesserix");
  });

  it("rolls back the retire together with the promote — a failed INSERT leaves the previous publication un-retired", async () => {
    // The test above only asserts POST-state, which a pair of independent
    // statements (UPDATE that commits, then a separately-failing INSERT)
    // would also satisfy in its failure case — it cannot tell "one
    // transaction" from "two statements that happen to both run". This
    // test can: the failure-injection trigger on `plan_catalog_publications`
    // (see `beforeAll`) fires only on the SECOND statement `promotePublication`
    // issues (the INSERT), forcing a failure strictly after the first
    // statement (the UPDATE that retires `before`) has already run on this
    // connection — the same "force a failure after the earlier write, prove
    // it didn't survive either" shape `createDraftFrom`'s own atomicity test
    // uses above with `zzz_poison_v1`.
    const before = await publicationFor("test");
    const draft = await createDraftFrom("test", "operator@tesserix");

    await expect(
      promotePublication("test", draft, "zzz_poison_promotion"),
    ).rejects.toThrow(/injected failure for promotion atomicity test/);

    // Not retired: if the UPDATE had committed on its own (no shared
    // transaction with the INSERT that failed), this would read back
    // `superseded_at` set and the mode would be left with ZERO live
    // publications — a worse bug than the one promotion exists to prevent.
    const { rows: stillLiveRows } = await db.query<{
      superseded_at: string | null;
      superseded_by: string | null;
    }>(`SELECT superseded_at, superseded_by FROM plan_catalog_publications WHERE id = $1`, [
      before.id,
    ]);
    expect(stillLiveRows[0].superseded_at).toBeNull();
    expect(stillLiveRows[0].superseded_by).toBeNull();

    // `before` now carries `publishedBy`/`publishedAt` too (see
    // `publicationFor`'s own comment), so this still proves the un-retired
    // row is EXACTLY the one that was live before the failed promotion, not
    // merely one with a matching id and revision.
    await expect(readLivePublication("test")).resolves.toEqual(before);
  });

  it("leaves the OTHER mode's live publication untouched", async () => {
    const liveBefore = await publicationFor("live");
    const draft = await createDraftFrom("test", "operator@tesserix");

    await promotePublication("test", draft, "operator@tesserix");

    await expect(readLivePublication("live")).resolves.toEqual(liveBefore);
  });

  // RULING (task-7 brief, overridden by the task's own dispatch instructions):
  // the brief's second Step-1 test asks for two concurrent `promotePublication`
  // calls to the same mode to "serialise". That is NOT provable here. pglite
  // is a single embedded session — there is no second connection for a second
  // transaction to contend with, so two sequential `await`s prove nothing
  // about serialisation and a test that asserted it anyway would be
  // asserting the absence of a race it structurally cannot create.
  //
  // What IS provable, and what this test asserts instead:
  //   1. the advisory lock is genuinely issued INSIDE the promotion
  //      transaction (a spy on the queries the transaction runs — the same
  //      "does the SQL text say what the doc comment claims" technique this
  //      file already relies on for the failure-injection trigger above);
  //   2. the observable invariant promotion exists to guarantee — exactly one
  //      live publication for the mode — actually holds afterward.
  //
  // TRUE concurrent serialisation of two `promotePublication` calls against
  // the SAME mode is NOT covered by any test in this codebase. It rests on
  // `pg_advisory_xact_lock` (asserted issued, below) plus 0035's
  // `plan_catalog_publications_one_live_per_mode` partial unique index as the
  // database-level backstop if the lock were ever removed — a real two-
  // connection Postgres, not pglite, would be needed to exercise the race
  // itself.
  it("takes an advisory lock inside its own transaction, and leaves exactly one live publication for the mode", async () => {
    const draft = await createDraftFrom("test", "operator@tesserix");
    const issuedSql: string[] = [];
    const rawQuery = db.query.bind(db);
    const querySpy = vi
      .spyOn(db, "query")
      .mockImplementation(async (sql: string, params?: unknown[]) => {
        issuedSql.push(sql);
        return rawQuery(sql, params);
      });

    try {
      await promotePublication("test", draft, "operator@tesserix");
    } finally {
      querySpy.mockRestore();
    }

    expect(issuedSql.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);

    const { rows: liveRows } = await db.query(
      `SELECT id FROM plan_catalog_publications WHERE mode = 'test' AND superseded_at IS NULL`,
    );
    expect(liveRows).toHaveLength(1);
  });
});
