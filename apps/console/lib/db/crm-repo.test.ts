import { describe, expect, it, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("./tesserix", () => ({
  tesserixQuery: (...args: unknown[]) => query(...args),
  isDatabaseConfigured: () => true,
}));

import { dueOpportunities, driftingOpportunities } from "./crm-repo";

beforeEach(() => query.mockReset());

describe("the queue", () => {
  it("asks only for opportunities whose next action has arrived", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities(50);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("next_action_at <= now()");
    // Terminal deals are done; surfacing them would make the queue a to-do
    // list of things already finished.
    expect(sql).toContain("stage NOT IN ('won', 'lost')");
  });

  it("treats drifting as no next action AND stale contact, not either", async () => {
    query.mockResolvedValue([]);
    await driftingOpportunities(14, 50);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("next_action_at IS NULL");
    expect(sql).toContain("last_contacted_at");
    // Guards the guard: an OR here would surface every scheduled lead as
    // drifting the moment it went quiet, which is the opposite of the point.
    expect(sql).not.toMatch(/next_action_at IS NULL\s+OR/i);
  });

  it("measures staleness from last contact, or from creation if never contacted", async () => {
    query.mockResolvedValue([]);
    await driftingOpportunities(14, 50);
    const [sql] = query.mock.calls[0];
    // NULL last_contacted_at means "never contacted", not "contacted at the
    // dawn of time". Without COALESCE(..., created_at), every freshly
    // imported lead (no next action, no contact yet) would be instantly
    // drifting, flooding the queue the moment an import finishes. A
    // never-contacted lead gets the same 14-day grace period, counted from
    // when it entered the system — not zero days.
    expect(sql).toContain("COALESCE(o.last_contacted_at, o.created_at)");
    // NULLS FIRST would float every never-contacted lead to the top
    // regardless of how recently it was created — the exact bug the
    // COALESCE fixes. It must not appear on the ordering.
    expect(sql).not.toMatch(/NULLS FIRST/i);
  });

  it("passes staleDays as a bind parameter used against the COALESCE, not last_contacted_at alone", async () => {
    // Pins the specific regression: comparing staleDays against bare
    // last_contacted_at would make every never-contacted row (NULL)
    // satisfy `NULL <= now() - interval` as unknown/false in SQL terms
    // inconsistently, OR (with the old explicit "IS NULL OR" clause) make
    // it unconditionally true — either way decoupled from staleDays. The
    // fix binds staleDays against a comparison that is well-defined for
    // every row: COALESCE(last_contacted_at, created_at). A freshly
    // created row (created_at = now()) fails `<= now() - 14 days`; a
    // long-untouched one (created_at long ago) passes it. Both flow
    // through the same single comparison, so this is what must not
    // regress back to a bare-column or unconditional check.
    //
    // make_interval(days => $1::int) over ($1 || ' days')::interval: typed,
    // rejects garbage at parse time rather than at the database.
    query.mockResolvedValue([]);
    await driftingOpportunities(14, 50);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([14, 50]);
    expect(sql).toMatch(
      /COALESCE\(o\.last_contacted_at, o\.created_at\)\s*\n?\s*<= now\(\) - make_interval\(days => \$1::int\)/,
    );
  });

  it("normalises timestamps to ISO strings", async () => {
    query.mockResolvedValue([{
      id: "o1", organisation_id: "g1", organisation_name: "Bondi Baker",
      product: null, stage: "contacted", owner: "ava@tesserix.app",
      next_action_at: new Date("2026-08-01T09:00:00Z"), next_action_note: "call back",
      last_contacted_at: null,
      quiet_since: new Date("2026-07-20T00:00:00Z"),
      is_starred: false,
    }]);
    const [row] = await dueOpportunities(50);
    expect(row.nextActionAt).toBe("2026-08-01T09:00:00.000Z");
    expect(row.lastContactedAt).toBeNull();
    expect(row.quietSince).toBe("2026-07-20T00:00:00.000Z");
  });

  it("selects quiet_since (COALESCE) as its own column, not last_contacted_at alone", async () => {
    // Ruling 10: exposing raw created_at would let a consumer recompute the
    // COALESCE in TypeScript, putting the business rule in two places that
    // can disagree. The SQL must alias the COALESCE itself as quiet_since,
    // for both queries, so the rule stays in one place.
    query.mockResolvedValue([]);
    await dueOpportunities(50);
    const [dueSql] = query.mock.calls[0];
    expect(dueSql).toContain(
      "COALESCE(o.last_contacted_at, o.created_at) AS quiet_since",
    );

    query.mockResolvedValue([]);
    await driftingOpportunities(14, 50);
    const [driftingSql] = query.mock.calls[1];
    expect(driftingSql).toContain(
      "COALESCE(o.last_contacted_at, o.created_at) AS quiet_since",
    );
  });
});
