import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The whole of #226 in one file: an erased contact must not be re-created by
 * the next import.
 *
 * Integration, against real (in-process) Postgres via pglite, and it could
 * not be anything else. The bug was never in one function — it was in the
 * SEAM between two of them. `eraseContact` correctly nulled `email` and
 * `instagram_handle`; `findMatchingOrganisationId` correctly matched on those
 * two columns; and the correct behaviour of each was exactly what made the
 * pair re-create the person. A unit test of either half passes in both the
 * broken and the fixed world.
 *
 * The load-bearing property of every test below is NEGATIVE — no
 * organisation was created — and negatives are what silently stop holding.
 * If the `isErased` check is deleted from `crm-repo.ts`, the first two tests
 * here must fail. That is the bar; a test that only asserts a counter would
 * clear it, so each one also counts `crm_organisations`.
 *
 * Own pglite instance — see `crm-writes.integration.test.ts` for why a
 * `vi.mock` in one test file cannot be shared with another.
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
    // pglite is a single embedded session and IS a client, structurally:
    // `runTesserixTx` only ever calls `.query(sql, params)` on what it is
    // given. Delegating to the real `runTesserixTx` is what makes the
    // erasure's BEGIN/COMMIT/ROLLBACK the one that ships.
    tesserixTx: async (fn: Parameters<typeof actual.runTesserixTx>[1]) =>
      actual.runTesserixTx(dbHolder.db as Parameters<typeof actual.runTesserixTx>[0], fn),
    isDatabaseConfigured: () => true,
  };
});

const { eraseContact } = await import("./crm-erasure");
const { ErasureCheckUnavailableError, commitImport, previewImport } = await import("./crm-repo");
const { ERASURE_HASH_KEY_ENV } = await import("./crm-erasure-hash");

const KEY = "integration-erasure-key";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;

  for (const migration of [
    "0019_crm_schema.sql",
    "0022_crm_suppressions_normalize.sql",
    // 0023's trigger keeps `crm_contacts.instagram_handle` in the canonical
    // form the hash is computed over. Loaded because a fixture built against
    // a table missing a live trigger stops being a fixture for the real one.
    "0023_crm_contacts_instagram_unique.sql",
    "0024_crm_contacts_erased_at.sql",
    "0025_crm_organisations_country.sql",
    "0027_crm_contacts_metadata.sql",
    // The register itself.
    "0041_crm_erased_identifiers.sql",
  ]) {
    const migrationPath = path.resolve(__dirname, "../../../web/db/migrations", migration);
    await db.exec(readFileSync(migrationPath, "utf-8"));
  }
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv(ERASURE_HASH_KEY_ENV, KEY);
  await db.query(`TRUNCATE crm_organisations CASCADE`);
  await db.query(`TRUNCATE crm_erased_identifiers`);
  await db.query(`TRUNCATE crm_suppressions`);
  await db.query(`TRUNCATE crm_imports CASCADE`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Seeds one organisation with one contact and returns the contact id — the
 *  starting state for every erasure below. */
async function seedContact(
  organisationName: string,
  contact: { name?: string; email?: string | null; instagramHandle?: string | null },
): Promise<{ organisationId: string; contactId: string }> {
  const orgRows = await db.query(
    `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
    [organisationName],
  );
  const organisationId = (orgRows.rows[0] as { id: string }).id;
  const contactRows = await db.query(
    `INSERT INTO crm_contacts (organisation_id, name, email, instagram_handle, is_primary)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [organisationId, contact.name ?? "Ava Reid", contact.email ?? null, contact.instagramHandle ?? null],
  );
  return { organisationId, contactId: (contactRows.rows[0] as { id: string }).id };
}

async function organisationCount(): Promise<number> {
  const rows = await db.query(`SELECT count(*)::int AS n FROM crm_organisations`);
  return (rows.rows[0] as { n: number }).n;
}

async function opportunityCount(): Promise<number> {
  const rows = await db.query(`SELECT count(*)::int AS n FROM crm_opportunities`);
  return (rows.rows[0] as { n: number }).n;
}

async function registerCount(): Promise<number> {
  const rows = await db.query(`SELECT count(*)::int AS n FROM crm_erased_identifiers`);
  return (rows.rows[0] as { n: number }).n;
}

describe("an erased contact survives the next import", () => {
  it("refuses a re-import of the erased email and creates nothing", async () => {
    const { contactId } = await seedContact("Glebe Flowers", { email: "ava@example.com" });
    await eraseContact(contactId);
    // The erasure itself removed nothing; the organisation and its contact
    // row are still there, which is exactly why the import used to sail past
    // them (the contact no longer carries the email to match on).
    expect(await organisationCount()).toBe(1);

    const result = await commitImport([{ name: "Ava Reid", email: "ava@example.com" }], "op@example.com");

    expect(result.skippedErased).toBe(1);
    // The claim that matters. A counter alone would pass in a world where
    // the row was both counted AND created.
    expect(result.created).toBe(0);
    expect(await organisationCount()).toBe(1);
    expect(await opportunityCount()).toBe(0);
  });

  it("refuses a re-import carrying only the Instagram handle", async () => {
    const { contactId } = await seedContact("Bondi Baker", {
      email: "sam@example.com",
      instagramHandle: "bondibaker",
    });
    await eraseContact(contactId);

    // The next scrape captured the handle and no email at all — the reason
    // the two identifiers are hashed separately rather than as a pair.
    const result = await commitImport([{ name: "Sam", instagramHandle: "@BondiBaker" }], "op@example.com");

    expect(result.skippedErased).toBe(1);
    expect(result.created).toBe(0);
    expect(await organisationCount()).toBe(1);
  });

  it("matches across the normalisation the import and the erasure each apply", async () => {
    // Recorded from a contact row holding a messy value, re-imported from a
    // clean one. This is the same property `crm-erasure-hash.test.ts` pins in
    // isolation, asserted here through the real database round trip — a
    // disagreement between the two sides is invisible at every other layer.
    const { contactId } = await seedContact("Paper Press", { email: " Foo@Example.COM " });
    await eraseContact(contactId);

    const result = await commitImport([{ email: "foo@example.com" }], "op@example.com");

    expect(result.skippedErased).toBe(1);
    expect(result.created).toBe(0);
  });

  it("does not block a different person at the same organisation", async () => {
    // Erasure is a fact about a PERSON. If it became a fact about their
    // employer, one request would quietly delete a business relationship —
    // the over-correction that would be far harder to notice than the bug.
    const { contactId } = await seedContact("Glebe Flowers", { email: "ava@example.com" });
    await eraseContact(contactId);

    const result = await commitImport(
      [{ name: "Noor at Glebe Flowers", email: "noor@example.com" }],
      "op@example.com",
    );

    expect(result.skippedErased).toBe(0);
    expect(result.created).toBe(1);
    expect(await organisationCount()).toBe(2);
  });

  it("counts an erased row separately from a suppressed one", async () => {
    // Two different requests with two different remedies. Merged into one
    // counter, the import card would tell an operator to "remove the
    // suppression" for someone who asked to be forgotten — wrong advice they
    // are able to act on.
    const { contactId } = await seedContact("Glebe Flowers", { email: "ava@example.com" });
    await eraseContact(contactId);
    await db.query(
      `INSERT INTO crm_suppressions (email, reason, created_by) VALUES ($1, $2, $3)`,
      ["noor@example.com", "asked not to be contacted", "op@example.com"],
    );

    const result = await commitImport(
      [{ email: "ava@example.com" }, { email: "noor@example.com" }],
      "op@example.com",
    );

    expect(result.skippedErased).toBe(1);
    expect(result.skippedSuppressed).toBe(1);
    expect(result.created).toBe(0);
  });

  it("counts someone on BOTH lists as erased, not suppressed", async () => {
    // The order of the two checks decides which remedy the operator is
    // shown. Pinned so a later edit cannot reorder them without noticing.
    const { contactId } = await seedContact("Glebe Flowers", { email: "ava@example.com" });
    await eraseContact(contactId);
    await db.query(
      `INSERT INTO crm_suppressions (email, reason, created_by) VALUES ($1, $2, $3)`,
      ["ava@example.com", "also asked not to be contacted", "op@example.com"],
    );

    const result = await commitImport([{ email: "ava@example.com" }], "op@example.com");

    expect(result.skippedErased).toBe(1);
    expect(result.skippedSuppressed).toBe(0);
  });

  it("reports the same skippedErased count at preview and at commit", async () => {
    // The trap `counts.ts` documents: a preview that disagrees with the
    // commit about what was left on the floor, for the same file.
    const { contactId } = await seedContact("Glebe Flowers", { email: "ava@example.com" });
    await eraseContact(contactId);
    const file = [
      { email: "ava@example.com" },
      { email: "noor@example.com" },
      { name: "no identifiers" },
    ];

    const preview = await previewImport(file);
    const committed = await commitImport(file, "op@example.com");

    expect(preview.skippedErased).toBe(1);
    expect(committed.skippedErased).toBe(preview.skippedErased);
    expect(committed.created).toBe(preview.toCreate);
  });

  it("leaves the register untouched by a preview", async () => {
    const { contactId } = await seedContact("Glebe Flowers", { email: "ava@example.com" });
    await eraseContact(contactId);

    await previewImport([{ email: "ava@example.com" }]);

    expect(await organisationCount()).toBe(1);
    expect(await registerCount()).toBe(1);
  });
});

describe("recording the erasure", () => {
  it("records one hash per identifier the contact carried", async () => {
    const { contactId } = await seedContact("Bondi Baker", {
      email: "sam@example.com",
      instagramHandle: "bondibaker",
    });
    await eraseContact(contactId);
    expect(await registerCount()).toBe(2);
  });

  it("records nothing that names the person or their organisation", async () => {
    // Migration 0041's reason for having no foreign key: the erased contact
    // row still exists, named `[erased]`, under a named business. A hash tied
    // to it would be a re-identification path.
    const { contactId } = await seedContact("Glebe Flowers", { email: "ava@example.com" });
    await eraseContact(contactId);

    const rows = await db.query(`SELECT * FROM crm_erased_identifiers`);
    const columns = Object.keys(rows.rows[0] as Record<string, unknown>).sort();
    expect(columns).toEqual(["erased_at", "identifier_hash"]);
    expect(JSON.stringify(rows.rows)).not.toContain("ava@example.com");
    expect(JSON.stringify(rows.rows)).not.toContain("Glebe Flowers");
  });

  it("is idempotent — a second erasure adds no row", async () => {
    const { contactId } = await seedContact("Bondi Baker", {
      email: "sam@example.com",
      instagramHandle: "bondibaker",
    });
    await eraseContact(contactId);
    const afterFirst = await registerCount();

    // The second call finds the columns already null, so it has nothing to
    // hash; `ON CONFLICT DO NOTHING` covers the case where it did.
    const second = await eraseContact(contactId);
    expect(second?.erasedAt).not.toBeNull();
    expect(await registerCount()).toBe(afterFirst);
  });

  it("records nothing for a contact that carried neither identifier", async () => {
    const { contactId } = await seedContact("Paper Press", { name: "Walk-in" });
    await eraseContact(contactId);
    expect(await registerCount()).toBe(0);
  });
});

describe("without CRM_ERASURE_HASH_KEY", () => {
  it("refuses the erasure and changes nothing", async () => {
    const { contactId } = await seedContact("Glebe Flowers", { email: "ava@example.com" });
    vi.stubEnv(ERASURE_HASH_KEY_ENV, "");

    await expect(eraseContact(contactId)).rejects.toThrow(/CRM_ERASURE_HASH_KEY/);

    // Fail CLOSED: an erasure reported as done but unrecorded would silently
    // lose the ability to enforce itself, and nobody would look at it again.
    const rows = await db.query(`SELECT name, email, erased_at FROM crm_contacts WHERE id = $1`, [
      contactId,
    ]);
    expect(rows.rows[0]).toMatchObject({ name: "Ava Reid", email: "ava@example.com", erased_at: null });
    expect(await registerCount()).toBe(0);
  });

  it("still imports normally while the register is empty", async () => {
    // The self-consistency: with no key nothing can have been erased, so
    // there is nothing an import could have missed, and refusing it would be
    // an outage for no benefit.
    vi.stubEnv(ERASURE_HASH_KEY_ENV, "");

    const result = await commitImport([{ email: "noor@example.com" }], "op@example.com");

    expect(result.created).toBe(1);
    expect(result.skippedErased).toBe(0);
  });

  it("refuses the import outright once anything HAS been erased", async () => {
    const { contactId } = await seedContact("Glebe Flowers", { email: "ava@example.com" });
    await eraseContact(contactId);
    // The key is then lost — unset in the chart, rotated away, a bad deploy.
    vi.stubEnv(ERASURE_HASH_KEY_ENV, "");

    await expect(previewImport([{ email: "ava@example.com" }])).rejects.toThrow(
      ErasureCheckUnavailableError,
    );
    await expect(commitImport([{ email: "ava@example.com" }], "op@example.com")).rejects.toThrow(
      ErasureCheckUnavailableError,
    );

    // Not a partial import and not a silent pass: nothing was written, and
    // in particular nobody was re-created while `skippedErased: 0` claimed
    // the register had been checked.
    expect(await organisationCount()).toBe(1);
    const imports = await db.query(`SELECT count(*)::int AS n FROM crm_imports`);
    expect((imports.rows[0] as { n: number }).n).toBe(0);
  });
});
