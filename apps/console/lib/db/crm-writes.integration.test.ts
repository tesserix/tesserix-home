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

const {
  createOrganisation,
  createContact,
  createOpportunity,
  updateOrganisation,
  DuplicateContactError,
} = await import("./crm-writes");
const { addSuppression, SuppressedContactError, linkConversion } = await import("./crm-repo");

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

  // 0023 makes `lower(instagram_handle)` unique (0019 shipped it plain —
  // issue #215) and adds the normalising trigger that makes that index
  // total rather than partial. Loaded here because the duplicate-contact
  // refusal below is a claim about what the REAL indexes enforce, and
  // `crm_contacts_instagram_lower_uq` does not exist without it.
  const instagramUniqueMigrationPath = path.resolve(
    __dirname,
    "../../../web/db/migrations/0023_crm_contacts_instagram_unique.sql",
  );
  await db.exec(readFileSync(instagramUniqueMigrationPath, "utf-8"));

  // 0025 adds `crm_organisations.country`, which `createOrganisation` now
  // writes — without it here, this fixture's inserts would fail on an
  // unknown column.
  const countryMigrationPath = path.resolve(
    __dirname,
    "../../../web/db/migrations/0025_crm_organisations_country.sql",
  );
  await db.exec(readFileSync(countryMigrationPath, "utf-8"));

  // 0027 adds `crm_contacts.metadata`, the raw-scrape bag `createContact`
  // now writes — without it here, the contact inserts below fail on an
  // unknown column.
  const metadataMigrationPath = path.resolve(
    __dirname,
    "../../../web/db/migrations/0027_crm_contacts_metadata.sql",
  );
  await db.exec(readFileSync(metadataMigrationPath, "utf-8"));
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

/**
 * `updateOrganisation` — the correction path (#227).
 *
 * Against a real database because the guarantees that matter here are about
 * what is and is not persisted: the derived `country`, the `text[] NOT NULL`
 * columns, and the fact that a no-op save leaves no activity row behind.
 */
describe("updateOrganisation", () => {
  async function orgRow(id: string) {
    const rows = await db.query(
      `SELECT name, location, country, website_url, category, tags, updated_at
         FROM crm_organisations WHERE id = $1`,
      [id],
    );
    return rows.rows[0] as {
      name: string;
      location: string | null;
      country: string | null;
      website_url: string | null;
      category: string[];
      tags: string[];
      updated_at: Date;
    };
  }

  async function activities(id: string) {
    const rows = await db.query(
      `SELECT kind, actor, body, metadata FROM crm_activities
        WHERE organisation_id = $1 ORDER BY occurred_at`,
      [id],
    );
    return rows.rows as Array<{
      kind: string;
      actor: string;
      body: string | null;
      metadata: Record<string, { from: unknown; to: unknown }>;
    }>;
  }

  it("re-derives country when the location changes", async () => {
    // The same mapper `createOrganisation` and `commitImport` use — #232
    // filters the follow-up queue by country, so a stale one mis-files the
    // organisation into another country's queue.
    const { organisationId } = await createOrganisation({
      name: "Moving Co",
      location: "Sydney",
    });
    await updateOrganisation({
      organisationId,
      actor: "ops@tesserix.app",
      name: "Moving Co",
      location: "Delhi",
    });
    const row = await orgRow(organisationId);
    expect(row.location).toBe("Delhi");
    expect(row.country).toBe("IN");
  });

  it("normalises category and tags, and stores empty arrays rather than nulls", async () => {
    // Both columns are `text[] NOT NULL DEFAULT '{}'` — a null would be
    // rejected outright, and duplicates would show twice on the detail view.
    const { organisationId } = await createOrganisation({ name: "Tagged Co" });
    const { changed } = await updateOrganisation({
      organisationId,
      actor: "ops@tesserix.app",
      name: "Tagged Co",
      category: [" cafe ", "bakery", "cafe", "   "],
      tags: [],
    });
    const row = await orgRow(organisationId);
    expect(row.category).toEqual(["cafe", "bakery"]);
    expect(row.tags).toEqual([]);
    expect(changed.map((c) => c.field)).toEqual(["category"]);
  });

  it("writes exactly one activity row recording the diff", async () => {
    const { organisationId } = await createOrganisation({
      name: "Typo Co",
      location: "Sydney",
    });
    await updateOrganisation({
      organisationId,
      actor: "ops@tesserix.app",
      name: "Typo Co Pty",
      location: "Sydney",
      websiteUrl: "https://typo.example",
    });
    const acts = await activities(organisationId);
    expect(acts).toHaveLength(1);
    expect(acts[0].kind).toBe("note");
    expect(acts[0].actor).toBe("ops@tesserix.app");
    expect(acts[0].metadata).toEqual({
      name: { from: "Typo Co", to: "Typo Co Pty" },
      websiteUrl: { from: null, to: "https://typo.example" },
    });
  });

  it("writes neither an update nor an activity row when nothing changed", async () => {
    const { organisationId } = await createOrganisation({
      name: "Steady Co",
      location: "Sydney",
    });
    const before = await orgRow(organisationId);
    const { changed } = await updateOrganisation({
      organisationId,
      actor: "ops@tesserix.app",
      name: "  Steady Co  ",
      location: "Sydney",
    });
    expect(changed).toEqual([]);
    const after = await orgRow(organisationId);
    // `updated_at` is stamped by hand in the UPDATE, so an unchanged
    // timestamp is proof no UPDATE ran at all.
    expect(after.updated_at).toEqual(before.updated_at);
    expect(await activities(organisationId)).toHaveLength(0);
  });

  // The scheme check has to hold at THIS layer: `updateOrganisation` is
  // exported, and a future caller that forgets the action-layer check would
  // put a `javascript:` href back on the organisation detail page.
  it("refuses a javascript: website url and changes nothing", async () => {
    const { organisationId } = await createOrganisation({
      name: "Guarded Co",
      websiteUrl: "https://guarded.example",
    });
    await expect(
      updateOrganisation({
        organisationId,
        actor: "ops@tesserix.app",
        name: "Guarded Co",
        websiteUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow(/websiteUrl/);
    const row = await orgRow(organisationId);
    expect(row.website_url).toBe("https://guarded.example");
    expect(await activities(organisationId)).toHaveLength(0);
  });

  it("leaves converted_* untouched — linkConversion stays their single writer", async () => {
    const { organisationId } = await createOrganisation({ name: "Linked Co" });
    await linkConversion({
      organisationId,
      product: "mark8ly",
      ref: "tenant-1",
      method: "manual",
      actor: "ops@tesserix.app",
    });
    await updateOrganisation({
      organisationId,
      actor: "ops@tesserix.app",
      name: "Linked Co Renamed",
    });
    const rows = await db.query(
      `SELECT converted_product, converted_ref FROM crm_organisations WHERE id = $1`,
      [organisationId],
    );
    const row = rows.rows[0] as { converted_product: string; converted_ref: string };
    expect(row.converted_product).toBe("mark8ly");
    expect(row.converted_ref).toBe("tenant-1");
  });

  it("rejects an unknown organisation", async () => {
    await expect(
      updateOrganisation({
        organisationId: "00000000-0000-0000-0000-000000000000",
        actor: "ops@tesserix.app",
        name: "Ghost Co",
      }),
    ).rejects.toThrow(/not found/i);
  });
});

/**
 * `createContact`'s own path — the door for a second phone number on an
 * organisation already in the CRM.
 *
 * The suppression tests above prove what it REFUSES. These prove what it
 * writes when it accepts, and what the database refuses underneath it.
 */
describe("createContact writes and the contact unique indexes", () => {
  async function contactRow(id: string) {
    const rows = await db.query(
      `SELECT name, email, phone, instagram_handle, is_primary
         FROM crm_contacts WHERE id = $1`,
      [id],
    );
    return rows.rows[0] as {
      name: string | null;
      email: string | null;
      phone: string | null;
      instagram_handle: string | null;
      is_primary: boolean;
    };
  }

  it("persists every field it was given, trimmed, with the email lowercased", async () => {
    const { organisationId } = await createOrganisation({ name: "Contents Co" });
    const { contactId } = await createContact({
      organisationId,
      name: "  Ada Vale  ",
      email: "  Ada@Contents.Example  ",
      phone: "  0400 000 000  ",
    });

    const row = await contactRow(contactId);
    expect(row.name).toBe("Ada Vale");
    // Lowercased on the way in, so `crm_contacts_email_lower_uq` and every
    // `lower(email) = lower($1)` lookup agree about the stored form.
    expect(row.email).toBe("ada@contents.example");
    expect(row.phone).toBe("0400 000 000");
  });

  it("stores an @-prefixed handle in its canonical form", async () => {
    // #236. Companion to the unit test, which asserts the parameter
    // `insertContact` passes: 0023's `crm_contacts_normalize()` trigger
    // normalises on write too, so this test alone could not tell the
    // application layer and the storage layer apart. What it does pin is
    // that the two agree on the canonical form.
    const { organisationId } = await createOrganisation({ name: "Handle Co" });
    const { contactId } = await createContact({
      organisationId,
      name: "Bondi Baker",
      instagramHandle: "  @BondiBaker  ",
    });

    expect((await contactRow(contactId)).instagram_handle).toBe("bondibaker");
  });

  it("stores a blank optional field as NULL, not an empty string", async () => {
    const { organisationId } = await createOrganisation({ name: "Blanks Co" });
    const { contactId } = await createContact({
      organisationId,
      name: "Solo",
      phone: "   ",
    });

    const row = await contactRow(contactId);
    expect(row.phone).toBeNull();
    expect(row.email).toBeNull();
    expect(row.instagram_handle).toBeNull();
  });

  it("does not make a later contact primary — the first one keeps that", async () => {
    // `listOrganisations` orders "primary first, created_at second". A
    // second contact silently claiming primary would move which person the
    // organisation row and the detail view lead with.
    const { organisationId } = await createOrganisation({
      name: "Two Contacts Co",
      contact: { name: "First", email: "first@example.com" },
    });
    const { contactId } = await createContact({
      organisationId,
      name: "Second",
      email: "second@example.com",
    });

    expect((await contactRow(contactId)).is_primary).toBe(false);
  });

  it("marks the contact primary when the caller asks for it", async () => {
    const { organisationId } = await createOrganisation({ name: "Primary Co" });
    const { contactId } = await createContact({
      organisationId,
      name: "Lead",
      email: "lead@example.com",
      isPrimary: true,
    });

    expect((await contactRow(contactId)).is_primary).toBe(true);
  });

  it("refuses a duplicate email and names that key, without naming the holder", async () => {
    const first = await createOrganisation({ name: "Email Holder" });
    await createContact({ organisationId: first.organisationId, email: "taken@example.com" });
    const second = await createOrganisation({ name: "Email Latecomer" });

    const cause = await createContact({
      organisationId: second.organisationId,
      email: "TAKEN@example.com",
    }).then(
      () => {
        throw new Error("expected createContact to reject");
      },
      (error: unknown) => error,
    );

    expect(cause).toBeInstanceOf(DuplicateContactError);
    expect((cause as Error).message).toMatch(/email/i);
    // The holder is another business's record; the operator learns the key
    // is taken and nothing else.
    expect((cause as Error).message).not.toMatch(/Email Holder/);
    expect((cause as Error).message).not.toMatch(new RegExp(first.organisationId));

    const rows = await db.query(`SELECT id FROM crm_contacts WHERE organisation_id = $1`, [
      second.organisationId,
    ]);
    expect(rows.rows).toHaveLength(0);
  });

  it("refuses a duplicate Instagram handle and names that key", async () => {
    const first = await createOrganisation({ name: "Handle Holder" });
    await createContact({ organisationId: first.organisationId, instagramHandle: "takenshop" });
    const second = await createOrganisation({ name: "Handle Latecomer" });

    const cause = await createContact({
      organisationId: second.organisationId,
      instagramHandle: "TakenShop",
    }).then(
      () => {
        throw new Error("expected createContact to reject");
      },
      (error: unknown) => error,
    );

    expect(cause).toBeInstanceOf(DuplicateContactError);
    expect((cause as Error).message).toMatch(/instagram handle/i);
    expect((cause as Error).message).not.toMatch(/Handle Holder/);
  });
});

/**
 * The scrape fields (#235). `followers_count`, `posts_count` and
 * `biography` have been on `crm_contacts` since 0019 with no live writer;
 * `metadata` is 0027's bag for the raw scrape output around them.
 */
describe("createContact and the scrape fields", () => {
  it("writes all four — the three typed columns and the raw bag", async () => {
    const { organisationId } = await createOrganisation({ name: "Scrape Co" });
    const { contactId } = await createContact({
      organisationId,
      name: "Ravi Menon",
      email: "ravi@scrape.example",
      biography: "Roaster and owner",
      followersCount: 1200,
      postsCount: 340,
      metadata: { profile_pic_url: "https://cdn.example/ravi.jpg", is_verified: true },
    });

    const rows = await db.query<{
      biography: string | null;
      followers_count: number | null;
      posts_count: number | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT biography, followers_count, posts_count, metadata
         FROM crm_contacts WHERE id = $1`,
      [contactId],
    );
    expect(rows.rows[0]).toEqual({
      biography: "Roaster and owner",
      followers_count: 1200,
      posts_count: 340,
      // Round-trips as an object, not a string: the column is jsonb and the
      // bag is only useful if what comes back out is what went in.
      metadata: { profile_pic_url: "https://cdn.example/ravi.jpg", is_verified: true },
    });
  });

  it("defaults the bag to an empty object when the caller supplies none", async () => {
    const { organisationId } = await createOrganisation({ name: "Bagless Co" });
    const { contactId } = await createContact({ organisationId, name: "No Bag" });
    const rows = await db.query<{ metadata: Record<string, unknown>; biography: string | null }>(
      `SELECT metadata, biography FROM crm_contacts WHERE id = $1`,
      [contactId],
    );
    // NOT NULL DEFAULT '{}' — never null, so no reader has to distinguish
    // "no bag" from "empty bag".
    expect(rows.rows[0].metadata).toEqual({});
    expect(rows.rows[0].biography).toBeNull();
  });

  it("refuses a count that the integer column cannot hold, rather than letting the INSERT raise", async () => {
    const { organisationId } = await createOrganisation({ name: "Overflow Co" });
    await expect(
      createContact({ organisationId, name: "Too Many", followersCount: 2_147_483_648 }),
    ).rejects.toThrow(/followersCount/);
  });

  it("refuses a fractional or negative count", async () => {
    const { organisationId } = await createOrganisation({ name: "Fraction Co" });
    await expect(
      createContact({ organisationId, name: "Half", postsCount: 12.5 }),
    ).rejects.toThrow(/postsCount/);
    await expect(
      createContact({ organisationId, name: "Negative", followersCount: -1 }),
    ).rejects.toThrow(/followersCount/);
  });
});
