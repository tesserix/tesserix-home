import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Schema-only coverage for 0043_crm_templates.sql. Real (in-process)
 * Postgres via pglite, because every claim below is a claim about constraint
 * enforcement — the enum's domain and the
 * `crm_template_subject_is_email_only` CHECK — and neither can be proven by
 * asserting SQL text.
 *
 * The CHECK is the one worth reading. It exists because a subject authored
 * against a `dm` template would otherwise be stored and silently dropped at
 * render: the operator's words go nowhere and nothing tells them. The form
 * and the renderer can both be routed around by a future caller; the table
 * cannot. So the rejection is asserted here, against the database, rather
 * than against whichever validator happens to run today.
 *
 * No `vi.mock("./tesserix")` and no repo import: there is no module to test
 * yet (Task 1 ships the migration alone), and this file should keep passing
 * unchanged when one arrives.
 */

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();

  for (const migration of [
    // 0019 is the CRM schema this table joins. Loaded not because 0043 has a
    // foreign key into it — it deliberately has none — but so the migration
    // is proven to apply onto the schema it will actually meet, including
    // 0019's own `crm_` type names, which an enum name collision would hit.
    "0019_crm_schema.sql",
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
  await db.query(`TRUNCATE crm_templates`);
});

async function insertTemplate(
  channel: string,
  subject: string | null,
): Promise<{ id: string; is_archived: boolean; created_at: Date; updated_at: Date }> {
  const result = await db.query(
    `INSERT INTO crm_templates (name, channel, subject, body, created_by)
     VALUES ($1, $2::crm_template_channel, $3, $4, $5)
     RETURNING id, is_archived, created_at, updated_at`,
    ["Opening line", channel, subject, "Hi {{contact.name}}", "operator@tesserix.app"],
  );
  return result.rows[0] as {
    id: string;
    is_archived: boolean;
    created_at: Date;
    updated_at: Date;
  };
}

describe("crm_templates schema", () => {
  it("rejects a dm template carrying a subject", async () => {
    // The whole point of the CHECK: a DM has no subject line, so accepting
    // one would mean accepting text that is dropped at render.
    await expect(insertTemplate("dm", "You dropped this")).rejects.toThrow(
      /crm_template_subject_is_email_only/,
    );

    const remaining = await db.query(`SELECT count(*)::int AS n FROM crm_templates`);
    expect((remaining.rows[0] as { n: number }).n).toBe(0);
  });

  it("accepts a dm template with no subject", async () => {
    const row = await insertTemplate("dm", null);
    expect(row.id).toEqual(expect.any(String));
  });

  it("accepts an email template with a subject", async () => {
    const row = await insertTemplate("email", "A quick question about your shop");
    expect(row.id).toEqual(expect.any(String));
  });

  it("accepts an email template with no subject", async () => {
    // The CHECK constrains `dm`, not `email`: an email draft saved before its
    // subject is written is a half-finished template, not an invalid row.
    const row = await insertTemplate("email", null);
    expect(row.id).toEqual(expect.any(String));
  });

  it("rejects a channel outside the enum", async () => {
    // `sms` is the plausible wrong value — it is a channel, just not one this
    // feature has a send story for. The enum is what refuses it.
    await expect(insertTemplate("sms", null)).rejects.toThrow(/crm_template_channel/);
  });

  it("defaults a fresh row to not archived, with both timestamps set", async () => {
    const row = await insertTemplate("dm", null);
    // NOT NULL DEFAULT rather than a nullable flag: NULL and false would both
    // read as "not archived", and a reader would have to handle two.
    expect(row.is_archived).toBe(false);
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it("requires a name, a body and a created_by", async () => {
    // The three columns without which a template cannot be listed, rendered
    // or attributed. Asserted together because they are one decision.
    for (const column of ["name", "body", "created_by"]) {
      await expect(
        db.query(
          `INSERT INTO crm_templates (name, channel, body, created_by)
           VALUES ($1, 'dm', $2, $3)`,
          [
            column === "name" ? null : "Opening line",
            column === "body" ? null : "Hi {{contact.name}}",
            column === "created_by" ? null : "operator@tesserix.app",
          ],
        ),
      ).rejects.toThrow(new RegExp(column));
    }
  });

  it("leaves product nullable, which means any product", async () => {
    // Null is "any product", not "unknown": the estate is a TypeScript
    // constant with no table to reference, and a generic opener written
    // before anyone picked a product must still be storable.
    const result = await db.query(
      `INSERT INTO crm_templates (name, channel, body, created_by, product)
       VALUES ('Opening line', 'dm', 'Hi {{contact.name}}', 'operator@tesserix.app', NULL)
       RETURNING product`,
    );
    expect((result.rows[0] as { product: string | null }).product).toBeNull();
  });
});
