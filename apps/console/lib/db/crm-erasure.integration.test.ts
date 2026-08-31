import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for the two DPDP data operations: `eraseContact` and
 * `deleteOrganisation`. Real (in-process) Postgres via pglite, not a mocked
 * query shape — the partial unique index on `crm_contacts_email_lower_uq`
 * and the `ON DELETE CASCADE` chain can only be proven against actual
 * constraint enforcement, not asserted SQL text.
 *
 * Own pglite instance — see crm-writes.integration.test.ts for why a
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
    // pglite is a single embedded session with no separate pool to acquire a
    // client from — so it IS a client, structurally: `runTesserixTx` only
    // ever calls `.query(sql, params)` on whatever it's given. Delegating to
    // the real `runTesserixTx` is what makes these tests exercise the actual
    // BEGIN/COMMIT/ROLLBACK logic that ships.
    tesserixTx: async (fn: Parameters<typeof actual.runTesserixTx>[1]) =>
      actual.runTesserixTx(dbHolder.db as Parameters<typeof actual.runTesserixTx>[0], fn),
    isDatabaseConfigured: () => true,
  };
});

const { eraseContact, deleteOrganisation } = await import("./crm-erasure");
const { ERASURE_HASH_KEY_ENV } = await import("./crm-erasure-hash");

let db: PGlite;
let orgId: string;
let contactId: string;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;

  for (const migration of [
    "0019_crm_schema.sql",
    "0022_crm_suppressions_normalize.sql",
    "0024_crm_contacts_erased_at.sql",
    // 0027 adds `crm_contacts.metadata`, the raw-scrape bag. Loaded here
    // because the erasure claim below is a claim about a real column.
    "0027_crm_contacts_metadata.sql",
    // 0041 is the erasure register (#226). Loaded because `eraseContact` now
    // writes to it inside its own transaction: without the table every test
    // below fails on the INSERT rather than on the claim it is making.
    "0041_crm_erased_identifiers.sql",
  ]) {
    const migrationPath = path.resolve(__dirname, "../../../web/db/migrations", migration);
    await db.exec(readFileSync(migrationPath, "utf-8"));
  }
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Seeded per-test, not once for the suite: several tests here delete their
// fixtures, which would break a `beforeAll`-seeded org for the next test.
beforeEach(async () => {
  // `eraseContact` fails closed without this (#226): an erasure it cannot
  // record in a form the next import can refuse must not report success. The
  // refusal itself is covered in `crm-erasure-import.integration.test.ts`;
  // here it would just mask every other claim.
  vi.stubEnv(ERASURE_HASH_KEY_ENV, "integration-erasure-key");

  // Every test reuses the same fixture email, so previous tests' rows must
  // be gone first — TRUNCATE ... CASCADE clears organisations and, via
  // ON DELETE CASCADE, their contacts/opportunities/activities too.
  await db.query(`TRUNCATE crm_organisations CASCADE`);

  const orgRows = await db.query(`INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`, [
    "Glebe Flowers",
  ]);
  orgId = (orgRows.rows[0] as { id: string }).id;

  const contactRows = await db.query(
    `INSERT INTO crm_contacts
       (organisation_id, name, email, phone, instagram_handle, biography,
        followers_count, posts_count, metadata, source, sourced_at, lawful_basis)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now(), $11)
     RETURNING id`,
    [
      orgId,
      "Priya Raman",
      "priya@glebeflowers.example",
      "0400000000",
      "priyaraman",
      "Florist and owner",
      1200,
      340,
      // Several keys, none of which the erasure code names. That is the
      // point: the bag is unenumerated by design.
      JSON.stringify({
        full_name: "Priya Raman",
        profile_pic_url: "https://cdn.example/priya.jpg",
        external_url: "https://glebeflowers.example",
        business_email: "priya@glebeflowers.example",
        is_verified: false,
      }),
      "instagram_scrape",
      "legitimate_interest",
    ],
  );
  contactId = (contactRows.rows[0] as { id: string }).id;

  await db.query(
    `INSERT INTO crm_opportunities (organisation_id, product) VALUES ($1, $2)`,
    [orgId, "mark8ly"],
  );

  await db.query(
    `INSERT INTO crm_activities (organisation_id, kind, actor, body)
     VALUES ($1, $2, $3, $4)`,
    [orgId, "note", "system", "Imported from Instagram scrape"],
  );
});

describe("eraseContact", () => {
  it("overwrites every personal column and keeps the row", async () => {
    const result = await eraseContact(contactId);
    expect(result?.previousName).toBe("Priya Raman");
    // `erasedAt` is the PRE-image value — null here means this call is the
    // one that erased the contact, not a repeat.
    expect(result?.erasedAt).toBeNull();
    const rows = await db.query(
      `SELECT name, email, phone, instagram_handle, biography,
              followers_count, posts_count, erased_at
         FROM crm_contacts WHERE id = $1`,
      [contactId],
    );
    const row = rows.rows[0] as Record<string, unknown>;
    expect(rows.rows).toHaveLength(1);
    expect(row.name).toBe("[erased]");
    expect(row.email).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.instagram_handle).toBeNull();
    expect(row.biography).toBeNull();
    // Follower and post counts are personal data too — they describe the
    // person's account, and #154 names them explicitly as what we hold.
    expect(row.followers_count).toBeNull();
    expect(row.posts_count).toBeNull();
    expect(row.erased_at).not.toBeNull();
  });

  /**
   * THE DPDP GUARD for the raw-scrape bag (#235).
   *
   * `metadata` is the one column on this table whose contents nobody has
   * enumerated — its whole purpose is retaining scrape output as it came.
   * So the assertion is about the WHOLE OBJECT, not about any named key: a
   * test that checked `metadata.full_name` would pass while every other
   * key the next scrape adds survived an erasure request.
   *
   * Cleared in the SAME statement that nulls the other personal columns, not
   * by a follow-up write — a second statement is a second thing that can
   * fail, be skipped by a future caller, or be reordered out of the
   * transaction, and personal data surviving an erasure is not a failure
   * mode worth leaving reachable.
   */
  it("leaves NO key in the raw-scrape metadata bag", async () => {
    const before = await db.query(`SELECT metadata FROM crm_contacts WHERE id = $1`, [contactId]);
    // Guards the guard: an empty bag before the erasure would make the
    // assertion below pass for the wrong reason.
    expect(Object.keys((before.rows[0] as { metadata: object }).metadata).length).toBeGreaterThan(0);

    await eraseContact(contactId);

    const after = await db.query(`SELECT metadata FROM crm_contacts WHERE id = $1`, [contactId]);
    const metadata = (after.rows[0] as { metadata: Record<string, unknown> }).metadata;
    expect(metadata).toEqual({});
    expect(Object.keys(metadata)).toEqual([]);
  });

  it("leaves the organisation, its opportunities and its activities intact", async () => {
    await eraseContact(contactId);
    const opps = await db.query(`SELECT id FROM crm_opportunities WHERE organisation_id = $1`, [
      orgId,
    ]);
    const acts = await db.query(`SELECT id FROM crm_activities WHERE organisation_id = $1`, [
      orgId,
    ]);
    // The whole reason erasure redacts rather than deletes: stage_change
    // activities are the only record of when a stage was entered.
    expect(opps.rows.length).toBeGreaterThan(0);
    expect(acts.rows.length).toBeGreaterThan(0);
  });

  it("frees the email for reuse without resurrecting the person", async () => {
    // crm_contacts_email_lower_uq is partial (WHERE email IS NOT NULL), so
    // nulling the column releases the address rather than leaving a
    // tombstone that blocks a legitimate future contact at the same
    // business.
    await eraseContact(contactId);
    await db.query(`INSERT INTO crm_contacts (organisation_id, name, email) VALUES ($1, $2, $3)`, [
      orgId,
      "Someone Else",
      "priya@glebeflowers.example",
    ]);
    const rows = await db.query(
      `SELECT count(*)::int AS n FROM crm_contacts WHERE organisation_id = $1`,
      [orgId],
    );
    expect((rows.rows[0] as { n: number }).n).toBe(2);
  });

  it("is idempotent — erasing twice does not move erased_at or remove the row", async () => {
    const first = await eraseContact(contactId);
    expect(first?.erasedAt).toBeNull();
    const firstRows = await db.query(`SELECT erased_at FROM crm_contacts WHERE id = $1`, [
      contactId,
    ]);
    const erasedAtAfterFirst = (firstRows.rows[0] as { erased_at: string }).erased_at;

    // The second erasure must be a no-op on erased_at: that date evidences
    // when the request was actually honoured, and a re-erase silently
    // moving it forward would destroy that evidence.
    const second = await eraseContact(contactId);
    expect(second).not.toBeNull();
    // The second call's `erasedAt` is non-null — the PRE-image now carries
    // the first call's timestamp — which is exactly the signal a caller
    // needs to tell a genuine erasure apart from a no-op re-erase, without a
    // second query. See `eraseContactAction`'s use of this.
    expect(second?.erasedAt).not.toBeNull();

    const secondRows = await db.query(`SELECT erased_at FROM crm_contacts WHERE id = $1`, [
      contactId,
    ]);
    expect(secondRows.rows).toHaveLength(1);
    expect((secondRows.rows[0] as { erased_at: string }).erased_at).toEqual(erasedAtAfterFirst);
  });

  it("returns null for a contact that does not exist", async () => {
    await expect(eraseContact("00000000-0000-0000-0000-000000000000")).resolves.toBeNull();
  });
});

describe("deleteOrganisation", () => {
  it("cascades to contacts, opportunities and activities", async () => {
    const result = await deleteOrganisation(orgId);
    expect(result?.name).toBe("Glebe Flowers");
    for (const table of ["crm_contacts", "crm_opportunities", "crm_activities"]) {
      const rows = await db.query(`SELECT id FROM ${table} WHERE organisation_id = $1`, [orgId]);
      expect(rows.rows).toHaveLength(0);
    }
    const orgs = await db.query(`SELECT id FROM crm_organisations WHERE id = $1`, [orgId]);
    expect(orgs.rows).toHaveLength(0);
  });

  it("reports what it removed, for the audit row", async () => {
    // Asymmetric counts (2 contacts, 3 opportunities on top of the
    // beforeEach fixture) so this test can fail for the reason it names:
    // symmetric fixtures pass even if the two fields were swapped, or one
    // count read the wrong table.
    await db.query(`INSERT INTO crm_contacts (organisation_id, name) VALUES ($1, $2)`, [
      orgId,
      "Second Contact",
    ]);
    await db.query(`INSERT INTO crm_opportunities (organisation_id, product) VALUES ($1, $2)`, [
      orgId,
      "kora",
    ]);
    await db.query(`INSERT INTO crm_opportunities (organisation_id, product) VALUES ($1, $2)`, [
      orgId,
      "hms",
    ]);

    const result = await deleteOrganisation(orgId);
    // A delete that reports only "ok" gives the audit log nothing to show
    // for an irreversible action.
    expect(result?.contactsDeleted).toBe(2);
    expect(result?.opportunitiesDeleted).toBe(3);
  });

  it("returns null for an id that does not exist", async () => {
    await expect(
      deleteOrganisation("00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeNull();
  });
});
