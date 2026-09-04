import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * #248 — every live write path records `source`, `sourced_at` and
 * `lawful_basis` on `crm_contacts`.
 *
 * Against a real (in-process) Postgres rather than an asserted SQL string,
 * because the claim is about what is IN THE ROW afterwards. The defect this
 * closes was not a wrong value; it was three columns no INSERT mentioned, and
 * a test that matched SQL text would have been written against the same
 * INSERT that omitted them. Reading the row back is the only assertion that
 * could have failed before the fix.
 *
 * Own pglite instance, per this directory's convention: a `vi.mock` in one
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
    tesserixTx: async (fn: Parameters<typeof actual.runTesserixTx>[1]) =>
      actual.runTesserixTx(dbHolder.db as Parameters<typeof actual.runTesserixTx>[0], fn),
    isDatabaseConfigured: () => true,
  };
});

const { createOrganisation, createContact, updateContact } = await import("./crm-writes");
const { commitImport, organisationDetail } = await import("./crm-repo");

let db: PGlite;

interface ProvenanceRow {
  source: string | null;
  sourced_at: Date | null;
  lawful_basis: string | null;
}

async function provenanceFor(organisationId: string): Promise<ProvenanceRow[]> {
  const result = await db.query<ProvenanceRow>(
    `SELECT source, sourced_at, lawful_basis
       FROM crm_contacts
      WHERE organisation_id = $1
      ORDER BY created_at`,
    [organisationId],
  );
  return result.rows;
}

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;

  // The migrations the writes under test touch. Listed one by one, as every
  // other integration suite here does — #301 found a suite silently not
  // applying `0024` and reporting green.
  for (const migration of [
    "0019_crm_schema.sql",
    "0022_crm_suppressions_normalize.sql",
    "0023_crm_contacts_instagram_unique.sql",
    "0024_crm_contacts_erased_at.sql",
    "0025_crm_organisations_country.sql",
    "0027_crm_contacts_metadata.sql",
    // The erasure register `commitImport` checks every row against (#226).
    "0041_crm_erased_identifiers.sql",
  ]) {
    const migrationPath = path.resolve(__dirname, "../../../web/db/migrations", migration);
    await db.exec(readFileSync(migrationPath, "utf-8"));
  }
});

afterAll(async () => {
  await db.close();
});

describe("commitImport records the batch's provenance on every contact it creates", () => {
  it("stamps source, sourced_at and the declared lawful basis", async () => {
    const before = new Date();
    const result = await commitImport(
      [
        { name: "Bondi Baker", email: "bondi@example.com" },
        { name: "Newtown Roasters", instagramHandle: "@newtownroasters" },
      ],
      "op@tesserix.app",
      "legitimate_interests",
      "leads.csv",
    );
    expect(result.created).toBe(2);

    const rows = await db.query<ProvenanceRow>(
      `SELECT source, sourced_at, lawful_basis FROM crm_contacts`,
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      // The path, not the batch id: `crm_organisations.import_id` already
      // records which import produced the row.
      expect(row.source).toBe("import");
      expect(row.lawful_basis).toBe("legitimate_interests");
      expect(row.sourced_at).not.toBeNull();
      expect(row.sourced_at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    }
  });

  it("carries the basis the OPERATOR declared, not a default the code chose", async () => {
    // The whole point of a per-batch declaration: a CSV of people who filled
    // in a form is not held on the same basis as a scrape.
    await commitImport(
      [{ name: "Opted In", email: "opted@example.com" }],
      "op@tesserix.app",
      "consent",
    );
    const rows = await db.query<ProvenanceRow>(
      `SELECT source, sourced_at, lawful_basis FROM crm_contacts WHERE email = $1`,
      ["opted@example.com"],
    );
    expect(rows.rows[0].lawful_basis).toBe("consent");
  });

  it("refuses a basis outside the set before writing anything", async () => {
    await expect(
      commitImport(
        [{ name: "Nope", email: "nope@example.com" }],
        "op@tesserix.app",
        "whatever we like" as never,
      ),
    ).rejects.toThrow(/not a selectable lawful basis/);

    const rows = await db.query(`SELECT id FROM crm_contacts WHERE email = $1`, [
      "nope@example.com",
    ]);
    expect(rows.rows).toHaveLength(0);
  });

  it("refuses the legacy marker, which is storable but never choosable", async () => {
    await expect(
      commitImport(
        [{ name: "Legacy", email: "legacy@example.com" }],
        "op@tesserix.app",
        "not_recorded_pre_migration" as never,
      ),
    ).rejects.toThrow(/not a selectable lawful basis/);
  });
});

describe("the manual-create door records provenance", () => {
  it("stamps a contact created alongside a new organisation", async () => {
    const { organisationId } = await createOrganisation({
      name: "Hand Typed Co",
      contact: { name: "Ava", email: "ava@handtyped.example", lawfulBasis: "contract" },
    });

    const [row] = await provenanceFor(organisationId);
    // `manual`, even though the organisation may later gain imported
    // siblings: this contact was typed, and `source` is the path.
    expect(row.source).toBe("manual");
    expect(row.lawful_basis).toBe("contract");
    expect(row.sourced_at).not.toBeNull();
  });

  it("stamps a contact added to an existing organisation", async () => {
    const { organisationId } = await createOrganisation({ name: "Second Contact Co" });
    await createContact({
      organisationId,
      name: "Bo",
      email: "bo@second.example",
      source: "manual",
      lawfulBasis: "consent",
    });

    const [row] = await provenanceFor(organisationId);
    expect(row.source).toBe("manual");
    expect(row.lawful_basis).toBe("consent");
    expect(row.sourced_at).not.toBeNull();
  });

  it("refuses an unknown basis at the data layer, not only at the action above it", async () => {
    const { organisationId } = await createOrganisation({ name: "Refusal Co" });
    await expect(
      createContact({
        organisationId,
        email: "refused@example.com",
        source: "manual",
        lawfulBasis: "vibes" as never,
      }),
    ).rejects.toThrow(/not a selectable lawful basis/);
    expect(await provenanceFor(organisationId)).toHaveLength(0);
  });
});

describe("correcting a lawful basis (#247's edit surface)", () => {
  it("changes the basis and logs the correction, leaving source and sourced_at alone", async () => {
    const { organisationId } = await createOrganisation({
      name: "Corrected Co",
      contact: { name: "Cy", email: "cy@corrected.example", lawfulBasis: "legitimate_interests" },
    });
    const [contact] = (
      await db.query<{ id: string }>(`SELECT id FROM crm_contacts WHERE organisation_id = $1`, [
        organisationId,
      ])
    ).rows;
    const [before] = await provenanceFor(organisationId);

    const { changed } = await updateContact({
      contactId: contact.id,
      actor: "op@tesserix.app",
      name: "Cy",
      email: "cy@corrected.example",
      lawfulBasis: "consent",
    });

    expect(changed).toContainEqual({
      field: "lawfulBasis",
      from: "legitimate_interests",
      to: "consent",
    });
    const [after] = await provenanceFor(organisationId);
    expect(after.lawful_basis).toBe("consent");
    // A correction is not a re-acquisition.
    expect(after.source).toBe(before.source);
    expect(after.sourced_at!.getTime()).toBe(before.sourced_at!.getTime());
  });

  it("leaves a migrated contact's legacy marker intact when the edit omits a basis", async () => {
    // The 259 rows in production. Their basis is storable but not selectable,
    // so an edit form that had to resubmit it could never save — omitting the
    // field must therefore mean "leave it", not "clear it".
    const { organisationId } = await createOrganisation({ name: "Migrated Co" });
    const [{ id: contactId }] = (
      await db.query<{ id: string }>(
        `INSERT INTO crm_contacts (organisation_id, name, email, source, sourced_at, lawful_basis)
         VALUES ($1, 'Old Row', 'old@migrated.example', 'instagram_outreach', now(), 'not_recorded_pre_migration')
         RETURNING id`,
        [organisationId],
      )
    ).rows;

    const { changed } = await updateContact({
      contactId,
      actor: "op@tesserix.app",
      name: "Old Row Renamed",
      email: "old@migrated.example",
    });

    expect(changed.map((c) => c.field)).toEqual(["name"]);
    const [row] = await provenanceFor(organisationId);
    expect(row.lawful_basis).toBe("not_recorded_pre_migration");
    expect(row.source).toBe("instagram_outreach");
  });

  it("refuses a correction to the legacy marker", async () => {
    const { organisationId } = await createOrganisation({
      name: "No Going Back Co",
      contact: { email: "back@example.com", lawfulBasis: "consent" },
    });
    const [{ id: contactId }] = (
      await db.query<{ id: string }>(`SELECT id FROM crm_contacts WHERE organisation_id = $1`, [
        organisationId,
      ])
    ).rows;

    await expect(
      updateContact({
        contactId,
        actor: "op@tesserix.app",
        email: "back@example.com",
        lawfulBasis: "not_recorded_pre_migration" as never,
      }),
    ).rejects.toThrow(/not a selectable lawful basis/);
    const [row] = await provenanceFor(organisationId);
    expect(row.lawful_basis).toBe("consent");
  });
});

describe("organisationDetail reads provenance back", () => {
  it("returns source, sourcedAt and lawfulBasis for each contact", async () => {
    // Before #248 nothing selected these columns at all, so an operator
    // answering a subject-access request needed database access.
    const { organisationId } = await createOrganisation({
      name: "Readable Co",
      contact: { name: "Dee", email: "dee@readable.example", lawfulBasis: "legitimate_interests" },
    });

    const detail = await organisationDetail(organisationId);
    expect(detail).not.toBeNull();
    const [contact] = detail!.contacts;
    expect(contact.source).toBe("manual");
    expect(contact.lawfulBasis).toBe("legitimate_interests");
    expect(contact.sourcedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
