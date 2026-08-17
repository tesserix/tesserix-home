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
  // pglite has no separate connection pool to acquire a client from, so
  // there is nothing distinct to hand out — every statement in the
  // callback runs through the same in-process instance, wrapped in a real
  // BEGIN/COMMIT/ROLLBACK exactly like `tesserixTx` does against a pool.
  tesserixTx: async (fn: (query: typeof tesserixQueryForTx) => unknown) => {
    const db = dbHolder.db as {
      query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
    };
    await db.query("BEGIN", []);
    try {
      const out = await fn(tesserixQueryForTx);
      await db.query("COMMIT", []);
      return out;
    } catch (err) {
      await db.query("ROLLBACK", []);
      throw err;
    }
  },
  isDatabaseConfigured: () => true,
}));

async function tesserixQueryForTx(sql: string, params: readonly unknown[] = []) {
  const db = dbHolder.db as {
    query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
  };
  const result = await db.query(sql, params as unknown[]);
  return result.rows;
}

const { advanceStage, setNextAction, logActivity, MissingProductError } = await import(
  "./crm-repo"
);

let db: PGlite;
let orgId: string;
let grandfatheredOppId: string;
let normalOppId: string;

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

  // Re-add the CHECK as NOT VALID — 0021's actual shape. This does not
  // scan/reject the grandfathered row already inserted above, but DOES
  // enforce the CHECK on every statement from here on.
  await db.exec(
    `ALTER TABLE crm_opportunities
       ADD CONSTRAINT crm_opp_product_required_when_qualified CHECK (
         stage IN ('new', 'contacted') OR product IS NOT NULL
       ) NOT VALID`,
  );
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
});
