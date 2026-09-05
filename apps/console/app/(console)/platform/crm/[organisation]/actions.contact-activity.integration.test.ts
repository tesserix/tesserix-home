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
import {
  dueOpportunities,
  driftingOpportunities,
  SuppressedContactError,
} from "@/lib/db/crm-repo";
import { DRIFT_DAYS, NEXT_ACTION_DAYS } from "@/lib/crm";
import { addActivity } from "./actions";

const MIGRATIONS = [
  "0018_console_audit_log.sql",
  "0019_crm_schema.sql",
  "0022_crm_suppressions_normalize.sql",
  // `voided_at`, which `CLOCK_ELIGIBLE_SQL` and the two work queues all read
  // (#251).
  "0049_crm_opportunities_voided.sql",
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

/** A lead old enough to be drifting before anything is logged against it —
 *  the state all 259 of them are in. Staleness is measured from
 *  `COALESCE(last_contacted_at, created_at)`, so backdating the row is what
 *  puts it in the queue. */
async function seedDriftingOpportunity(organisationId: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, stage, created_at)
     VALUES ($1, 'contacted', now() - interval '121 days') RETURNING id`,
    [organisationId],
  );
  return rows.rows[0].id;
}

async function driftingIds(): Promise<string[]> {
  const page = await driftingOpportunities({}, DRIFT_DAYS, 50);
  return page.rows.map((row) => row.id);
}

async function dueIds(): Promise<string[]> {
  const page = await dueOpportunities({}, 50);
  return page.rows.map((row) => row.id);
}

/**
 * An opportunity in the state migration 0021 grandfathered: past `contacted`
 * with no product. Insertable only with the CHECK momentarily off, which is
 * how these rows came to exist at all — 0020 dropped the constraint, the lead
 * backfill loaded ~155 of them, 0021 re-added it NOT VALID so they were never
 * scanned.
 */
async function seedGrandfatheredOpportunity(organisationId: string): Promise<string> {
  await db.exec(
    `ALTER TABLE crm_opportunities DROP CONSTRAINT crm_opp_product_required_when_qualified`,
  );
  const rows = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, stage, product)
     VALUES ($1, 'qualified', NULL) RETURNING id`,
    [organisationId],
  );
  await db.exec(
    `ALTER TABLE crm_opportunities
       ADD CONSTRAINT crm_opp_product_required_when_qualified CHECK (
         stage IN ('new', 'contacted') OR product IS NOT NULL
       ) NOT VALID`,
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

  /**
   * The failure an operator would actually have met, in the words they would
   * have met it in.
   *
   * Logging against one named deal ran a `WHERE id = $1` with none of the
   * guards the organisation-wide branch carries, so migration 0021's CHECK
   * fired on the new row of a bare timestamp UPDATE and rolled the whole
   * transaction back. What reached the operator was `{ ok: false }` and "That
   * change was not saved." — for a call that has nothing to do with the
   * product column, on a deal they may not even have been looking at.
   *
   * A CONTACT KIND, not a note, and that is the entire test. A `note` does not
   * move the clock (`CONTACT_ACTIVITY_KINDS`), so it never reaches the
   * offending UPDATE and saves against a grandfathered deal whether the guard
   * is there or not — an assertion about one would be green against the bug.
   * `call` is the cheapest kind that actually runs the statement.
   *
   * Asserted through the action rather than the repository because the
   * misleading message is the harm; `logActivity` merely throws.
   */
  it("saves a call against a grandfathered deal instead of refusing it over an unrelated product", async () => {
    const orgId = await seedOrganisation("Migrated Co");
    const oppId = await seedGrandfatheredOpportunity(orgId);

    const result = await addActivity({
      organisationId: orgId,
      opportunityId: oppId,
      kind: "call",
      body: "spoke to Ana",
    });

    expect(result).toEqual({ ok: true });
    const activities = await db.query<{ body: string | null }>(
      `SELECT body FROM crm_activities WHERE opportunity_id = $1`,
      [oppId],
    );
    expect(activities.rows).toEqual([{ body: "spoke to Ana" }]);
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

/**
 * #502, through the surface the operator actually uses.
 *
 * The console offers one door onto `crm_activities` — this action — and the
 * queue is what it is for. So the claim under test is not "a column changed"
 * but "the lead moved from the list nobody can work to the list that has a
 * date on it", asserted by reading the queues the CRM page reads.
 */
describe("logging contact and the queue it lands the lead in", () => {
  it("takes a drifting lead out of Drifting and schedules a chase", async () => {
    const orgId = await seedOrganisation("Waiting 121d");
    const oppId = await seedDriftingOpportunity(orgId);

    expect(await driftingIds()).toContain(oppId);

    const result = await addActivity({ organisationId: orgId, kind: "dm_sent" });

    expect(result).toEqual({ ok: true });
    expect(await driftingIds()).not.toContain(oppId);
    // Not in Due YET, and that is correct rather than a gap: Due means
    // `next_action_at <= now()`, and the whole point of the default is that
    // the chase is owed in a few days' time. This is the list to work then.
    expect(await dueIds()).not.toContain(oppId);
    const rows = await db.query<{ next_action_at: Date }>(
      `SELECT next_action_at FROM crm_opportunities WHERE id = $1`,
      [oppId],
    );
    const days = (rows.rows[0].next_action_at.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(NEXT_ACTION_DAYS);
  });

  /**
   * The issue's own reasoning, corrected. It said an inbound kind should
   * schedule nothing "because a reply means act now" — but null IS the
   * drifting predicate, so that files the hottest lead in the queue with the
   * 121-day-old ones. Due now is what "act now" spells.
   */
  it("puts a lead that replied straight into Due, not back into Drifting", async () => {
    const orgId = await seedOrganisation("They Replied");
    const oppId = await seedDriftingOpportunity(orgId);

    const result = await addActivity({ organisationId: orgId, kind: "dm_received" });

    expect(result).toEqual({ ok: true });
    expect(await dueIds()).toContain(oppId);
    expect(await driftingIds()).not.toContain(oppId);
  });

  it("leaves a note-only organisation exactly where it was", async () => {
    const orgId = await seedOrganisation("Still Quiet");
    const oppId = await seedDriftingOpportunity(orgId);

    await addActivity({ organisationId: orgId, kind: "note", body: "looks promising" });

    expect(await driftingIds()).toContain(oppId);
    expect(await dueIds()).not.toContain(oppId);
  });
});
