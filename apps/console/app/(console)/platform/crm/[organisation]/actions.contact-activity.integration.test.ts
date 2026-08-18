import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The whole chain, composed (#245): the server action, the real
 * `withCrmWrite` gate, the real audit write, the real `logActivity`, against
 * a real Postgres (pglite). Nothing between the action and the database is
 * mocked.
 *
 * Why this exists on top of `actions.test.ts`. That file mocks `logActivity`
 * and asserts that a `SuppressedContactError` it throws itself is mapped to
 * the operator. That proves the mapper, not the wiring: it would pass just
 * as well if the repo never raised, if the raise happened after the insert,
 * or if the action's allowlist named an exception the repo does not use. The
 * do-not-contact check on outbound activity has NEVER executed in production
 * — no outbound kind was reachable from the console until now — so "it looks
 * right" is not evidence. This runs it.
 */

const dbHolder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tesserix/platform-auth")>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/db/tesserix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/tesserix")>();
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

import { getCurrentSession } from "@tesserix/platform-auth";
import { SuppressedContactError } from "@/lib/db/crm-repo";
import { addActivity } from "./actions";

const MIGRATIONS = [
  "0018_console_audit_log.sql",
  "0019_crm_schema.sql",
  "0022_crm_suppressions_normalize.sql",
];

let db: PGlite;

beforeEach(async () => {
  vi.clearAllMocks();
  db = new PGlite();
  dbHolder.db = db;
  for (const file of MIGRATIONS) {
    // Seven levels up from `app/(console)/platform/crm/[organisation]` is
    // the repo root.
    const migration = path.resolve(__dirname, "../../../../../../../apps/web/db/migrations", file);
    await db.exec(readFileSync(migration, "utf-8"));
  }
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "sub-1",
    email: "ava@tesserix.app",
    roles: ["read"],
    iat: 0,
    exp: 0,
  } as never);
});

afterEach(async () => {
  await db.close();
});

async function seedOrganisation(name: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO crm_organisations (name) VALUES ($1) RETURNING id`,
    [name],
  );
  return rows.rows[0].id;
}

async function seedOpportunity(organisationId: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, stage) VALUES ($1, 'new') RETURNING id`,
    [organisationId],
  );
  return rows.rows[0].id;
}

describe("addActivity, composed all the way to the database", () => {
  it("records a call and moves the drift clock, with no deal named", async () => {
    const orgId = await seedOrganisation("Bondi Baker");
    const oppId = await seedOpportunity(orgId);

    const result = await addActivity({ organisationId: orgId, kind: "call", body: "spoke to Ana" });

    expect(result).toEqual({ ok: true });
    const opp = await db.query<{ last_contacted_at: Date | null }>(
      `SELECT last_contacted_at FROM crm_opportunities WHERE id = $1`,
      [oppId],
    );
    expect(opp.rows[0].last_contacted_at).not.toBeNull();
  });

  // The control going live. The message the operator reads is asserted to be
  // the one the repository raises — same object, not a matching regex — so
  // this fails if either end changes its wording without the other.
  it("refuses outreach to a suppressed contact in the repository's own words", async () => {
    const orgId = await seedOrganisation("Asked Us To Stop");
    const oppId = await seedOpportunity(orgId);
    await db.query(`INSERT INTO crm_contacts (organisation_id, email) VALUES ($1, $2)`, [
      orgId,
      "gone@example.com",
    ]);
    await db.query(
      `INSERT INTO crm_suppressions (email, reason, created_by) VALUES ($1, $2, $3)`,
      ["gone@example.com", "asked to stop", "ava"],
    );

    const result = await addActivity({ organisationId: orgId, kind: "email_sent", body: "hello" });

    expect(result).toEqual({
      ok: false,
      message: new SuppressedContactError(orgId).message,
    });

    // And nothing was written, by either the action or the repository.
    const activities = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_activities WHERE organisation_id = $1`,
      [orgId],
    );
    expect(activities.rows[0].count).toBe("0");
    const opp = await db.query<{ last_contacted_at: Date | null }>(
      `SELECT last_contacted_at FROM crm_opportunities WHERE id = $1`,
      [oppId],
    );
    expect(opp.rows[0].last_contacted_at).toBeNull();
    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM console_audit_log`,
    );
    expect(audit.rows[0].count).toBe("0");
  });

  it("still records an inbound message from that same suppressed contact", async () => {
    const orgId = await seedOrganisation("Asked Us To Stop");
    await db.query(`INSERT INTO crm_contacts (organisation_id, email) VALUES ($1, $2)`, [
      orgId,
      "gone@example.com",
    ]);
    await db.query(
      `INSERT INTO crm_suppressions (email, reason, created_by) VALUES ($1, $2, $3)`,
      ["gone@example.com", "asked to stop", "ava"],
    );

    const result = await addActivity({ organisationId: orgId, kind: "email_received" });

    expect(result).toEqual({ ok: true });
  });
});
