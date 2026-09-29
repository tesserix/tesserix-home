import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for the follower refresh, against a real engine.
 *
 * The claim worth proving on rows rather than on SQL text is the same one the
 * #248 backfill had to prove: a refresh that supplies one field leaves every
 * other column exactly where it was. A mocked test can say the statement named
 * only `followers_count`; this one says the handles are still there after a
 * whole target list has been refreshed.
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

const { createOrganisation, createContact } = await import("./crm-writes");
const { refreshFollowerCounts } = await import("./crm-followers-refresh");

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
    await db.exec(readFileSync(path.resolve(__dirname, "../../../web/db/migrations", file), "utf-8"));
  }
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    `DELETE FROM crm_activities; DELETE FROM crm_contacts; DELETE FROM crm_organisations;`,
  );
});

async function seed(name: string, handle: string, followers: number | undefined) {
  const { organisationId } = await createOrganisation({ name });
  const { contactId } = await createContact({
    organisationId,
    name,
    email: `${handle}@example.com`,
    instagramHandle: handle,
    followersCount: followers,
    isPrimary: true,
    source: "import",
    lawfulBasis: "legitimate_interests",
  });
  return { organisationId, contactId };
}

async function readContact(contactId: string) {
  const { rows } = await db.query<{
    name: string | null;
    email: string | null;
    instagram_handle: string | null;
    followers_count: number | null;
    lawful_basis: string | null;
  }>(
    `SELECT name, email, instagram_handle, followers_count, lawful_basis
       FROM crm_contacts WHERE id = $1`,
    [contactId],
  );
  return rows[0];
}

describe("refreshFollowerCounts against a real database", () => {
  it("moves the count and leaves every other column intact", async () => {
    const { contactId } = await seed("Krafty Knots", "krafty.knots", 1556);

    const result = await refreshFollowerCounts({
      readings: [{ handle: "@Krafty.Knots", followersCount: 4054 }],
      actor: "ops@tesserix.app",
      dryRun: false,
    });

    expect(result).toEqual({ matched: 1, changed: 1, unmatched: [], failures: [] });

    // THE CLAIM.
    const row = await readContact(contactId);
    expect(row.followers_count).toBe(4054);
    expect(row.name).toBe("Krafty Knots");
    expect(row.email).toBe("krafty.knots@example.com");
    expect(row.instagram_handle).toBe("krafty.knots");
    expect(row.lawful_basis).toBe("legitimate_interests");
  });

  it("fills in a count that was never recorded", async () => {
    const { contactId } = await seed("Shenayas", "shenayascollection", undefined);

    await refreshFollowerCounts({
      readings: [{ handle: "shenayascollection", followersCount: 66 }],
      actor: "ops@tesserix.app",
      dryRun: false,
    });

    expect((await readContact(contactId)).followers_count).toBe(66);
  });

  // A dead lead dropping out of the target list is expected, and must not
  // become a new contact acquired without a lawful basis or a suppression check.
  it("reports a vanished lead as unmatched rather than creating it", async () => {
    await seed("Krafty Knots", "krafty.knots", 1556);

    const result = await refreshFollowerCounts({
      readings: [
        { handle: "krafty.knots", followersCount: 4054 },
        { handle: "jays_silks_and_sarees", followersCount: 2088 },
      ],
      actor: "ops@tesserix.app",
      dryRun: false,
    });

    expect(result.matched).toBe(1);
    expect(result.unmatched).toEqual(["jays_silks_and_sarees"]);

    const { rows } = await db.query(`SELECT count(*)::int AS n FROM crm_contacts`);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  // eraseContact nulls followers_count deliberately; writing a number back
  // would reverse an erasure with a metrics job.
  it("never touches an erased contact", async () => {
    const { contactId } = await seed("Gone", "gone", 500);
    await db.query(`UPDATE crm_contacts SET erased_at = now(), followers_count = NULL WHERE id = $1`, [
      contactId,
    ]);

    const result = await refreshFollowerCounts({
      readings: [{ handle: "gone", followersCount: 900 }],
      actor: "ops@tesserix.app",
      dryRun: false,
    });

    expect(result.unmatched).toEqual(["gone"]);
    expect((await readContact(contactId)).followers_count).toBeNull();
  });

  it("writes an auditable row naming the actor and the movement", async () => {
    const { organisationId } = await seed("Krafty Knots", "krafty.knots", 1556);

    await refreshFollowerCounts({
      readings: [{ handle: "krafty.knots", followersCount: 4054 }],
      actor: "mahesh@tesserix.app",
      dryRun: false,
    });

    const { rows } = await db.query<{ actor: string; body: string; metadata: unknown }>(
      `SELECT actor, body, metadata FROM crm_activities WHERE organisation_id = $1`,
      [organisationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("mahesh@tesserix.app");
    expect(rows[0].body).toBe("Edited followersCount");
    expect(rows[0].metadata).toEqual({ followersCount: { from: "1556", to: "4054" } });
  });

  it("changes nothing on a dry run", async () => {
    const { contactId } = await seed("Krafty Knots", "krafty.knots", 1556);

    const result = await refreshFollowerCounts({
      readings: [{ handle: "krafty.knots", followersCount: 4054 }],
      actor: "ops@tesserix.app",
      dryRun: true,
    });

    expect(result).toEqual({ matched: 1, changed: 0, unmatched: [], failures: [] });
    expect((await readContact(contactId)).followers_count).toBe(1556);
  });

  it("is a no-op when re-run with the same readings", async () => {
    await seed("Krafty Knots", "krafty.knots", 1556);
    const options = {
      readings: [{ handle: "krafty.knots", followersCount: 4054 }],
      actor: "ops@tesserix.app",
      dryRun: false,
    } as const;

    await refreshFollowerCounts(options);
    const second = await refreshFollowerCounts(options);

    expect(second).toEqual({ matched: 1, changed: 0, unmatched: [], failures: [] });
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM crm_activities`);
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});
