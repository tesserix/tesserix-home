import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #245 — the drift clock, against a real Postgres (pglite).
 *
 * `logActivity` is the only writer of `crm_opportunities.last_contacted_at`,
 * and the drifting queue is the only reader. The mocked unit tests
 * (crm-repo.test.ts) assert the SQL's *shape*; only a real database says
 * which ROWS that predicate selects — and "every open deal, no terminal one"
 * is a claim about rows, not about text. The queue test at the bottom closes
 * the loop the bug actually lived in: an organisation sitting in Drifting
 * leaves it once contact is logged.
 *
 * The `tesserix` mock mirrors crm-repo.write.integration.test.ts: `tesserixTx`
 * delegates to the real `runTesserixTx`, so what runs here is the shipped
 * BEGIN/COMMIT/ROLLBACK logic against a client pglite structurally satisfies,
 * not a reimplementation of it.
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
    tesserixTx: async (fn: Parameters<typeof actual.runTesserixTx>[1]) =>
      actual.runTesserixTx(dbHolder.db as Parameters<typeof actual.runTesserixTx>[0], fn),
    isDatabaseConfigured: () => true,
  };
});

const { logActivity, driftingOpportunities, SuppressedContactError } =
  await import("./crm-repo");

const MIGRATIONS = ["0019_crm_schema.sql", "0022_crm_suppressions_normalize.sql"];

let db: PGlite;

/** Every migration this file's tables need, applied to a fresh database.
 *  Per-test rather than per-file: the clock assertions below all read
 *  "is this timestamp still null?", which only means anything on rows no
 *  earlier test has already touched. */
beforeEach(async () => {
  db = new PGlite();
  dbHolder.db = db;
  for (const file of MIGRATIONS) {
    const migration = path.resolve(__dirname, "../../../web/db/migrations", file);
    await db.exec(readFileSync(migration, "utf-8"));
  }
});

afterEach(async () => {
  await db.close();
});

async function seedOrganisation(name: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
    [name],
  );
  return rows.rows[0].id;
}

interface SeedOpportunity {
  stage: string;
  product?: string | null;
  createdAt?: string;
}

async function seedOpportunity(
  organisationId: string,
  { stage, product = null, createdAt }: SeedOpportunity,
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, stage, product, created_at)
     VALUES ($1, $2::crm_stage, $3, COALESCE($4::timestamptz, now())) RETURNING id`,
    [organisationId, stage, product, createdAt ?? null],
  );
  return rows.rows[0].id;
}

async function lastContactedAt(opportunityId: string): Promise<Date | null> {
  const rows = await db.query<{ last_contacted_at: Date | null }>(
    `SELECT last_contacted_at FROM crm_opportunities WHERE id = $1`,
    [opportunityId],
  );
  return rows.rows[0].last_contacted_at;
}

async function activityCount(organisationId: string): Promise<number> {
  const rows = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM crm_activities WHERE organisation_id = $1`,
    [organisationId],
  );
  return Number(rows.rows[0].count);
}

describe("an organisation-level contact event and the drift clock", () => {
  it("advances every open opportunity and no terminal one", async () => {
    const orgId = await seedOrganisation("Bondi Baker");
    const open = {
      fresh: await seedOpportunity(orgId, { stage: "new" }),
      contacted: await seedOpportunity(orgId, { stage: "contacted" }),
      qualified: await seedOpportunity(orgId, { stage: "qualified", product: "mark8ly" }),
    };
    const terminal = {
      won: await seedOpportunity(orgId, { stage: "won", product: "mark8ly" }),
      lost: await seedOpportunity(orgId, { stage: "lost", product: "mark8ly" }),
    };

    await logActivity({ organisationId: orgId, kind: "call", actor: "ava" });

    for (const [name, id] of Object.entries(open)) {
      expect(await lastContactedAt(id), `open opportunity: ${name}`).not.toBeNull();
    }
    // The other half, and the half a shape assertion cannot make: a won or
    // lost deal's clock is not the operator's business any more, and a test
    // that only checked the open rows would pass while these moved too.
    for (const [name, id] of Object.entries(terminal)) {
      expect(await lastContactedAt(id), `terminal opportunity: ${name}`).toBeNull();
    }
  });

  it("advances nothing for a note — recording a thought is not contact", async () => {
    const orgId = await seedOrganisation("Bondi Baker");
    const oppId = await seedOpportunity(orgId, { stage: "new" });

    await logActivity({ organisationId: orgId, kind: "note", actor: "ava", body: "a thought" });

    expect(await lastContactedAt(oppId)).toBeNull();
    expect(await activityCount(orgId)).toBe(1);
  });

  it("records the contact against an organisation that has no opportunities at all", async () => {
    const orgId = await seedOrganisation("No Deals Yet");

    await expect(
      logActivity({ organisationId: orgId, kind: "call", actor: "ava", body: "cold call" }),
    ).resolves.toBeUndefined();

    expect(await activityCount(orgId)).toBe(1);
  });

  // Migration 0021's CHECK is evaluated on the new row version of EVERY
  // update, including a bare clock bump — so a grandfathered deal (qualified,
  // product NULL) would reject the organisation-level UPDATE and, in one
  // transaction, take the activity row down with it. The operator named no
  // deal; refusing to record that they called the business, because an
  // unrelated deal is missing a product, is the wrong trade. The predicate
  // therefore skips exactly the rows the CHECK would reject, and those rows
  // stay in Drifting until someone supplies the product `setNextAction`
  // already asks for.
  it("skips a grandfathered deal rather than failing the whole log", async () => {
    const orgId = await seedOrganisation("Migrated Co");
    await db.exec(
      `ALTER TABLE crm_opportunities DROP CONSTRAINT crm_opp_product_required_when_qualified`,
    );
    const grandfathered = await seedOpportunity(orgId, { stage: "qualified", product: null });
    await db.exec(
      `ALTER TABLE crm_opportunities
         ADD CONSTRAINT crm_opp_product_required_when_qualified CHECK (
           stage IN ('new', 'contacted') OR product IS NOT NULL
         ) NOT VALID`,
    );
    const healthy = await seedOpportunity(orgId, { stage: "new" });

    await logActivity({ organisationId: orgId, kind: "dm_sent", actor: "ava" });

    expect(await activityCount(orgId)).toBe(1);
    expect(await lastContactedAt(healthy)).not.toBeNull();
    expect(await lastContactedAt(grandfathered)).toBeNull();
  });
});

describe("the do-not-contact list, now that outbound kinds are reachable", () => {
  async function seedSuppressedOrganisation(): Promise<{ orgId: string; oppId: string }> {
    const orgId = await seedOrganisation("Asked Us To Stop");
    await db.query(
      `INSERT INTO crm_contacts (organisation_id, email) VALUES ($1, $2)`,
      [orgId, "gone@example.com"],
    );
    await db.query(
      `INSERT INTO crm_suppressions (email, reason, created_by) VALUES ($1, $2, $3)`,
      ["gone@example.com", "asked to stop", "ava"],
    );
    const oppId = await seedOpportunity(orgId, { stage: "new" });
    return { orgId, oppId };
  }

  it("refuses outbound contact and writes nothing at all — no activity, no clock bump", async () => {
    const { orgId, oppId } = await seedSuppressedOrganisation();

    await expect(
      logActivity({ organisationId: orgId, kind: "email_sent", actor: "ava", body: "hello" }),
    ).rejects.toBeInstanceOf(SuppressedContactError);

    expect(await activityCount(orgId)).toBe(0);
    expect(await lastContactedAt(oppId)).toBeNull();
  });

  it("still records an inbound message, and still moves the clock for it", async () => {
    const { orgId, oppId } = await seedSuppressedOrganisation();

    await logActivity({ organisationId: orgId, kind: "email_received", actor: "ava" });

    expect(await activityCount(orgId)).toBe(1);
    expect(await lastContactedAt(oppId)).not.toBeNull();
  });
});

/**
 * The bug itself, stated as a test. Before the fix this could not pass: the
 * console had no way to write `last_contacted_at`, so an organisation entered
 * Drifting 14 days after import and never left, however much outreach was
 * logged against it. That is the production state #245 describes — 259
 * organisations, all Drifting.
 */
describe("Drifting, end to end", () => {
  const DRIFT_DAYS = 14;

  async function driftingIds(): Promise<string[]> {
    const page = await driftingOpportunities({}, DRIFT_DAYS, 50);
    return page.rows.map((row) => row.id);
  }

  it("an organisation leaves the queue once a contact event is logged", async () => {
    const orgId = await seedOrganisation("Quiet Since May");
    const oppId = await seedOpportunity(orgId, {
      stage: "new",
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(await driftingIds()).toContain(oppId);

    await logActivity({ organisationId: orgId, kind: "call", actor: "ava", body: "spoke to Ana" });

    expect(await driftingIds()).not.toContain(oppId);
  });

  it("a note leaves it exactly where it was — the queue still means what it says", async () => {
    const orgId = await seedOrganisation("Still Quiet");
    const oppId = await seedOpportunity(orgId, {
      stage: "new",
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    await logActivity({ organisationId: orgId, kind: "note", actor: "ava", body: "looks promising" });

    expect(await driftingIds()).toContain(oppId);
  });
});
