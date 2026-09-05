import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for `deleteOpportunity` (tesserix-home#251). Real
 * (in-process) Postgres via pglite: the claim that matters here — the
 * activity trail survives the delete, detached — is enforced by 0048's
 * foreign key and by nothing in TypeScript, so it can only be proven against
 * an actual database.
 *
 * Own pglite instance, and its own file rather than a describe block in
 * `crm-erasure.integration.test.ts`: a `vi.mock` in one test file cannot be
 * shared with another (see crm-writes.integration.test.ts), and that file's
 * subject is the two DPDP operations, which this is not — see the module
 * comment on crm-erasure.ts.
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
    // pglite is a single embedded session with no separate pool to acquire a
    // client from — so it IS a client, structurally. Delegating to the real
    // `runTesserixTx` is what makes this exercise the BEGIN/COMMIT logic that
    // ships, which matters here: the count and the delete must be one
    // transaction or the count describes a different moment than the delete.
    tesserixTx: async (fn: Parameters<typeof actual.runTesserixTx>[1]) =>
      actual.runTesserixTx(dbHolder.db as Parameters<typeof actual.runTesserixTx>[0], fn),
    isDatabaseConfigured: () => true,
  };
});

const { deleteOpportunity } = await import("./crm-erasure");

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../web/db/migrations");

// 0019 creates all four tables; 0048 re-points `crm_activities.opportunity_id`
// from CASCADE to SET NULL, which is the behaviour every claim below rests on.
// Nothing between them touches either, so loading the intervening migrations
// would only add ways for this file to fail for reasons it is not about.
const MIGRATIONS = ["0019_crm_schema.sql", "0048_crm_activities_opportunity_set_null.sql"];

let db: PGlite;
let orgId: string;
let opportunityId: string;
let otherOpportunityId: string;
let contactId: string;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;
  for (const migration of MIGRATIONS) {
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, migration), "utf-8"));
  }
});

afterAll(async () => {
  await db.close();
});

// Rebuilt per test rather than once for the suite: deleting the fixture is
// what every test here does.
beforeEach(async () => {
  await db.query(`TRUNCATE crm_organisations CASCADE`);

  const org = await db.query<{ id: string }>(
    `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
    ["Bondi Baker"],
  );
  orgId = org.rows[0].id;

  const contact = await db.query<{ id: string }>(
    `INSERT INTO crm_contacts (organisation_id, name) VALUES ($1, $2) RETURNING id`,
    [orgId, "Nina Falk"],
  );
  contactId = contact.rows[0].id;

  const opportunity = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, product, stage)
     VALUES ($1, 'mark8ly', 'qualified') RETURNING id`,
    [orgId],
  );
  opportunityId = opportunity.rows[0].id;

  const other = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, product, stage)
     VALUES ($1, 'kora', 'contacted') RETURNING id`,
    [orgId],
  );
  otherOpportunityId = other.rows[0].id;
});

/**
 * Deliberately asymmetric: two activities on the deal being deleted, one on
 * the sibling deal, one scoped to the business alone. A symmetric fixture
 * would pass a count that read the whole organisation's activity log, or one
 * that read the sibling's.
 */
async function seedActivities(): Promise<void> {
  await db.query(
    `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body)
     VALUES ($1, $2, 'stage_change', $4, 'new → qualified'),
            ($1, $2, 'dm_sent', $4, 'First DM about Mark8ly'),
            ($1, $3, 'note', $4, 'Kora deal note'),
            ($1, NULL, 'note', $4, 'Business-level note')`,
    [orgId, opportunityId, otherOpportunityId, "operator@tesserix.app"],
  );
}

describe("deleteOpportunity", () => {
  it("removes the opportunity and names the organisation and product for the audit row", async () => {
    const result = await deleteOpportunity(opportunityId);

    expect(result).toEqual({
      opportunityId,
      organisationId: orgId,
      organisationName: "Bondi Baker",
      product: "mark8ly",
      activitiesDetached: 0,
    });
    const remaining = await db.query(`SELECT id FROM crm_opportunities WHERE id = $1`, [
      opportunityId,
    ]);
    expect(remaining.rows).toHaveLength(0);
  });

  it("keeps a product-less mis-click deletable, and reports its null product", async () => {
    // The row #251 exists to remove: "New opportunity" clicked twice, so
    // `product` is NULL and `stage` is still 'new'. A delete that assumed a
    // product would refuse the only row it is really for.
    const misclick = await db.query<{ id: string }>(
      `INSERT INTO crm_opportunities (organisation_id) VALUES ($1) RETURNING id`,
      [orgId],
    );

    const result = await deleteOpportunity(misclick.rows[0].id);

    expect(result?.product).toBeNull();
    expect(result?.organisationName).toBe("Bondi Baker");
  });

  it("detaches its activities rather than deleting them, and counts them", async () => {
    await seedActivities();

    const result = await deleteOpportunity(opportunityId);

    expect(result?.activitiesDetached).toBe(2);
    const activities = await db.query<{ body: string; opportunity_id: string | null }>(
      `SELECT body, opportunity_id FROM crm_activities
        WHERE organisation_id = $1 ORDER BY body`,
      [orgId],
    );
    // All four survive. The two that were scoped to the deleted deal now
    // carry NULL — the shape `organisationTimeline` already reads and
    // `crm-outreach.ts` already writes — and the sibling deal's activity
    // keeps its own `opportunity_id`, which is what proves the detach was
    // scoped to one deal rather than to the organisation.
    expect(activities.rows).toEqual([
      { body: "Business-level note", opportunity_id: null },
      { body: "First DM about Mark8ly", opportunity_id: null },
      { body: "Kora deal note", opportunity_id: otherOpportunityId },
      { body: "new → qualified", opportunity_id: null },
    ]);
  });

  it("leaves the organisation, its other opportunities and its contacts untouched", async () => {
    await seedActivities();

    await deleteOpportunity(opportunityId);

    const orgs = await db.query(`SELECT id FROM crm_organisations WHERE id = $1`, [orgId]);
    expect(orgs.rows).toEqual([{ id: orgId }]);
    const opportunities = await db.query<{ id: string }>(
      `SELECT id FROM crm_opportunities WHERE organisation_id = $1`,
      [orgId],
    );
    expect(opportunities.rows).toEqual([{ id: otherOpportunityId }]);
    const contacts = await db.query<{ id: string }>(
      `SELECT id FROM crm_contacts WHERE organisation_id = $1`,
      [orgId],
    );
    expect(contacts.rows).toEqual([{ id: contactId }]);
  });

  it("returns null for an id that does not exist", async () => {
    // Not an exception and not a fabricated success: the caller writes an
    // audit row from this return value, and it must be able to tell "this
    // call removed a deal" from "there was nothing here".
    await expect(
      deleteOpportunity("00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeNull();
  });
});
