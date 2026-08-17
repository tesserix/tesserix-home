import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for the write path against a real Postgres (pglite):
 * the grandfathered-row constraint from migration 0021, and that
 * `advanceStage` really writes the opportunity and its `stage_change`
 * activity atomically.
 *
 * Mocked unit tests (crm-repo.test.ts) assert SQL *shape*; they cannot
 * prove that `crm_opp_product_required_when_qualified NOT VALID` actually
 * behaves the way migration 0021's header says it does — that a bare
 * UPDATE on a grandfathered row is rejected by Postgres itself. Only a
 * real database proves that, which is the whole point of this file.
 *
 * `tesserixTx` (in `./tesserix.ts`) is untestable directly: it calls
 * `pool.connect()` against a real network Postgres this suite doesn't have.
 * `runTesserixTx` is its transactional core, pulled out specifically so it
 * can run here — unmodified — against pglite, which satisfies the same
 * `TxClient` shape a `pg.PoolClient` does. Mocking `tesserixTx` is on
 * purpose (there is no pool to connect to); what makes this a real test of
 * the "one transaction" guarantee is that `tesserixTx` below delegates to
 * `runTesserixTx`, the actual shared BEGIN/COMMIT/ROLLBACK logic — not a
 * hand-rolled reimplementation of it that could silently diverge from what
 * ships.
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
    // pglite is a single embedded session with no separate pool to acquire
    // a client from — so it IS a client, structurally: `runTesserixTx`
    // only ever calls `.query(sql, params)` on whatever it's given.
    tesserixTx: async (fn: Parameters<typeof actual.runTesserixTx>[1]) =>
      actual.runTesserixTx(dbHolder.db as Parameters<typeof actual.runTesserixTx>[0], fn),
    isDatabaseConfigured: () => true,
  };
});

const { advanceStage, setNextAction, logActivity, MissingProductError, commitImport } =
  await import("./crm-repo");

let db: PGlite;
let orgId: string;
let grandfatheredOppId: string;
let normalOppId: string;
let failureInjectedOppId: string;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;

  const migrationPath = path.resolve(
    __dirname,
    "../../../web/db/migrations/0019_crm_schema.sql",
  );
  await db.exec(readFileSync(migrationPath, "utf-8"));

  // Migration 0020 (not replayed here — its only job is backfilling
  // `leads`) drops the CHECK so grandfathered rows can be inserted; 0021
  // re-adds the identical CHECK as NOT VALID. Reproduced directly rather
  // than replaying 0021's file, which guards on a `leads` table this
  // fixture doesn't seed.
  await db.exec(
    `ALTER TABLE crm_opportunities DROP CONSTRAINT crm_opp_product_required_when_qualified`,
  );

  const orgResult = await db.query<{ id: string }>(
    `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
    ["Bondi Baker"],
  );
  orgId = orgResult.rows[0].id;

  // A grandfathered row: qualified, product NULL — only insertable while
  // the CHECK is absent, exactly like the real backfill.
  const grandfathered = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, stage, product)
     VALUES ($1, 'qualified', NULL) RETURNING id`,
    [orgId],
  );
  grandfatheredOppId = grandfathered.rows[0].id;

  const normal = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, stage)
     VALUES ($1, 'new') RETURNING id`,
    [orgId],
  );
  normalOppId = normal.rows[0].id;

  const failureInjected = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, stage)
     VALUES ($1, 'new') RETURNING id`,
    [orgId],
  );
  failureInjectedOppId = failureInjected.rows[0].id;

  // Re-add the CHECK as NOT VALID — 0021's actual shape. This does not
  // scan/reject the grandfathered row already inserted above, but DOES
  // enforce the CHECK on every statement from here on.
  await db.exec(
    `ALTER TABLE crm_opportunities
       ADD CONSTRAINT crm_opp_product_required_when_qualified CHECK (
         stage IN ('new', 'contacted') OR product IS NOT NULL
       ) NOT VALID`,
  );

  // A failure-injection trigger: any INSERT into crm_activities naming
  // `failureInjectedOppId` as its opportunity fails, deliberately, so the
  // atomicity test below can prove the UPDATE that precedes it does not
  // survive. This is the discriminating case Critical 1 asked for — the
  // "commits both together" test on its own only proves the SUCCESS path,
  // which passes identically whether `advanceStage` runs its two
  // statements in one transaction or as two independent `tesserixQuery`
  // calls. Only a forced mid-write failure tells the two apart.
  await db.exec(`
    CREATE OR REPLACE FUNCTION crm_test_inject_activity_failure() RETURNS trigger AS $$
    BEGIN
      IF NEW.opportunity_id = '${failureInjectedOppId}' THEN
        RAISE EXCEPTION 'injected failure for atomicity test';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER crm_test_inject_activity_failure_trg
    BEFORE INSERT ON crm_activities
    FOR EACH ROW EXECUTE FUNCTION crm_test_inject_activity_failure();
  `);
});

afterAll(async () => {
  await db.close();
});

describe("the grandfathered-row constraint, against a real CHECK", () => {
  // Proves migration 0021's header claim directly, with no application code
  // involved: a bare `updated_at = now()` on the grandfathered row really is
  // rejected by Postgres itself, not just by this task's own guard.
  it("Postgres itself rejects a bare updated_at touch on the grandfathered row", async () => {
    await expect(
      db.query(`UPDATE crm_opportunities SET updated_at = now() WHERE id = $1`, [
        grandfatheredOppId,
      ]),
    ).rejects.toThrow(/crm_opp_product_required_when_qualified/);
  });

  it("rejects a bare UPDATE on a grandfathered row via setNextAction, before Postgres has to", async () => {
    await expect(
      setNextAction({
        opportunityId: grandfatheredOppId,
        at: null,
        note: "trying to touch it",
        actor: "ava",
      }),
    ).rejects.toBeInstanceOf(MissingProductError);

    // Nothing committed: the row's next_action_note is still unset.
    const rows = await db.query<{ next_action_note: string | null }>(
      `SELECT next_action_note FROM crm_opportunities WHERE id = $1`,
      [grandfatheredOppId],
    );
    expect(rows.rows[0].next_action_note).toBeNull();
  });

  it("unblocks a grandfathered row by supplying the missing product via advanceStage", async () => {
    await advanceStage({
      opportunityId: grandfatheredOppId,
      to: "qualified",
      product: "mark8ly",
      actor: "ava",
    });

    const rows = await db.query<{ product: string | null }>(
      `SELECT product FROM crm_opportunities WHERE id = $1`,
      [grandfatheredOppId],
    );
    expect(rows.rows[0].product).toBe("mark8ly");

    // No stage_change: the stage itself never changed, only the product.
    const activities = await db.query<{ kind: string }>(
      `SELECT kind FROM crm_activities WHERE opportunity_id = $1`,
      [grandfatheredOppId],
    );
    expect(activities.rows.map((r) => r.kind)).not.toContain("stage_change");
  });

  it("once unblocked, ordinary writes succeed", async () => {
    await setNextAction({
      opportunityId: grandfatheredOppId,
      at: "2026-09-01T09:00:00.000Z",
      note: "follow up",
      actor: "ava",
    });
    const rows = await db.query<{ next_action_note: string | null }>(
      `SELECT next_action_note FROM crm_opportunities WHERE id = $1`,
      [grandfatheredOppId],
    );
    expect(rows.rows[0].next_action_note).toBe("follow up");
  });
});

describe("advanceStage writes the opportunity and its stage_change activity atomically", () => {
  it("commits both the UPDATE and the INSERT together", async () => {
    await advanceStage({
      opportunityId: normalOppId,
      to: "contacted",
      actor: "ava",
    });

    const opp = await db.query<{ stage: string }>(
      `SELECT stage FROM crm_opportunities WHERE id = $1`,
      [normalOppId],
    );
    expect(opp.rows[0].stage).toBe("contacted");

    const activities = await db.query<{ kind: string; body: string }>(
      `SELECT kind, body FROM crm_activities WHERE opportunity_id = $1`,
      [normalOppId],
    );
    expect(activities.rows).toHaveLength(1);
    expect(activities.rows[0].kind).toBe("stage_change");
  });

  it("refuses to move to won without a product, leaving the row untouched", async () => {
    // advanceStage's own validation refuses before any statement runs — the
    // row is untouched not because of a rollback but because nothing was
    // ever sent. Included alongside the atomicity test above so both halves
    // of "the row never ends up half-changed" are covered: the ordinary
    // stage_change case (both writes land) and this refusal case (neither
    // does).
    await expect(
      advanceStage({ opportunityId: normalOppId, to: "won", actor: "ava" }),
    ).rejects.toThrow(/product/i);

    const opp = await db.query<{ stage: string }>(
      `SELECT stage FROM crm_opportunities WHERE id = $1`,
      [normalOppId],
    );
    // Still "contacted" from the previous test, not "won" and not broken.
    expect(opp.rows[0].stage).toBe("contacted");
  });

  it("logActivity inserts independently of any opportunity constraint", async () => {
    await logActivity({
      organisationId: orgId,
      opportunityId: grandfatheredOppId,
      kind: "note",
      actor: "ava",
      body: "a plain note, no stage involved",
    });
    const activities = await db.query<{ body: string }>(
      `SELECT body FROM crm_activities WHERE opportunity_id = $1 AND kind = 'note'`,
      [grandfatheredOppId],
    );
    expect(activities.rows.map((r) => r.body)).toContain("a plain note, no stage involved");
  });

  // Critical 1's discriminating case: force the SECOND statement (the
  // activity INSERT) to fail after the FIRST (the opportunity UPDATE) has
  // already run, and assert the UPDATE did not survive. This is the test
  // that tells a real transaction apart from two independent `tesserixQuery`
  // calls — against non-transactional code, the UPDATE commits on its own
  // the moment it runs, so the row would read "contacted" here regardless
  // of what happens to the INSERT after it. It only reads "new" — its
  // starting stage — because `runTesserixTx` rolled the UPDATE back along
  // with the failed INSERT, on the one client both statements shared.
  it("rolls back the UPDATE when the activity INSERT fails — the real discriminator for atomicity", async () => {
    await expect(
      advanceStage({ opportunityId: failureInjectedOppId, to: "contacted", actor: "ava" }),
    ).rejects.toThrow(/injected failure/);

    const opp = await db.query<{ stage: string }>(
      `SELECT stage FROM crm_opportunities WHERE id = $1`,
      [failureInjectedOppId],
    );
    expect(opp.rows[0].stage).toBe("new");

    const activities = await db.query<{ id: string }>(
      `SELECT id FROM crm_activities WHERE opportunity_id = $1`,
      [failureInjectedOppId],
    );
    expect(activities.rows).toHaveLength(0);
  });
});

// Ruling 25 (review round 2): the mocked unit tests in crm-repo.test.ts
// prove `commitImport` threads its transaction's own `query` into
// `isSuppressed`/`findMatchingOrganisationId` (Ruling 23) — but a mock
// never executes SQL, so it can only pin the WIRING, never prove the dedup
// SELECT actually matches what the INSERT two lines below it wrote. If the
// two normalisations (this SELECT's `lower(email)` vs. the INSERT's
// `.trim().toLowerCase()`) ever drifted, the same-connection read would
// find nothing, the second row's insert would trip
// `crm_contacts_email_lower_uq`, and the whole batch would roll back — the
// original symptom, with the mock test still green. Only a real database,
// with the real unique index and the real normalisation round trip, can
// catch that. This is the ONE case this file adds for Ruling 23 — no
// Postgres container, no pool: the two-connection property itself is
// already structural and greppable (`crm-repo.ts` has exactly one call
// site per lookup, both passed `query`), so a container test here would be
// a load test, not a regression test.
describe("commitImport dedups within one batch, against the real crm_contacts_email_lower_uq", () => {
  it("commits the first occurrence of a shared email and matches the second, as one organisation", async () => {
    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_organisations`,
    );
    const orgCountBefore = Number(before.rows[0].count);

    const result = await commitImport(
      [
        { name: "Dup Co", email: "  Dup@Example.com  " },
        { name: "Dup Co Again", email: "dup@example.com" },
      ],
      "ava@tesserix.app",
    );

    expect(result.created).toBe(1);
    expect(result.matchedExisting).toBe(1);

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_organisations`,
    );
    expect(Number(after.rows[0].count)).toBe(orgCountBefore + 1);

    const contacts = await db.query<{ email: string }>(
      `SELECT email FROM crm_contacts WHERE lower(email) = 'dup@example.com'`,
    );
    expect(contacts.rows).toHaveLength(1);
  });
});
