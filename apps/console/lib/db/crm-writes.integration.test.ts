import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for the manual-create writes: `createOrganisation`,
 * `createContact`, `createOpportunity`. These are the only door into
 * `crm_organisations` / `crm_contacts` / `crm_opportunities` besides
 * `commitImport` — a lead phoned in has no CSV row to import through.
 *
 * A real (in-process) Postgres via pglite, not a mocked query shape:
 * `createOrganisation`'s rollback-on-collision guarantee and the real
 * case-insensitive unique index (`crm_contacts_email_lower_uq`) can only be
 * proven against actual constraint enforcement, not asserted SQL text.
 *
 * Own pglite instance — `crm-repo.integration.test.ts` and
 * `crm-repo.write.integration.test.ts` each have theirs; a `vi.mock` in one
 * test file cannot be shared with another.
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
    // client from — so it IS a client, structurally: `runTesserixTx` only
    // ever calls `.query(sql, params)` on whatever it's given. Delegating to
    // the real `runTesserixTx` (not a hand-rolled reimplementation) is what
    // makes the rollback test below a test of the actual BEGIN/COMMIT/
    // ROLLBACK logic that ships.
    tesserixTx: async (fn: Parameters<typeof actual.runTesserixTx>[1]) =>
      actual.runTesserixTx(dbHolder.db as Parameters<typeof actual.runTesserixTx>[0], fn),
    isDatabaseConfigured: () => true,
  };
});

const { createOrganisation, createContact, createOpportunity } = await import("./crm-writes");
const { addSuppression, SuppressedContactError } = await import("./crm-repo");

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;

  const migrationPath = path.resolve(
    __dirname,
    "../../../web/db/migrations/0019_crm_schema.sql",
  );
  await db.exec(readFileSync(migrationPath, "utf-8"));

  const normalizeMigrationPath = path.resolve(
    __dirname,
    "../../../web/db/migrations/0022_crm_suppressions_normalize.sql",
  );
  await db.exec(readFileSync(normalizeMigrationPath, "utf-8"));

  // 0025 adds `crm_organisations.country`, which `createOrganisation` now
  // writes — without it here, this fixture's inserts would fail on an
  // unknown column.
  const countryMigrationPath = path.resolve(
    __dirname,
    "../../../web/db/migrations/0025_crm_organisations_country.sql",
  );
  await db.exec(readFileSync(countryMigrationPath, "utf-8"));
});

afterAll(async () => {
  await db.close();
});

describe("createOrganisation / createOpportunity", () => {
  it("creates an organisation with no contact and no opportunity", async () => {
    const { organisationId } = await createOrganisation({ name: "Solo Business" });
    const rows = await db.query(`SELECT name FROM crm_organisations WHERE id = $1`, [
      organisationId,
    ]);
    expect(rows.rows).toHaveLength(1);
  });

  it("creates organisation, contact and opportunity in one transaction", async () => {
    const { organisationId } = await createOrganisation({
      name: "Newtown Roasters",
      contact: { name: "Ada Vale", email: "ada@newtown.example" },
      opportunity: { product: "mark8ly", owner: "priya" },
    });
    const contacts = await db.query(
      `SELECT name, is_primary FROM crm_contacts WHERE organisation_id = $1`,
      [organisationId],
    );
    expect(contacts.rows).toHaveLength(1);
    // The first contact on a new organisation is its primary — otherwise
    // listOrganisations' "primary first, created_at second" ordering has
    // nothing to prefer and the detail view shows no lead contact.
    expect((contacts.rows[0] as { is_primary: boolean }).is_primary).toBe(true);
    const opps = await db.query(
      `SELECT stage, product FROM crm_opportunities WHERE organisation_id = $1`,
      [organisationId],
    );
    expect((opps.rows[0] as { stage: string }).stage).toBe("new");
  });

  // Task 4: `createOrganisation` must derive `country` the same way
  // `commitImport` does, using the shared `countryFromLocation` mapper —
  // otherwise a manually-added organisation and one created by import could
  // disagree about the same location.
  it("derives country on manual create", async () => {
    const { organisationId } = await createOrganisation({ name: "Manual Co", location: "Delhi" });
    const rows = await db.query(`SELECT location, country FROM crm_organisations WHERE id = $1`, [
      organisationId,
    ]);
    expect((rows.rows[0] as { location: string | null }).location).toBe("Delhi");
    expect((rows.rows[0] as { country: string | null }).country).toBe("IN");
  });

  it("leaves country null for a manual create with an unmappable location", async () => {
    const { organisationId } = await createOrganisation({
      name: "Unmappable Co",
      location: "Somewhere Else",
    });
    const rows = await db.query(`SELECT country FROM crm_organisations WHERE id = $1`, [
      organisationId,
    ]);
    expect((rows.rows[0] as { country: string | null }).country).toBeNull();
  });

  it("creates a second opportunity against an existing organisation", async () => {
    // The design's third motivating case: "a business lost in March that
    // returns in November is a new opportunity against the same
    // organisation, not a resurrection of the old row."
    const { organisationId } = await createOrganisation({ name: "Returning Co" });
    await createOpportunity({ organisationId, product: "mark8ly" });
    await createOpportunity({ organisationId, product: "kora" });
    const opps = await db.query(
      `SELECT product FROM crm_opportunities WHERE organisation_id = $1 ORDER BY product`,
      [organisationId],
    );
    expect(opps.rows.map((r) => (r as { product: string }).product)).toEqual(["kora", "mark8ly"]);
  });

  it("persists a null product, not a fabricated one, when the caller supplies none", async () => {
    // Global constraint on this whole feature: a null product at stage
    // 'new' is legal (crm_opp_product_required_when_qualified only bites
    // from 'qualified' on), and inventing one here would fabricate
    // attribution the funnel later reports as fact.
    const { organisationId } = await createOrganisation({ name: "No Product Yet" });
    const { opportunityId } = await createOpportunity({ organisationId });
    const rows = await db.query(`SELECT product FROM crm_opportunities WHERE id = $1`, [
      opportunityId,
    ]);
    expect((rows.rows[0] as { product: string | null }).product).toBeNull();
  });

  it("writes no activity row for a manual create", async () => {
    // Creating an opportunity is not a stage transition. Writing a
    // stage_change here would fabricate a transition into 'new' that never
    // happened, and stage_change activities are the only record of when a
    // stage was entered — the input to funnel measurement.
    const { organisationId } = await createOrganisation({
      name: "Quiet Co",
      opportunity: { product: "mark8ly" },
    });
    const acts = await db.query(`SELECT kind FROM crm_activities WHERE organisation_id = $1`, [
      organisationId,
    ]);
    expect(acts.rows).toHaveLength(0);
  });

  it("rejects an organisation with a blank name", async () => {
    // name is NOT NULL but "" satisfies that, and an unnamed organisation is
    // unfindable in a surface whose only affordance is search.
    await expect(createOrganisation({ name: "   " })).rejects.toThrow(/name/i);
  });

  it("rolls back the organisation when its contact violates the email unique index", async () => {
    await createOrganisation({ name: "First", contact: { email: "clash@example.com" } });
    await expect(
      createOrganisation({ name: "Second", contact: { email: "CLASH@example.com" } }),
    ).rejects.toThrow();
    const orgs = await db.query(`SELECT id FROM crm_organisations WHERE name = $1`, ["Second"]);
    // crm_contacts_email_lower_uq is case-insensitive; a partial write here
    // would leave an organisation with no contact and no way to tell why.
    expect(orgs.rows).toHaveLength(0);
  });

  // The guarantee has to hold at THIS layer, not only in
  // `organisations/new/actions.ts`: `createOrganisation` is exported, and a
  // future caller that forgets the action-layer check would put a
  // `javascript:` href back on the organisation detail page.
  it("rejects a javascript: website url when called directly", async () => {
    await expect(
      createOrganisation({ name: "Hostile Co", websiteUrl: "javascript:alert(1)" }),
    ).rejects.toThrow(/websiteUrl/);
    const orgs = await db.query(`SELECT id FROM crm_organisations WHERE name = $1`, ["Hostile Co"]);
    expect(orgs.rows).toHaveLength(0);
  });

  it("still accepts an ordinary https website url", async () => {
    const { organisationId } = await createOrganisation({
      name: "Safe Co",
      websiteUrl: "https://safe.example",
    });
    const rows = await db.query(`SELECT website_url FROM crm_organisations WHERE id = $1`, [
      organisationId,
    ]);
    expect((rows.rows[0] as { website_url: string }).website_url).toBe("https://safe.example");
  });
});

/**
 * Suppression on the MANUAL create paths.
 *
 * `commitImport` has checked per row since Task 8; neither manual door did,
 * so a person who asked not to be contacted could simply be re-added by
 * hand. design.md:224 requires the list to survive the next import — the
 * same reasoning makes it have to survive a typed-in row.
 */
describe("manual create honours the do-not-contact list", () => {
  it("refuses a new organisation whose first contact is suppressed, and writes nothing", async () => {
    await addSuppression({ email: "gone@example.com", reason: "asked", actor: "ops@tesserix.app" });

    await expect(
      createOrganisation({
        name: "Suppressed Lead",
        contact: { email: "GONE@example.com" },
      }),
    ).rejects.toBeInstanceOf(SuppressedContactError);

    const orgs = await db.query(`SELECT id FROM crm_organisations WHERE name = $1`, [
      "Suppressed Lead",
    ]);
    expect(orgs.rows).toHaveLength(0);
  });

  it("refuses a suppressed contact added to an existing organisation", async () => {
    await addSuppression({
      instagramHandle: "@quiet_shop",
      reason: "asked",
      actor: "ops@tesserix.app",
    });
    const { organisationId } = await createOrganisation({ name: "Existing Co" });

    await expect(
      createContact({ organisationId, instagramHandle: "quiet_shop" }),
    ).rejects.toBeInstanceOf(SuppressedContactError);

    const contacts = await db.query(`SELECT id FROM crm_contacts WHERE organisation_id = $1`, [
      organisationId,
    ]);
    expect(contacts.rows).toHaveLength(0);
  });

  it("still creates a contact whose keys are not on the list", async () => {
    const { organisationId } = await createOrganisation({ name: "Welcome Co" });
    const { contactId } = await createContact({ organisationId, email: "fine@example.com" });
    expect(contactId).toBeTruthy();
  });
});
