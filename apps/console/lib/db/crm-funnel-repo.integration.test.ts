import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for `crm-funnel-repo.ts` against a real Postgres
 * (pglite).
 *
 * A real database is not optional here, and the unit suite beside this file
 * says why it is not sufficient: that one asserts the SQL contains
 * `voided_at IS NULL` and a `COALESCE`, which proves the text was written,
 * not that Postgres agrees about what it means. The two claims worth paying
 * a database for are:
 *
 *   - a deal that has never changed stage still reports a time in stage, via
 *     the `COALESCE` to `created_at` — the shape of EVERY production
 *     opportunity today, so a funnel that got this wrong would be empty
 *     exactly when it is first looked at; and
 *   - a voided deal is in neither number, which is the #251 claim the whole
 *     panel's honesty rests on.
 *
 * `tesserixQuery` is delegated to pglite rather than stubbed: what makes this
 * a real test is that the shipped statements are the ones executed.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../web/db/migrations");

function readMigration(filename: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, filename), "utf-8");
}

const dbHolder = vi.hoisted(() => ({ db: undefined as PGlite | undefined }));

vi.mock("./tesserix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tesserix")>();
  return {
    ...actual,
    tesserixQuery: async (sql: string, params: readonly unknown[] = []) => {
      const result = await dbHolder.db!.query(sql, params as unknown[]);
      return result.rows;
    },
    isDatabaseConfigured: () => true,
  };
});

const { funnelSummary } = await import("./crm-funnel-repo");

let db: PGlite;
let orgId: string;

function countOf(summary: Awaited<ReturnType<typeof funnelSummary>>, stage: string): number {
  return summary.counts.find((entry) => entry.stage === stage)?.count ?? -1;
}

async function insertOpportunity(
  stage: string,
  product: string | null,
  createdAt?: string,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, stage, product, created_at)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now())) RETURNING id`,
    [orgId, stage, product, createdAt ?? null],
  );
  return result.rows[0].id;
}

async function recordStageChange(opportunityId: string, occurredAt: string): Promise<void> {
  await db.query(
    `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body, metadata, occurred_at)
     VALUES ($1, $2, 'stage_change', 'ops@tesserix.app', 'new → contacted',
             '{"from":"new","to":"contacted"}'::jsonb, $3::timestamptz)`,
    [orgId, opportunityId, occurredAt],
  );
}

beforeAll(async () => {
  db = new PGlite();
  dbHolder.db = db;
  await db.exec(readMigration("0019_crm_schema.sql"));
  await db.exec(readMigration("0049_crm_opportunities_voided.sql"));
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`DELETE FROM crm_activities; DELETE FROM crm_opportunities; DELETE FROM crm_organisations;`);
  const org = await db.query<{ id: string }>(
    `INSERT INTO crm_organisations (name) VALUES ('Stalled Co') RETURNING id`,
  );
  orgId = org.rows[0].id;
});

describe("funnelSummary against a real database", () => {
  it("counts every stage, and answers zero for the stages with no deals", async () => {
    await insertOpportunity("new", null);
    await insertOpportunity("new", null);
    await insertOpportunity("won", "mark8ly");

    const summary = await funnelSummary();

    expect(countOf(summary, "new")).toBe(2);
    expect(countOf(summary, "won")).toBe(1);
    expect(countOf(summary, "contacted")).toBe(0);
    expect(countOf(summary, "qualified")).toBe(0);
    expect(countOf(summary, "lost")).toBe(0);
    expect(summary.total).toBe(3);
  });

  it("dates a deal that has never changed stage from its creation", async () => {
    // The shape of every production opportunity today. A measure defined
    // purely over transitions would report nothing at all for this row.
    await insertOpportunity("new", null, "2026-06-01T00:00:00Z");

    const summary = await funnelSummary();

    expect(summary.stalled).toHaveLength(1);
    expect(summary.stalled[0].since.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("dates a deal that HAS moved from its most recent stage change, not its creation", async () => {
    const id = await insertOpportunity("contacted", null, "2026-01-01T00:00:00Z");
    await recordStageChange(id, "2026-03-01T00:00:00Z");
    await recordStageChange(id, "2026-08-01T00:00:00Z");

    const summary = await funnelSummary();

    expect(summary.stalled[0].since.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("ignores activity kinds that are not a stage change", async () => {
    const id = await insertOpportunity("contacted", null, "2026-01-01T00:00:00Z");
    await db.query(
      `INSERT INTO crm_activities (organisation_id, opportunity_id, kind, actor, body, occurred_at)
       VALUES ($1, $2, 'note', 'ops@tesserix.app', 'called them', '2026-09-01T00:00:00Z')`,
      [orgId, id],
    );

    const summary = await funnelSummary();

    // A note is contact, not movement. The deal has been in `contacted`
    // since it was created, and saying otherwise would read "recently moved"
    // for a deal that has not moved at all.
    expect(summary.stalled[0].since.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("orders the stalled list oldest first", async () => {
    await insertOpportunity("new", null, "2026-05-01T00:00:00Z");
    await insertOpportunity("new", null, "2026-02-01T00:00:00Z");
    await insertOpportunity("new", null, "2026-08-01T00:00:00Z");

    const summary = await funnelSummary();

    expect(summary.stalled.map((row) => row.since.toISOString())).toEqual([
      "2026-02-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
  });

  it("keeps a voided deal out of the counts and out of the stalled list", async () => {
    const live = await insertOpportunity("new", null);
    const voided = await insertOpportunity("new", null);
    await db.query(
      `UPDATE crm_opportunities SET voided_at = now(), voided_reason = 'duplicate' WHERE id = $1`,
      [voided],
    );

    const summary = await funnelSummary();

    expect(countOf(summary, "new")).toBe(1);
    expect(summary.total).toBe(1);
    expect(summary.stalled.map((row) => row.id)).toEqual([live]);
  });

  it("keeps a voided WON deal out of the counts, which is the close-rate pollution #251 exists to remove", async () => {
    await insertOpportunity("won", "mark8ly");
    const duplicate = await insertOpportunity("won", "mark8ly");
    await db.query(
      `UPDATE crm_opportunities SET voided_at = now(), voided_reason = 'duplicate' WHERE id = $1`,
      [duplicate],
    );

    const summary = await funnelSummary();

    expect(countOf(summary, "won")).toBe(1);
  });

  it("lists no terminal deal among the stalled, however long it has sat there", async () => {
    await insertOpportunity("won", "mark8ly", "2020-01-01T00:00:00Z");
    await insertOpportunity("lost", "mark8ly", "2020-01-01T00:00:00Z");
    await insertOpportunity("new", null, "2026-09-01T00:00:00Z");

    const summary = await funnelSummary();

    expect(summary.stalled.map((row) => row.stage)).toEqual(["new"]);
  });

  it("carries the organisation's name and the deal's owner", async () => {
    await db.query(
      `INSERT INTO crm_opportunities (organisation_id, stage, owner, product)
       VALUES ($1, 'contacted', 'Priya', NULL)`,
      [orgId],
    );

    const summary = await funnelSummary();

    expect(summary.stalled[0]).toMatchObject({
      organisationId: orgId,
      organisationName: "Stalled Co",
      owner: "Priya",
      product: null,
    });
  });
});
