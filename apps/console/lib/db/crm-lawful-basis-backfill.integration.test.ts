import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for the #248 backfill, against a real engine.
 *
 * The unit tests pin the SQL the backfill issues; what cannot be asserted
 * from mocked query text is whether those statements do the right thing to
 * actual rows — and the two claims worth proving here are both claims about
 * what the backfill DOES NOT touch:
 *
 *   1. the identifying columns survive it, and
 *   2. an unrelated contact edit does not wipe the follower count.
 *
 * Both are the destructive-by-omission failures `setLawfulBasis` and
 * `UpdateContactInput.followersCount` were shaped to make impossible. A
 * mocked test can only say the SQL text looked right; this one says 259
 * Instagram handles are still there afterwards.
 *
 * Own pglite instance, per `crm-writes.integration.test.ts`'s note.
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
const { backfillLawfulBasis } = await import("./crm-lawful-basis-backfill");

let db: PGlite;

const MIGRATIONS = [
  "0019_crm_schema.sql",
  "0022_crm_suppressions_normalize.sql",
  "0023_crm_contacts_instagram_unique.sql",
  "0024_crm_contacts_erased_at.sql",
  "0025_crm_organisations_country.sql",
  "0027_crm_contacts_metadata.sql",
];

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;
  for (const file of MIGRATIONS) {
    const migration = path.resolve(__dirname, "../../../web/db/migrations", file);
    await db.exec(readFileSync(migration, "utf-8"));
  }
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`DELETE FROM crm_activities; DELETE FROM crm_contacts; DELETE FROM crm_organisations;`);
});

/**
 * A contact in the state migration 0027 left the 259 production rows in:
 * real identifying details, and `not_recorded_pre_migration` in the basis.
 * Written with a direct UPDATE because `createContact` REFUSES the legacy
 * marker — which is the guarantee that stops any live path recreating this
 * state, and is why a fixture has to reach past it.
 */
async function migratedContact(fields: {
  name: string;
  handle: string;
  followers?: number;
}): Promise<{ organisationId: string; contactId: string }> {
  const { organisationId } = await createOrganisation({ name: fields.name });
  const { contactId } = await createContact({
    organisationId,
    name: fields.name,
    instagramHandle: fields.handle,
    followersCount: fields.followers,
    isPrimary: true,
    source: "import",
    lawfulBasis: "legitimate_interests",
  });
  await db.query(`UPDATE crm_contacts SET lawful_basis = $2 WHERE id = $1`, [
    contactId,
    "not_recorded_pre_migration",
  ]);
  return { organisationId, contactId };
}

async function readContact(contactId: string) {
  const { rows } = await db.query<{
    name: string | null;
    instagram_handle: string | null;
    lawful_basis: string | null;
    followers_count: number | null;
  }>(
    `SELECT name, instagram_handle, lawful_basis, followers_count
       FROM crm_contacts WHERE id = $1`,
    [contactId],
  );
  return rows[0];
}

describe("backfillLawfulBasis against a real database", () => {
  it("records the basis and leaves every identifying column intact", async () => {
    const { contactId } = await migratedContact({
      name: "Urbanazhagi",
      handle: "urbanazhagi.store",
      followers: 1200,
    });

    const result = await backfillLawfulBasis({
      basis: "legitimate_interests",
      actor: "ops@tesserix.app",
      dryRun: false,
    });

    expect(result).toEqual({ candidates: 1, changed: 1, failures: [] });

    // THE CLAIM. A loop that had gone through `updateContact` with only a
    // basis would have nulled all three of these.
    const row = await readContact(contactId);
    expect(row.lawful_basis).toBe("legitimate_interests");
    expect(row.name).toBe("Urbanazhagi");
    expect(row.instagram_handle).toBe("urbanazhagi.store");
    expect(row.followers_count).toBe(1200);
  });

  it("leaves an already-decided basis alone", async () => {
    const { organisationId } = await createOrganisation({ name: "Decided" });
    const { contactId } = await createContact({
      organisationId,
      name: "Decided",
      instagramHandle: "decided",
      isPrimary: true,
      source: "manual",
      lawfulBasis: "consent",
    });

    const result = await backfillLawfulBasis({
      basis: "legitimate_interests",
      actor: "ops@tesserix.app",
      dryRun: false,
    });

    expect(result.candidates).toBe(0);
    expect((await readContact(contactId)).lawful_basis).toBe("consent");
  });

  // Recording a fresh justification for holding the details of someone who
  // asked to be forgotten would assert exactly what the erasure destroyed.
  it("never touches an erased contact", async () => {
    const { contactId } = await migratedContact({ name: "Gone", handle: "gone" });
    await db.query(`UPDATE crm_contacts SET erased_at = now() WHERE id = $1`, [contactId]);

    const result = await backfillLawfulBasis({
      basis: "legitimate_interests",
      actor: "ops@tesserix.app",
      dryRun: false,
    });

    expect(result.candidates).toBe(0);
    expect((await readContact(contactId)).lawful_basis).toBe("not_recorded_pre_migration");
  });

  it("writes an auditable timeline row naming the actor", async () => {
    const { organisationId } = await migratedContact({ name: "Audited", handle: "audited" });

    await backfillLawfulBasis({
      basis: "legitimate_interests",
      actor: "mahesh@tesserix.app",
      dryRun: false,
    });

    const { rows } = await db.query<{ actor: string; body: string; metadata: unknown }>(
      `SELECT actor, body, metadata FROM crm_activities WHERE organisation_id = $1`,
      [organisationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("mahesh@tesserix.app");
    expect(rows[0].body).toBe("Edited lawfulBasis");
    expect(rows[0].metadata).toEqual({
      lawfulBasis: { from: "not_recorded_pre_migration", to: "legitimate_interests" },
    });
  });

  it("changes nothing on a dry run", async () => {
    const { contactId } = await migratedContact({ name: "Rehearsal", handle: "rehearsal" });

    const result = await backfillLawfulBasis({
      basis: "legitimate_interests",
      actor: "ops@tesserix.app",
      dryRun: true,
    });

    expect(result).toEqual({ candidates: 1, changed: 0, failures: [] });
    expect((await readContact(contactId)).lawful_basis).toBe("not_recorded_pre_migration");
  });

  it("is a no-op when run a second time", async () => {
    await migratedContact({ name: "Twice", handle: "twice" });
    const options = {
      basis: "legitimate_interests",
      actor: "ops@tesserix.app",
      dryRun: false,
    } as const;

    await backfillLawfulBasis(options);
    const second = await backfillLawfulBasis(options);

    expect(second).toEqual({ candidates: 0, changed: 0, failures: [] });
  });
});

describe("the follower count column, against a real database", () => {
  // The regression the `followersCount` semantics exist to prevent, proven
  // on rows rather than on SQL text: the console's contact form submits the
  // four identifying fields and no count.
  it("survives a contact edit that supplies no count", async () => {
    const { organisationId } = await createOrganisation({ name: "Kiss My Hide" });
    const { contactId } = await createContact({
      organisationId,
      name: "Kiss My Hide",
      instagramHandle: "kissmyhideaustralia",
      followersCount: 1900,
      isPrimary: true,
      source: "import",
      lawfulBasis: "legitimate_interests",
    });

    await updateContact({
      contactId,
      actor: "ops@tesserix.app",
      name: "Kiss My Hide Australia",
      instagramHandle: "kissmyhideaustralia",
    });

    const row = await readContact(contactId);
    expect(row.name).toBe("Kiss My Hide Australia");
    expect(row.followers_count).toBe(1900);
  });

  it("is updated by a refresh and recorded on the timeline", async () => {
    const { organisationId } = await createOrganisation({ name: "lilknot" });
    const { contactId } = await createContact({
      organisationId,
      name: "lilknot",
      instagramHandle: "lilknot_crochet",
      followersCount: 45,
      isPrimary: true,
      source: "import",
      lawfulBasis: "legitimate_interests",
    });

    const { changed } = await updateContact({
      contactId,
      actor: "ops@tesserix.app",
      name: "lilknot",
      instagramHandle: "lilknot_crochet",
      followersCount: 102,
    });

    expect(changed).toEqual([{ field: "followersCount", from: "45", to: "102" }]);
    expect((await readContact(contactId)).followers_count).toBe(102);
  });
});
