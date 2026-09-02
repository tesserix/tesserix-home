import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #245 — the drift clock, against a real Postgres (pglite).
 *
 * `logActivity` is the only writer of `crm_opportunities.last_contacted_at`,
 * and the drifting queue is the only reader. The mocked unit tests
 * (crm-repo.test.ts) assert the SQL's *shape*; only a real database says
 * which ROWS that predicate selects — and "every open deal, no terminal one"
 * is a claim about rows, not about text. The queue test at the bottom closes
 * the loop the bug actually lived in: an organisation sitting in Drifting
 * leaves it once contact is logged.
 *
 * The `tesserix` mock mirrors crm-repo.write.integration.test.ts: `tesserixTx`
 * delegates to the real `runTesserixTx`, so what runs here is the shipped
 * BEGIN/COMMIT/ROLLBACK logic against a client pglite structurally satisfies,
 * not a reimplementation of it.
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

const { logActivity, dueOpportunities, driftingOpportunities, SuppressedContactError } =
  await import("./crm-repo");

const { NEXT_ACTION_DAYS } = await import("../crm");

const MIGRATIONS = ["0019_crm_schema.sql", "0022_crm_suppressions_normalize.sql"];

let db: PGlite;

/** Every migration this file's tables need, applied to a fresh database.
 *  Per-test rather than per-file: the clock assertions below all read
 *  "is this timestamp still null?", which only means anything on rows no
 *  earlier test has already touched. */
beforeEach(async () => {
  db = new PGlite();
  dbHolder.db = db;
  for (const file of MIGRATIONS) {
    const migration = path.resolve(__dirname, "../../../web/db/migrations", file);
    await db.exec(readFileSync(migration, "utf-8"));
  }
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

interface SeedOpportunity {
  stage: string;
  product?: string | null;
  createdAt?: string;
}

async function seedOpportunity(
  organisationId: string,
  { stage, product = null, createdAt }: SeedOpportunity,
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, stage, product, created_at)
     VALUES ($1, $2::crm_stage, $3, COALESCE($4::timestamptz, now())) RETURNING id`,
    [organisationId, stage, product, createdAt ?? null],
  );
  return rows.rows[0].id;
}

/**
 * A row in the state migration 0021 grandfathered: past `contacted` with no
 * product. It cannot be inserted while the CHECK is on, which is precisely why
 * these rows only exist in production at all — 0020 dropped the constraint,
 * the lead backfill loaded them, and 0021 put it back NOT VALID so the
 * existing rows were never scanned. Dropping and re-adding it around the
 * insert reproduces that history rather than simulating its result.
 */
async function seedGrandfathered(organisationId: string, stage: string): Promise<string> {
  await db.exec(
    `ALTER TABLE crm_opportunities DROP CONSTRAINT crm_opp_product_required_when_qualified`,
  );
  const id = await seedOpportunity(organisationId, { stage, product: null });
  await db.exec(
    `ALTER TABLE crm_opportunities
       ADD CONSTRAINT crm_opp_product_required_when_qualified CHECK (
         stage IN ('new', 'contacted') OR product IS NOT NULL
       ) NOT VALID`,
  );
  return id;
}

async function lastContactedAt(opportunityId: string): Promise<Date | null> {
  const rows = await db.query<{ last_contacted_at: Date | null }>(
    `SELECT last_contacted_at FROM crm_opportunities WHERE id = $1`,
    [opportunityId],
  );
  return rows.rows[0].last_contacted_at;
}

async function nextActionAt(opportunityId: string): Promise<Date | null> {
  const rows = await db.query<{ next_action_at: Date | null }>(
    `SELECT next_action_at FROM crm_opportunities WHERE id = $1`,
    [opportunityId],
  );
  return rows.rows[0].next_action_at;
}

/** How many days from now the next action sits, to one decimal. Days rather
 *  than an instant because the statement uses the database's `now()` and the
 *  test uses the process's, and the two are milliseconds apart. */
async function daysUntilNextAction(opportunityId: string): Promise<number> {
  const at = await nextActionAt(opportunityId);
  if (at === null) throw new Error("next_action_at is null");
  return Math.round(((at.getTime() - Date.now()) / (24 * 60 * 60 * 1000)) * 10) / 10;
}

async function setNextActionAt(opportunityId: string, at: Date): Promise<void> {
  await db.query(`UPDATE crm_opportunities SET next_action_at = $2 WHERE id = $1`, [
    opportunityId,
    at.toISOString(),
  ]);
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function activityCount(organisationId: string): Promise<number> {
  const rows = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM crm_activities WHERE organisation_id = $1`,
    [organisationId],
  );
  return Number(rows.rows[0].count);
}

describe("an organisation-level contact event and the drift clock", () => {
  it("advances every open opportunity and no terminal one", async () => {
    const orgId = await seedOrganisation("Bondi Baker");
    const open = {
      fresh: await seedOpportunity(orgId, { stage: "new" }),
      contacted: await seedOpportunity(orgId, { stage: "contacted" }),
      qualified: await seedOpportunity(orgId, { stage: "qualified", product: "mark8ly" }),
    };
    const terminal = {
      won: await seedOpportunity(orgId, { stage: "won", product: "mark8ly" }),
      lost: await seedOpportunity(orgId, { stage: "lost", product: "mark8ly" }),
    };

    await logActivity({ organisationId: orgId, kind: "call", actor: "ava" });

    for (const [name, id] of Object.entries(open)) {
      expect(await lastContactedAt(id), `open opportunity: ${name}`).not.toBeNull();
    }
    // The other half, and the half a shape assertion cannot make: a won or
    // lost deal's clock is not the operator's business any more, and a test
    // that only checked the open rows would pass while these moved too.
    for (const [name, id] of Object.entries(terminal)) {
      expect(await lastContactedAt(id), `terminal opportunity: ${name}`).toBeNull();
    }
  });

  it("advances nothing for a note — recording a thought is not contact", async () => {
    const orgId = await seedOrganisation("Bondi Baker");
    const oppId = await seedOpportunity(orgId, { stage: "new" });

    await logActivity({ organisationId: orgId, kind: "note", actor: "ava", body: "a thought" });

    expect(await lastContactedAt(oppId)).toBeNull();
    expect(await activityCount(orgId)).toBe(1);
  });

  it("records the contact against an organisation that has no opportunities at all", async () => {
    const orgId = await seedOrganisation("No Deals Yet");

    await expect(
      logActivity({ organisationId: orgId, kind: "call", actor: "ava", body: "cold call" }),
    ).resolves.toBeUndefined();

    expect(await activityCount(orgId)).toBe(1);
  });

  // Migration 0021's CHECK is evaluated on the new row version of EVERY
  // update, including a bare clock bump — so a grandfathered deal (qualified,
  // product NULL) would reject the organisation-level UPDATE and, in one
  // transaction, take the activity row down with it. The operator named no
  // deal; refusing to record that they called the business, because an
  // unrelated deal is missing a product, is the wrong trade. The predicate
  // therefore skips exactly the rows the CHECK would reject, and those rows
  // stay in Drifting until someone supplies the product `setNextAction`
  // already asks for.
  it("skips a grandfathered deal rather than failing the whole log", async () => {
    const orgId = await seedOrganisation("Migrated Co");
    const grandfathered = await seedGrandfathered(orgId, "qualified");
    const healthy = await seedOpportunity(orgId, { stage: "new" });

    await logActivity({ organisationId: orgId, kind: "dm_sent", actor: "ava" });

    expect(await activityCount(orgId)).toBe(1);
    expect(await lastContactedAt(healthy)).not.toBeNull();
    expect(await lastContactedAt(grandfathered)).toBeNull();
  });
});

/**
 * The same trap, down the branch that never got the guard.
 *
 * `advanceContactClock` has two of them, and until now only the
 * organisation-wide one excluded the rows migration 0021's CHECK rejects. The
 * by-id branch ran a bare `WHERE id = $1`, so naming a grandfathered deal —
 * something the Opportunities tab does routinely — re-evaluated the CHECK
 * against the new row, failed, and rolled back the `crm_activities` insert
 * sitting in the same transaction. The operator lost the record of a call
 * because an unrelated column is null.
 *
 * Only a real database can show this: the mocked tests assert the SQL's shape,
 * and the shape of the broken statement was perfectly reasonable. It is the
 * CHECK firing on an UPDATE that touches neither `stage` nor `product` that
 * makes it a bug, and that is a fact about Postgres, not about the string.
 */
describe("a contact event that names one deal", () => {
  it("records a call against a grandfathered deal instead of aborting on 0021's CHECK", async () => {
    const orgId = await seedOrganisation("Migrated Co");
    const grandfathered = await seedGrandfathered(orgId, "qualified");

    await expect(
      logActivity({
        organisationId: orgId,
        opportunityId: grandfathered,
        kind: "call",
        actor: "ava",
        body: "spoke to Ana",
      }),
    ).resolves.toBeUndefined();

    // The activity survived, which is the whole point — and the clock did not
    // move, because moving it is the thing the CHECK will not allow.
    expect(await activityCount(orgId)).toBe(1);
    expect(await lastContactedAt(grandfathered)).toBeNull();
  });

  it("still moves the clock for a healthy deal named by id", async () => {
    const orgId = await seedOrganisation("Bondi Baker");
    const oppId = await seedOpportunity(orgId, { stage: "qualified", product: "mark8ly" });

    await logActivity({ organisationId: orgId, opportunityId: oppId, kind: "call", actor: "ava" });

    expect(await lastContactedAt(oppId)).not.toBeNull();
  });

  // The guard the by-id branch gained is the organisation-wide one verbatim,
  // and that one excludes terminal deals as well. Naming a won deal explicitly
  // does not make it live again: the drift clock says "nobody has touched this
  // lately", which is not a question a closed deal answers.
  it("leaves a won deal's clock alone even when the operator names it", async () => {
    const orgId = await seedOrganisation("Closed Co");
    const oppId = await seedOpportunity(orgId, { stage: "won", product: "mark8ly" });

    await logActivity({ organisationId: orgId, opportunityId: oppId, kind: "call", actor: "ava" });

    expect(await activityCount(orgId)).toBe(1);
    expect(await lastContactedAt(oppId)).toBeNull();
  });
});

describe("the do-not-contact list, now that outbound kinds are reachable", () => {
  async function seedSuppressedOrganisation(): Promise<{ orgId: string; oppId: string }> {
    const orgId = await seedOrganisation("Asked Us To Stop");
    await db.query(
      `INSERT INTO crm_contacts (organisation_id, email) VALUES ($1, $2)`,
      [orgId, "gone@example.com"],
    );
    await db.query(
      `INSERT INTO crm_suppressions (email, reason, created_by) VALUES ($1, $2, $3)`,
      ["gone@example.com", "asked to stop", "ava"],
    );
    const oppId = await seedOpportunity(orgId, { stage: "new" });
    return { orgId, oppId };
  }

  it("refuses outbound contact and writes nothing at all — no activity, no clock bump", async () => {
    const { orgId, oppId } = await seedSuppressedOrganisation();

    await expect(
      logActivity({ organisationId: orgId, kind: "email_sent", actor: "ava", body: "hello" }),
    ).rejects.toBeInstanceOf(SuppressedContactError);

    expect(await activityCount(orgId)).toBe(0);
    expect(await lastContactedAt(oppId)).toBeNull();
  });

  it("still records an inbound message, and still moves the clock for it", async () => {
    const { orgId, oppId } = await seedSuppressedOrganisation();

    await logActivity({ organisationId: orgId, kind: "email_received", actor: "ava" });

    expect(await activityCount(orgId)).toBe(1);
    expect(await lastContactedAt(oppId)).not.toBeNull();
  });
});

/**
 * The bug itself, stated as a test. Before the fix this could not pass: the
 * console had no way to write `last_contacted_at`, so an organisation entered
 * Drifting 14 days after import and never left, however much outreach was
 * logged against it. That is the production state #245 describes — 259
 * organisations, all Drifting.
 */
describe("Drifting, end to end", () => {
  const DRIFT_DAYS = 14;

  async function driftingIds(): Promise<string[]> {
    const page = await driftingOpportunities({}, DRIFT_DAYS, 50);
    return page.rows.map((row) => row.id);
  }

  it("an organisation leaves the queue once a contact event is logged", async () => {
    const orgId = await seedOrganisation("Quiet Since May");
    const oppId = await seedOpportunity(orgId, {
      stage: "new",
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(await driftingIds()).toContain(oppId);

    await logActivity({ organisationId: orgId, kind: "call", actor: "ava", body: "spoke to Ana" });

    expect(await driftingIds()).not.toContain(oppId);
  });

  it("a note leaves it exactly where it was — the queue still means what it says", async () => {
    const orgId = await seedOrganisation("Still Quiet");
    const oppId = await seedOpportunity(orgId, {
      stage: "new",
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    await logActivity({ organisationId: orgId, kind: "note", actor: "ava", body: "looks promising" });

    expect(await driftingIds()).toContain(oppId);
  });
});

/**
 * #502 — the follow-up clock, and why `last_contacted_at` alone was not the fix.
 *
 * `crm_opp_due_idx` and `crm_opp_drifting_idx` split the same rows on
 * `next_action_at IS NOT NULL` versus `IS NULL`. Nothing in the application
 * wrote that column when an activity was logged, so contacting a lead moved
 * only the drift clock and left it satisfying the DRIFTING predicate — Due
 * empty, Drifting holding all 259, each one reading "waiting 121d". These are
 * row-level claims about a partial-index predicate, so they are made against a
 * real Postgres; the mocked tests can only see the SQL's shape.
 */
describe("the follow-up clock", () => {
  it("schedules a chase NEXT_ACTION_DAYS out when a DM goes out", async () => {
    const orgId = await seedOrganisation("Bondi Baker");
    const oppId = await seedOpportunity(orgId, { stage: "new" });

    await logActivity({ organisationId: orgId, kind: "dm_sent", actor: "ava" });

    expect(await daysUntilNextAction(oppId)).toBe(NEXT_ACTION_DAYS);
  });

  it("does the same for an email", async () => {
    const orgId = await seedOrganisation("Bondi Baker");
    const oppId = await seedOpportunity(orgId, { stage: "new" });

    await logActivity({ organisationId: orgId, kind: "email_sent", actor: "ava" });

    expect(await daysUntilNextAction(oppId)).toBe(NEXT_ACTION_DAYS);
  });

  // The decision on `call`, asserted rather than left to the reader. It is the
  // ambiguous kind — there is no `call_received` — and it is treated as
  // outbound, for the reasons `OUTBOUND_ACTIVITY_KINDS` (lib/crm.ts) gives.
  // If that judgement is ever revisited, this is the test that has to change
  // with it, which is the point of asserting it either way.
  it("treats a call as outbound and schedules a chase for it too", async () => {
    const orgId = await seedOrganisation("Bondi Baker");
    const oppId = await seedOpportunity(orgId, { stage: "new" });

    await logActivity({ organisationId: orgId, kind: "call", actor: "ava" });

    expect(await daysUntilNextAction(oppId)).toBe(NEXT_ACTION_DAYS);
  });

  /**
   * The correction to the issue as filed, which said a reply "shouldn't
   * schedule anything, because it means act now".
   *
   * Null is not "act now" — it is the literal drifting predicate, so leaving a
   * reply unscheduled files the hottest lead in the queue alongside the ones
   * nobody has touched since May. The assertion is deliberately made on the
   * QUEUE and not only on the column: `not.toBeNull()` would also pass for a
   * date a year out, and being in Due is the thing that was wanted.
   */
  it("makes a reply due now, not null — a reply is the moment to act", async () => {
    const orgId = await seedOrganisation("They Replied");
    const oppId = await seedOpportunity(orgId, { stage: "contacted" });

    await logActivity({ organisationId: orgId, kind: "dm_received", actor: "ava" });

    expect(await nextActionAt(oppId)).not.toBeNull();
    const due = await dueOpportunities({}, 50);
    expect(due.rows.map((row) => row.id)).toContain(oppId);
  });

  it("does the same for an inbound email", async () => {
    const orgId = await seedOrganisation("They Replied");
    const oppId = await seedOpportunity(orgId, { stage: "contacted" });

    await logActivity({ organisationId: orgId, kind: "email_received", actor: "ava" });

    const due = await dueOpportunities({}, 50);
    expect(due.rows.map((row) => row.id)).toContain(oppId);
  });

  it("leaves next_action_at alone for a note — nobody was contacted", async () => {
    const orgId = await seedOrganisation("Still Quiet");
    const oppId = await seedOpportunity(orgId, { stage: "new" });

    await logActivity({ organisationId: orgId, kind: "note", actor: "ava", body: "a thought" });

    expect(await nextActionAt(oppId)).toBeNull();
  });

  it("schedules against a deal named by id, not only organisation-wide", async () => {
    const orgId = await seedOrganisation("Bondi Baker");
    const oppId = await seedOpportunity(orgId, { stage: "new" });

    await logActivity({ organisationId: orgId, opportunityId: oppId, kind: "dm_sent", actor: "ava" });

    expect(await daysUntilNextAction(oppId)).toBe(NEXT_ACTION_DAYS);
  });
});

/**
 * A DEFAULT, NOT A RULE (issue #502's first "thing to keep").
 *
 * The schedule fills a gap and refreshes a stale date. It does not overwrite a
 * decision the operator has already made about a moment that has not arrived
 * yet — "check back in a month" must survive somebody logging a DM today, or
 * the field is not editable in any way that lasts.
 */
describe("the operator's own date", () => {
  it("survives an outbound log — a future date is a decision, not a gap", async () => {
    const orgId = await seedOrganisation("Check Back In A Month");
    const oppId = await seedOpportunity(orgId, { stage: "contacted" });
    const chosen = daysFromNow(30);
    await setNextActionAt(oppId, chosen);

    await logActivity({ organisationId: orgId, kind: "dm_sent", actor: "ava" });

    expect(await daysUntilNextAction(oppId)).toBe(30);
    // And the contact itself still registered — respecting the date is not
    // the same as declining to record the DM.
    expect(await lastContactedAt(oppId)).not.toBeNull();
  });

  /**
   * The other half, and the reason this is a `CASE` rather than a COALESCE.
   *
   * An overdue date describes an action that was owed and, on the evidence of
   * this activity, has now been taken. Preserving it would pin the lead at the
   * top of Due for ever: working a lead could never take it off the list, which
   * is the same "no list to work tomorrow" failure from the other direction.
   */
  it("is refreshed by an outbound log once it has passed", async () => {
    const orgId = await seedOrganisation("Overdue Co");
    const oppId = await seedOpportunity(orgId, { stage: "contacted" });
    await setNextActionAt(oppId, daysFromNow(-9));

    await logActivity({ organisationId: orgId, kind: "dm_sent", actor: "ava" });

    expect(await daysUntilNextAction(oppId)).toBe(NEXT_ACTION_DAYS);
    expect(await dueOpportunities({}, 50).then((p) => p.rows.map((r) => r.id))).not.toContain(oppId);
  });

  it("is pulled forward to now by a reply — that is what a reply is for", async () => {
    const orgId = await seedOrganisation("They Replied Early");
    const oppId = await seedOpportunity(orgId, { stage: "contacted" });
    await setNextActionAt(oppId, daysFromNow(30));

    await logActivity({ organisationId: orgId, kind: "dm_received", actor: "ava" });

    expect(await dueOpportunities({}, 50).then((p) => p.rows.map((r) => r.id))).toContain(oppId);
  });

  // Inbound only ever pulls EARLIER. A reply arriving against a chase that was
  // already nine days late does not make it less late, and resetting it to
  // `now()` would push it down a queue sorted by next_action_at — quietly
  // demoting the most neglected lead in the list at the moment it answered.
  it("is left overdue by a reply, rather than reset to now", async () => {
    const orgId = await seedOrganisation("Late And Replied");
    const oppId = await seedOpportunity(orgId, { stage: "contacted" });
    await setNextActionAt(oppId, daysFromNow(-9));

    await logActivity({ organisationId: orgId, kind: "email_received", actor: "ava" });

    expect(await daysUntilNextAction(oppId)).toBe(-9);
  });
});
