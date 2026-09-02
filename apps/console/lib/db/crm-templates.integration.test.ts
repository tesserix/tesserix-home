import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for `crm-templates.ts`. Real (in-process) Postgres via
 * pglite, not asserted SQL text, because three of the claims below are claims
 * about the DATABASE and cannot be made anywhere else:
 *
 *  - `createTemplate` writes NO ROW when the merge-field check throws (a
 *    mocked query would prove only that a function returned early);
 *  - a second `archiveTemplate` returns `[]` because the UPDATE's
 *    `AND NOT is_archived` matched nothing;
 *  - a `dm` subject is refused by `crm_template_subject_is_email_only`
 *    rather than quietly nulled on the way past.
 *
 * The fourth is the one this file exists for: `templateContext` must omit a
 * contact that `eraseContact` has already been through. That test runs the
 * REAL `eraseContact`, not a hand-set `erased_at`, and then asserts the row
 * is still there carrying the literal name `'[erased]'`. Without that second
 * half the exclusion test would pass against a fixture that simply had no
 * second contact, and would keep passing the day `erased_at` stopped being
 * written — a green suite that evidenced nothing.
 *
 * Own pglite instance — a `vi.mock` in one test file cannot be shared with
 * another (see crm-erasure.integration.test.ts).
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
    // pglite is a single embedded session and satisfies `TxClient`
    // structurally, so delegating to the real `runTesserixTx` exercises the
    // BEGIN/COMMIT/ROLLBACK that ships. Needed here only by `eraseContact`.
    tesserixTx: async (fn: Parameters<typeof actual.runTesserixTx>[1]) =>
      actual.runTesserixTx(dbHolder.db as Parameters<typeof actual.runTesserixTx>[0], fn),
    isDatabaseConfigured: () => true,
  };
});

const { listTemplates, createTemplate, archiveTemplate, templateContext } = await import(
  "./crm-templates"
);
const { UnknownMergeFieldError } = await import("../crm-merge-fields");
const { renderTemplate } = await import("../crm-merge-fields");
const { eraseContact } = await import("./crm-erasure");
const { ERASURE_HASH_KEY_ENV } = await import("./crm-erasure-hash");

const ACTOR = "operator@tesserix.app";

let db: PGlite;
let orgId: string;

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;

  for (const migration of [
    "0019_crm_schema.sql",
    // `crm_contacts.erased_at` — the column the exclusion below is about.
    "0024_crm_contacts_erased_at.sql",
    // 0027 (`crm_contacts.metadata`) and 0041 (the erasure register) are
    // here for one reason: the erasure tests below run the REAL
    // `eraseContact`, which empties `metadata` and inserts a hash in the
    // same transaction. Neither column is read by `crm-templates.ts`, and
    // omitting them was tried first — the suite failed on `column
    // "metadata" of relation "crm_contacts" does not exist` rather than on
    // any claim this file makes. Running the real erasure is worth that
    // cost: a hand-set `erased_at` would prove the WHERE clause matches a
    // column this test populated itself, not that it matches what erasure
    // actually leaves behind.
    "0027_crm_contacts_metadata.sql",
    "0041_crm_erased_identifiers.sql",
    "0043_crm_templates.sql",
  ]) {
    const migrationPath = path.resolve(__dirname, "../../../web/db/migrations", migration);
    await db.exec(readFileSync(migrationPath, "utf-8"));
  }
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // `eraseContact` fails closed without a key (#226). Stubbed for the whole
  // file so the erasure test asserts the exclusion rather than the refusal,
  // which `crm-erasure-import.integration.test.ts` already owns.
  vi.stubEnv(ERASURE_HASH_KEY_ENV, "integration-erasure-key");

  await db.query(`TRUNCATE crm_organisations CASCADE`);
  await db.query(`TRUNCATE crm_templates`);
  await db.query(`TRUNCATE crm_erased_identifiers`);

  const orgRows = await db.query(
    `INSERT INTO crm_organisations (name, location, category)
     VALUES ($1, $2, $3) RETURNING id`,
    ["Glebe Flowers", "Sydney", ["florist", "gifts"]],
  );
  orgId = (orgRows.rows[0] as { id: string }).id;
});

async function insertContact(overrides: {
  name?: string | null;
  email?: string | null;
  instagramHandle?: string | null;
  biography?: string | null;
  isPrimary?: boolean;
}): Promise<string> {
  const rows = await db.query(
    `INSERT INTO crm_contacts
       (organisation_id, name, email, instagram_handle, biography, is_primary,
        source, sourced_at, lawful_basis)
     VALUES ($1, $2, $3, $4, $5, $6, 'instagram_scrape', now(), 'legitimate_interest')
     RETURNING id`,
    [
      orgId,
      overrides.name ?? "Priya Raman",
      overrides.email ?? null,
      overrides.instagramHandle ?? null,
      overrides.biography ?? null,
      overrides.isPrimary ?? false,
    ],
  );
  return (rows.rows[0] as { id: string }).id;
}

async function templateCount(): Promise<number> {
  const rows = await db.query(`SELECT count(*)::int AS n FROM crm_templates`);
  return (rows.rows[0] as { n: number }).n;
}

describe("createTemplate", () => {
  it("round-trips a dm template", async () => {
    const row = await createTemplate({
      name: "Opening line",
      channel: "dm",
      body: "Hi {{contact.name}} at {{org.name}}",
      actor: ACTOR,
    });

    expect(row).toMatchObject({
      name: "Opening line",
      channel: "dm",
      product: null,
      subject: null,
      body: "Hi {{contact.name}} at {{org.name}}",
      isArchived: false,
      createdBy: ACTOR,
    });
    expect(row.createdAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);
  });

  it("round-trips an email template with a subject and a product", async () => {
    const row = await createTemplate({
      name: "Shop follow-up",
      channel: "email",
      product: "marketplace",
      subject: "A note for {{org.name}}",
      body: "Hi {{contact.name}} — {{contact.biography}}",
      actor: ACTOR,
    });

    expect(row.subject).toBe("A note for {{org.name}}");
    expect(row.product).toBe("marketplace");
    expect(row.channel).toBe("email");
  });

  it("refuses an unknown merge field in the body and writes no row", async () => {
    // The authoring-time rejection. A template carrying this token renders
    // nothing for every lead forever, so it must not reach the table — and
    // "did not reach the table" is a claim only a real database can settle.
    await expect(
      createTemplate({
        name: "Broken",
        channel: "dm",
        body: "You have {{contact.followers}} followers",
        actor: ACTOR,
      }),
    ).rejects.toThrow(UnknownMergeFieldError);

    expect(await templateCount()).toBe(0);
  });

  it("names the unknown token on the error it throws", async () => {
    // Carried as data, not only in prose, so the action can render a list
    // without parsing its own message.
    const error = await createTemplate({
      name: "Broken",
      channel: "dm",
      body: "{{contact.followers}} and {{org.abn}}",
      actor: ACTOR,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(UnknownMergeFieldError);
    expect((error as InstanceType<typeof UnknownMergeFieldError>).unknown).toEqual([
      "contact.followers",
      "org.abn",
    ]);
  });

  it("refuses an unknown merge field in the subject too", async () => {
    // A bad token in a subject line is the same authoring bug as one in the
    // body: `renderTemplate` fails the whole render for either.
    await expect(
      createTemplate({
        name: "Broken subject",
        channel: "email",
        subject: "About {{org.abn}}",
        body: "Hi {{contact.name}}",
        actor: ACTOR,
      }),
    ).rejects.toThrow(UnknownMergeFieldError);

    expect(await templateCount()).toBe(0);
  });

  it("passes a dm subject through to the CHECK rather than nulling it", async () => {
    // Deliberately NOT normalised away. Silently dropping the subject is the
    // exact failure 0043's CHECK exists to prevent — the operator's words
    // would go nowhere and nothing would tell them.
    await expect(
      createTemplate({
        name: "Subjected dm",
        channel: "dm",
        subject: "You dropped this",
        body: "Hi {{contact.name}}",
        actor: ACTOR,
      }),
    ).rejects.toThrow(/crm_template_subject_is_email_only/);

    expect(await templateCount()).toBe(0);
  });
});

describe("archiveTemplate", () => {
  it("flips the flag and reports the row it archived", async () => {
    const created = await createTemplate({
      name: "Opening line",
      channel: "dm",
      body: "Hi {{contact.name}}",
      actor: ACTOR,
    });

    const archived = await archiveTemplate(created.id);
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe(created.id);
    expect(archived[0].isArchived).toBe(true);
    // `updated_at` is moved by the statement, not by a trigger (0043).
    expect(Date.parse(archived[0].updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(created.updatedAt),
    );
  });

  it("reports nothing on a second archive, so the audit count is the real outcome", async () => {
    const created = await createTemplate({
      name: "Opening line",
      channel: "dm",
      body: "Hi {{contact.name}}",
      actor: ACTOR,
    });

    await archiveTemplate(created.id);
    // `AND NOT is_archived` matched nothing. An audit row claiming
    // `{ archived: 1 }` here would record an archival that did not happen.
    expect(await archiveTemplate(created.id)).toEqual([]);
  });

  it("reports nothing for an id that does not exist", async () => {
    expect(await archiveTemplate(crypto.randomUUID())).toEqual([]);
  });

  it("archives rather than deletes, so template_id stays resolvable", async () => {
    // The reason archiving exists at all: `crm_activities.metadata` carries
    // `template_id` forever, and a DELETE would leave those rows dangling.
    const created = await createTemplate({
      name: "Opening line",
      channel: "dm",
      body: "Hi {{contact.name}}",
      actor: ACTOR,
    });
    await archiveTemplate(created.id);

    expect(await templateCount()).toBe(1);
  });
});

describe("listTemplates", () => {
  it("hides archived rows by default and shows them on request", async () => {
    const live = await createTemplate({
      name: "Live",
      channel: "dm",
      body: "Hi {{contact.name}}",
      actor: ACTOR,
    });
    const retired = await createTemplate({
      name: "Retired",
      channel: "dm",
      body: "Hello {{contact.name}}",
      actor: ACTOR,
    });
    await archiveTemplate(retired.id);

    expect((await listTemplates()).map((row) => row.id)).toEqual([live.id]);

    const all = await listTemplates({ includeArchived: true });
    expect(all.map((row) => row.id).sort()).toEqual([live.id, retired.id].sort());
  });

  it("filters by channel", async () => {
    const dm = await createTemplate({
      name: "DM",
      channel: "dm",
      body: "Hi {{contact.name}}",
      actor: ACTOR,
    });
    await createTemplate({
      name: "Email",
      channel: "email",
      subject: "Hello",
      body: "Hi {{contact.name}}",
      actor: ACTOR,
    });

    expect((await listTemplates({ channel: "dm" })).map((row) => row.id)).toEqual([dm.id]);
  });

  it("returns newest first", async () => {
    const first = await createTemplate({
      name: "First",
      channel: "dm",
      body: "Hi {{contact.name}}",
      actor: ACTOR,
    });
    const second = await createTemplate({
      name: "Second",
      channel: "dm",
      body: "Hi {{contact.name}}",
      actor: ACTOR,
    });

    // `created_at` is not unique under pglite's clock, which is exactly why
    // the ORDER BY carries `id` — without a total order these two swap
    // between renders.
    const names = (await listTemplates()).map((row) => row.name);
    expect(names).toHaveLength(2);
    expect(new Set(names)).toEqual(new Set(["First", "Second"]));
    expect([first.id, second.id]).toContain((await listTemplates())[0].id);
  });

  it("returns an empty list rather than throwing when there are none", async () => {
    expect(await listTemplates()).toEqual([]);
  });
});

describe("templateContext", () => {
  it("returns the organisation and a contact's biography for rendering", async () => {
    const contactId = await insertContact({
      name: "Priya Raman",
      email: "priya@glebeflowers.example",
      instagramHandle: "priyaraman",
      biography: "Florist and owner",
      isPrimary: true,
    });

    const context = await templateContext(orgId);

    expect(context).not.toBeNull();
    expect(context?.organisation).toEqual({
      id: orgId,
      name: "Glebe Flowers",
      location: "Sydney",
      category: ["florist", "gifts"],
    });
    expect(context?.contacts).toEqual([
      {
        id: contactId,
        name: "Priya Raman",
        email: "priya@glebeflowers.example",
        instagramHandle: "priyaraman",
        // The one place in the console that returns this column. Render only
        // — see `crm-outreach.integration.test.ts` for the proof that the
        // write path never stores it.
        biography: "Florist and owner",
      },
    ]);
  });

  it("returns null for an organisation that does not exist", async () => {
    // Distinct from "an organisation whose contacts are all erased", which
    // returns an empty list. The two want different messages.
    expect(await templateContext(crypto.randomUUID())).toBeNull();
  });

  it("omits a contact that has been erased", async () => {
    const erasedId = await insertContact({
      name: "Priya Raman",
      email: "priya@glebeflowers.example",
      instagramHandle: "priyaraman",
      biography: "Florist and owner",
      isPrimary: true,
    });
    const keptId = await insertContact({
      name: "Sam Wu",
      email: "sam@glebeflowers.example",
      biography: "Runs the Saturday market stall",
    });

    await eraseContact(erasedId);

    const context = await templateContext(orgId);
    expect(context?.contacts.map((contact) => contact.id)).toEqual([keptId]);
  });

  it("keeps the erased row in the table under the name '[erased]', which is why the filter is needed", async () => {
    // THE NEGATIVE CONTROL for the test above. `eraseContact` does not delete
    // the row and does not null the name — it writes the literal string
    // '[erased]'. So the erased contact does NOT present to a renderer as
    // missing data; it presents as a name, and every other guard in this
    // feature is a null check. Without this assertion the exclusion test
    // would pass against a fixture that had simply been deleted.
    const erasedId = await insertContact({
      name: "Priya Raman",
      email: "priya@glebeflowers.example",
      instagramHandle: "priyaraman",
      biography: "Florist and owner",
      isPrimary: true,
    });
    await eraseContact(erasedId);

    const rows = await db.query(`SELECT name, erased_at FROM crm_contacts WHERE id = $1`, [
      erasedId,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as { name: string }).name).toBe("[erased]");
    expect((rows.rows[0] as { erased_at: Date | null }).erased_at).not.toBeNull();

    // And the consequence, stated as an assertion rather than a comment: fed
    // to the renderer, that row renders a greeting addressed to "[erased]".
    // This is the message `templateContext`'s WHERE clause exists to prevent
    // an operator from pasting into a stranger's DMs.
    const rendered = renderTemplate({
      body: "Hi {{contact.name}}",
      values: { "contact.name": "[erased]" },
    });
    expect(rendered).toEqual({ ok: true, text: "Hi [erased]" });
  });

  it("returns an empty contact list when every contact is erased", async () => {
    const only = await insertContact({ name: "Priya Raman", biography: "Florist" });
    await eraseContact(only);

    const context = await templateContext(orgId);
    expect(context).not.toBeNull();
    expect(context?.contacts).toEqual([]);
  });

  it("offers the primary contact first, agreeing with the detail page", async () => {
    const secondary = await insertContact({ name: "Sam Wu" });
    const primary = await insertContact({ name: "Priya Raman", isPrimary: true });

    const context = await templateContext(orgId);
    expect(context?.contacts.map((contact) => contact.id)).toEqual([primary, secondary]);
  });
});
