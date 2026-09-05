import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for `crm-void.ts` against a real Postgres (pglite).
 *
 * A real database is not optional here. The single hardest thing about a
 * void is that it is an UPDATE, and `crm_opp_product_required_when_qualified`
 * (0021, `NOT VALID`) is re-evaluated against the new row of every UPDATE —
 * so a grandfathered `qualified` deal with no product cannot be voided by
 * the bare UPDATE at all. A mocked suite asserting SQL shape would happily
 * pass while production raised a raw 23514. What is asserted below is that
 * the guard fires FIRST, so the operator gets `MissingProductError` and the
 * row is left exactly as it was.
 *
 * `tesserixTx` is mocked to delegate to `runTesserixTx` — the real shared
 * BEGIN/COMMIT/ROLLBACK core — because `tesserixTx` itself calls
 * `pool.connect()` against a network Postgres this suite does not have.
 * The same arrangement `crm-repo.write.integration.test.ts` uses, and for
 * the same reason: what makes this a real test of "one transaction" is that
 * the shipped transaction logic runs, not a reimplementation of it.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../web/db/migrations");

function readMigration(filename: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, filename), "utf-8");
}

const dbHolder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("./tesserix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tesserix")>();
  return {
    ...actual,
    // pglite is a single embedded session with no pool to acquire a client
    // from — so it IS a client, structurally: `runTesserixTx` only ever
    // calls `.query(sql, params)` on whatever it is given.
    tesserixTx: async (fn: Parameters<typeof actual.runTesserixTx>[1]) =>
      actual.runTesserixTx(dbHolder.db as Parameters<typeof actual.runTesserixTx>[0], fn),
    isDatabaseConfigured: () => true,
  };
});

const { MissingProductError } = await import("./crm-repo");
const { voidOpportunity, restoreOpportunity } = await import("./crm-void");

const ACTOR = "ops@tesserix.app";

let db: PGlite;
let orgId: string;

interface OpportunityRow {
  stage: string;
  product: string | null;
  voided_at: Date | null;
  voided_reason: string | null;
  updated_at: Date;
}

interface ActivityRow {
  kind: string;
  actor: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
  opportunity_id: string | null;
  organisation_id: string;
}

async function readOpportunity(id: string): Promise<OpportunityRow> {
  const result = await db.query<OpportunityRow>(
    `SELECT stage, product, voided_at, voided_reason, updated_at
       FROM crm_opportunities WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

async function readActivities(opportunityId: string): Promise<ActivityRow[]> {
  const result = await db.query<ActivityRow>(
    `SELECT kind, actor, body, metadata, opportunity_id, organisation_id
       FROM crm_activities WHERE opportunity_id = $1 ORDER BY occurred_at, body`,
    [opportunityId],
  );
  return result.rows;
}

async function insertOpportunity(stage: string, product: string | null): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, stage, product)
     VALUES ($1, $2, $3) RETURNING id`,
    [orgId, stage, product],
  );
  return result.rows[0].id;
}

/**
 * A row the lead backfill grandfathered past the CHECK: `qualified`, no
 * product. Only insertable while the constraint is absent, which is exactly
 * how production got its ~155 of them — 0020 drops the CHECK, the backfill
 * lands these rows in the gap, and 0021 re-adds it `NOT VALID` over them.
 * Reproduced here rather than replaying 0020/0021, which guard on a `leads`
 * table this fixture does not seed.
 */
async function insertGrandfathered(): Promise<string> {
  await db.exec(
    `ALTER TABLE crm_opportunities DROP CONSTRAINT crm_opp_product_required_when_qualified`,
  );
  const id = await insertOpportunity("qualified", null);
  await db.exec(
    `ALTER TABLE crm_opportunities
       ADD CONSTRAINT crm_opp_product_required_when_qualified CHECK (
         stage IN ('new', 'contacted') OR product IS NOT NULL
       ) NOT VALID`,
  );
  return id;
}

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;
  await db.exec(readMigration("0019_crm_schema.sql"));
  await db.exec(readMigration("0049_crm_opportunities_voided.sql"));
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query(`TRUNCATE crm_organisations CASCADE`);
  const org = await db.query<{ id: string }>(
    `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
    ["Bondi Baker"],
  );
  orgId = org.rows[0].id;
});

describe("voidOpportunity", () => {
  it("stamps both columns, bumps updated_at, and reports that it voided", async () => {
    // `new` with no product: the actual mis-click this feature exists for,
    // and the case 0021's CHECK permits because its first disjunct holds.
    const id = await insertOpportunity("new", null);
    const before = await readOpportunity(id);

    const result = await voidOpportunity({
      opportunityId: id,
      reason: "Duplicate of the other Bondi deal",
      actor: ACTOR,
    });

    // The identity comes back alongside the outcome so the action layer can
    // name the deal in its audit row — an opportunity has no name of its
    // own — read under the same lock as the write.
    expect(result).toEqual({
      voided: true,
      opportunityId: id,
      organisationId: orgId,
      organisationName: "Bondi Baker",
      product: null,
    });
    const after = await readOpportunity(id);
    expect(after.voided_at).not.toBeNull();
    expect(after.voided_reason).toBe("Duplicate of the other Bondi deal");
    // crm_opportunities has no updated_at trigger, so this moves only
    // because the UPDATE names the column by hand.
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    // The stage the deal reached stays true and stays readable — a void is
    // a second fact about the row, not a sixth stage.
    expect(after.stage).toBe("new");
  });

  it("writes a note activity — never a stage_change — in the same transaction", async () => {
    const id = await insertOpportunity("new", null);

    await voidOpportunity({ opportunityId: id, reason: "Wrong company", actor: ACTOR });

    const activities = await readActivities(id);
    expect(activities).toHaveLength(1);
    // `stage_change` carries {from,to} and is the funnel's source of truth
    // for stage timing. A void written as one would inject a transition
    // that never happened into the exact aggregate this design protects.
    expect(activities[0].kind).toBe("note");
    expect(activities[0].actor).toBe(ACTOR);
    expect(activities[0].body).toContain("Wrong company");
    expect(activities[0].metadata).toMatchObject({ voidAction: "voided", reason: "Wrong company" });
    // Attached to the deal AND its organisation, so it survives on the
    // organisation's file and stays partitionable by opportunity.
    expect(activities[0].opportunity_id).toBe(id);
    expect(activities[0].organisation_id).toBe(orgId);
  });

  it("accepts a void with no reason, and treats a blank reason as none", async () => {
    // The migration's CHECK is an implication, not a biconditional,
    // precisely so this state is legal.
    const noReason = await insertOpportunity("new", null);
    await voidOpportunity({ opportunityId: noReason, reason: null, actor: ACTOR });
    expect((await readOpportunity(noReason)).voided_reason).toBeNull();

    const blank = await insertOpportunity("new", null);
    await voidOpportunity({ opportunityId: blank, reason: "   ", actor: ACTOR });
    expect((await readOpportunity(blank)).voided_reason).toBeNull();
  });

  it("returns the product it read, so the caller can name a deal that has one", async () => {
    // The `null` product above is the mis-click case; this is the other
    // half of the audit target the action layer builds from this result.
    const id = await insertOpportunity("qualified", "mark8ly");

    const result = await voidOpportunity({ opportunityId: id, reason: null, actor: ACTOR });

    expect(result).toMatchObject({
      voided: true,
      product: "mark8ly",
      organisationName: "Bondi Baker",
    });
  });

  it("treats a second void as a no-op, leaving the first void's record intact", async () => {
    const id = await insertOpportunity("new", null);
    await voidOpportunity({ opportunityId: id, reason: "First reason", actor: ACTOR });
    const afterFirst = await readOpportunity(id);

    const result = await voidOpportunity({
      opportunityId: id,
      reason: "Second reason",
      actor: ACTOR,
    });

    // A no-op is a valid, zero-effect outcome, not an error — but the
    // caller must be able to say honestly that nothing happened, or a
    // second click reads in the audit log as a second void.
    expect(result).toEqual({
      voided: false,
      opportunityId: id,
      organisationId: orgId,
      organisationName: "Bondi Baker",
      product: null,
    });
    const afterSecond = await readOpportunity(id);
    expect(afterSecond.voided_at?.getTime()).toBe(afterFirst.voided_at?.getTime());
    expect(afterSecond.voided_reason).toBe("First reason");
    expect(afterSecond.updated_at.getTime()).toBe(afterFirst.updated_at.getTime());
    expect(await readActivities(id)).toHaveLength(1);
  });

  it("refuses a grandfathered row with a typed error, not a raw 23514", async () => {
    const id = await insertGrandfathered();

    await expect(
      voidOpportunity({ opportunityId: id, reason: "Bad import", actor: ACTOR }),
    ).rejects.toBeInstanceOf(MissingProductError);
    // Specifically NOT the database's own message: the guard has to fire
    // before the UPDATE, or the operator reads a constraint name.
    await expect(
      voidOpportunity({ opportunityId: id, reason: "Bad import", actor: ACTOR }),
    ).rejects.not.toThrow(/crm_opp_product_required_when_qualified/);

    const row = await readOpportunity(id);
    expect(row.voided_at).toBeNull();
    expect(row.voided_reason).toBeNull();
    expect(await readActivities(id)).toHaveLength(0);
  });

  it("rejects an opportunity that does not exist", async () => {
    await expect(
      voidOpportunity({
        opportunityId: "00000000-0000-0000-0000-000000000000",
        reason: null,
        actor: ACTOR,
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe("restoreOpportunity", () => {
  it("clears both columns, bumps updated_at, and writes its own note", async () => {
    const id = await insertOpportunity("new", null);
    await voidOpportunity({ opportunityId: id, reason: "Duplicate", actor: ACTOR });
    const voided = await readOpportunity(id);

    const result = await restoreOpportunity({ opportunityId: id, actor: ACTOR });

    expect(result).toEqual({
      restored: true,
      opportunityId: id,
      organisationId: orgId,
      organisationName: "Bondi Baker",
      product: null,
    });
    const after = await readOpportunity(id);
    // Both, not just `voided_at`: `crm_opp_void_reason_requires_void` would
    // reject a restore that left the reason behind, and a live deal
    // carrying an explanation for a void no longer in force is readable on
    // the card and wrong.
    expect(after.voided_at).toBeNull();
    expect(after.voided_reason).toBeNull();
    expect(after.updated_at.getTime()).toBeGreaterThan(voided.updated_at.getTime());

    const activities = await readActivities(id);
    expect(activities).toHaveLength(2);
    const restoreNote = activities.find((row) => row.metadata?.voidAction === "restored");
    expect(restoreNote?.kind).toBe("note");
    expect(restoreNote?.actor).toBe(ACTOR);
  });

  it("treats restoring a live deal as a no-op", async () => {
    const id = await insertOpportunity("new", null);
    const before = await readOpportunity(id);

    const result = await restoreOpportunity({ opportunityId: id, actor: ACTOR });

    expect(result).toEqual({
      restored: false,
      opportunityId: id,
      organisationId: orgId,
      organisationName: "Bondi Baker",
      product: null,
    });
    expect((await readOpportunity(id)).updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(await readActivities(id)).toHaveLength(0);
  });

  it("refuses a voided grandfathered row with the same typed error", async () => {
    // Unreachable through this module — a row that could not be voided
    // cannot be in the voided set — so the state is forced here with raw
    // SQL, past both CHECKs, to prove the guard is not load-bearing on that
    // reasoning alone.
    const id = await insertGrandfathered();
    await db.exec(
      `ALTER TABLE crm_opportunities DROP CONSTRAINT crm_opp_product_required_when_qualified`,
    );
    await db.query(`UPDATE crm_opportunities SET voided_at = now() WHERE id = $1`, [id]);
    await db.exec(
      `ALTER TABLE crm_opportunities
         ADD CONSTRAINT crm_opp_product_required_when_qualified CHECK (
           stage IN ('new', 'contacted') OR product IS NOT NULL
         ) NOT VALID`,
    );

    await expect(restoreOpportunity({ opportunityId: id, actor: ACTOR })).rejects.toBeInstanceOf(
      MissingProductError,
    );
    expect((await readOpportunity(id)).voided_at).not.toBeNull();
  });

  it("rejects an opportunity that does not exist", async () => {
    await expect(
      restoreOpportunity({
        opportunityId: "00000000-0000-0000-0000-000000000000",
        actor: ACTOR,
      }),
    ).rejects.toThrow(/not found/);
  });
});
