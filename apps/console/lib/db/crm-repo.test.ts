import { describe, expect, it, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("./tesserix", () => ({
  tesserixQuery: (...args: unknown[]) => query(...args),
  // `tesserixTx` hands its callback a query function scoped to one client.
  // The mock has no notion of a separate client — every call, transactional
  // or not, funnels through the same `query` spy, so a test can assert on
  // the full sequence of statements (SELECT, UPDATE, INSERT) a transactional
  // write issues, in order, exactly like it does for a plain read.
  tesserixTx: (fn: (query: (...args: unknown[]) => unknown) => unknown) => fn(query),
  isDatabaseConfigured: () => true,
}));

import {
  dueOpportunities,
  driftingOpportunities,
  advanceStage,
  setNextAction,
  logActivity,
  organisationDetail,
  MissingProductError,
} from "./crm-repo";

beforeEach(() => {
  query.mockReset();
  // A plausible default current-row for the write tests below: a real
  // organisation_id/product pair, stage "contacted" (product not required).
  // Tests that care about a specific current stage override with
  // `mockResolvedValueOnce` before calling in.
  query.mockResolvedValue([
    { stage: "contacted", organisation_id: "g1", product: null },
  ]);
});

describe("the queue", () => {
  it("asks only for opportunities whose next action has arrived", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({}, 50);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("next_action_at <= now()");
    // Terminal deals are done; surfacing them would make the queue a to-do
    // list of things already finished.
    expect(sql).toContain("stage NOT IN ('won', 'lost')");
  });

  it("treats drifting as no next action AND stale contact, not either", async () => {
    query.mockResolvedValue([]);
    await driftingOpportunities({}, 14, 50);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("next_action_at IS NULL");
    expect(sql).toContain("last_contacted_at");
    // Guards the guard: an OR here would surface every scheduled lead as
    // drifting the moment it went quiet, which is the opposite of the point.
    expect(sql).not.toMatch(/next_action_at IS NULL\s+OR/i);
  });

  it("measures staleness from last contact, or from creation if never contacted", async () => {
    query.mockResolvedValue([]);
    await driftingOpportunities({}, 14, 50);
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
    await driftingOpportunities({}, 14, 50);
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
    const [row] = await dueOpportunities({}, 50);
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
    await dueOpportunities({}, 50);
    const [dueSql] = query.mock.calls[0];
    expect(dueSql).toContain(
      "COALESCE(o.last_contacted_at, o.created_at) AS quiet_since",
    );

    query.mockResolvedValue([]);
    await driftingOpportunities({}, 14, 50);
    const [driftingSql] = query.mock.calls[1];
    expect(driftingSql).toContain(
      "COALESCE(o.last_contacted_at, o.created_at) AS quiet_since",
    );
  });
});

describe("the queue's filters — bound parameters, not string interpolation", () => {
  it("adds no clause and no extra param when no filter is active", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({}, 50);
    const [sql, params] = query.mock.calls[0];
    // `o.owner` legitimately appears in the SELECT list; only the WHERE-clause
    // forms (`o.product =`, `o.owner ILIKE`) indicate an active filter.
    expect(sql).not.toMatch(/o\.product\s*=/);
    expect(sql).not.toMatch(/o\.owner ILIKE/);
    expect(params).toEqual([50]);
  });

  it("binds product as a parameter, not interpolated into the SQL text", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ product: "mark8ly" }, 50);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("o.product = $1");
    expect(sql).not.toContain("mark8ly");
    expect(params).toEqual(["mark8ly", 50]);
  });

  it("binds stage as a parameter", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ stage: "qualified" }, 50);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("o.stage = $1");
    expect(sql).not.toContain("'qualified'");
    expect(params).toEqual(["qualified", 50]);
  });

  it("binds owner as a parameter, matched case-insensitively", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ owner: "Asha" }, 50);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("o.owner ILIKE $1");
    expect(sql).toContain("ESCAPE '\\'");
    expect(sql).not.toContain("Asha");
    expect(params).toEqual(["%Asha%", 50]);
  });

  it("escapes LIKE metacharacters in the owner value rather than passing them through as wildcards", async () => {
    // Bound parameter, so this was never SQL injection — but an unescaped
    // "%" or "_" in the value acts as a LIKE wildcard rather than a literal
    // character, which is a silently wrong filter (an owner of exactly "%"
    // would match every row with a non-null owner). Only the value's own
    // `%`/`_`/`\` are escaped; the wrapping `%...%` that makes this a
    // substring search stays literal wildcards.
    query.mockResolvedValue([]);
    await dueOpportunities({ owner: "100%_done\\now" }, 50);
    const [, params] = query.mock.calls[0];
    expect(params).toEqual(["%100\\%\\_done\\\\now%", 50]);
  });

  it("combines all three filters, each its own bound parameter, before ORDER BY/LIMIT", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ product: "mark8ly", stage: "qualified", owner: "Asha" }, 50);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("o.product = $1");
    expect(sql).toContain("o.stage = $2");
    expect(sql).toContain("o.owner ILIKE $3");
    expect(sql.indexOf("o.owner ILIKE")).toBeLessThan(sql.indexOf("ORDER BY"));
    expect(params).toEqual(["mark8ly", "qualified", "%Asha%", 50]);
  });

  it("keeps the due predicate first so the partial index stays usable", async () => {
    query.mockResolvedValue([]);
    await dueOpportunities({ product: "mark8ly" }, 50);
    const [sql] = query.mock.calls[0];
    expect(sql.indexOf("next_action_at <= now()")).toBeLessThan(sql.indexOf("o.product ="));
  });

  it("binds product, stage, owner and staleDays as separate parameters on the drifting query", async () => {
    query.mockResolvedValue([]);
    await driftingOpportunities({ product: "mark8ly", stage: "new", owner: "Asha" }, 14, 50);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("o.product = $1");
    expect(sql).toContain("o.stage = $2");
    expect(sql).toContain("o.owner ILIKE $3");
    expect(sql).toContain("make_interval(days => $4::int)");
    expect(sql).toContain("LIMIT $5");
    expect(params).toEqual(["mark8ly", "new", "%Asha%", 14, 50]);
  });

  it("keeps the drifting partial-index predicates first, filters appended after", async () => {
    query.mockResolvedValue([]);
    await driftingOpportunities({ product: "mark8ly" }, 14, 50);
    const [sql] = query.mock.calls[0];
    expect(sql.indexOf("next_action_at IS NULL")).toBeLessThan(sql.indexOf("o.product ="));
    expect(sql.indexOf("stage NOT IN")).toBeLessThan(sql.indexOf("o.product ="));
  });
});

describe("advanceStage", () => {
  // Load-bearing: this is the ONLY record of when a stage was entered, and
  // therefore the only thing that makes funnel measurement possible later.
  // It cannot be reconstructed afterwards.
  it("writes a stage_change activity on every transition", async () => {
    query.mockResolvedValueOnce([
      { stage: "contacted", organisation_id: "g1", product: null },
    ]);
    const result = await advanceStage({
      opportunityId: "o1",
      to: "qualified",
      product: "mark8ly",
      actor: "ava",
    });
    const sqlText = query.mock.calls.map(([sql]) => sql).join("\n");
    expect(sqlText).toContain("INSERT INTO crm_activities");
    expect(sqlText).toContain("stage_change");
    expect(result).toEqual({ stageChanged: true, productChanged: true });
  });

  it("refuses to qualify without a product rather than guessing one", async () => {
    // No DB call happens at all — the guard runs before anything is read,
    // and any real row (grandfathered or not) is off the table either way.
    await expect(
      advanceStage({ opportunityId: "o1", to: "qualified", actor: "ava" }),
    ).rejects.toThrow(/product/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses to mark an opportunity lost without a reason", async () => {
    await expect(
      advanceStage({ opportunityId: "o1", to: "lost", product: "mark8ly", actor: "ava" }),
    ).rejects.toThrow(/reason/i);
    expect(query).not.toHaveBeenCalled();
  });

  // Guards the guard: a version that logged unconditionally would pass the
  // first test while filling the timeline with noise.
  it("does not write a stage_change when the stage is unchanged", async () => {
    query.mockResolvedValueOnce([
      { stage: "contacted", organisation_id: "g1", product: null },
    ]);
    const result = await advanceStage({ opportunityId: "o1", to: "contacted", actor: "ava" });
    const sqlText = query.mock.calls.map(([sql]) => sql).join("\n");
    expect(sqlText).not.toContain("stage_change");
    expect(sqlText).not.toMatch(/UPDATE crm_opportunities/);
    expect(result).toEqual({ stageChanged: false, productChanged: false });
  });

  it("sets closed_at when moving to won", async () => {
    query.mockResolvedValueOnce([
      { stage: "qualified", organisation_id: "g1", product: "mark8ly" },
    ]);
    await advanceStage({ opportunityId: "o1", to: "won", product: "mark8ly", actor: "ava" });
    const [updateSql] = query.mock.calls[1];
    expect(updateSql).toContain("closed_at = now()");
  });

  it("sets closed_at and lost_reason when moving to lost", async () => {
    query.mockResolvedValueOnce([
      { stage: "qualified", organisation_id: "g1", product: "mark8ly" },
    ]);
    await advanceStage({
      opportunityId: "o1",
      to: "lost",
      product: "mark8ly",
      lostReason: "went with a competitor",
      actor: "ava",
    });
    const [updateSql, updateParams] = query.mock.calls[1];
    expect(updateSql).toContain("closed_at = now()");
    expect(updateSql).toContain("lost_reason");
    expect(updateParams).toContain("went with a competitor");
  });

  // Ruling 14: leaving a terminal stage clears both fields — they describe
  // the stage being left, not baggage that survives a correction. Not
  // rejected: mis-marking a deal lost is ordinary human error, and this is
  // the fix for it, recorded honestly via the ordinary stage_change path.
  it("clears closed_at and lost_reason when leaving a terminal stage (Ruling 14)", async () => {
    query.mockResolvedValueOnce([
      { stage: "lost", organisation_id: "g1", product: "mark8ly" },
    ]);
    await advanceStage({
      opportunityId: "o1",
      to: "qualified",
      product: "mark8ly",
      actor: "ava",
    });
    const [updateSql, updateParams] = query.mock.calls[1];
    expect(updateSql).toContain("closed_at = NULL");
    expect(updateSql).toMatch(/lost_reason = \$\d/);
    expect(updateParams).toContain(null);
  });

  it("moving lost -> won clears lost_reason but still sets closed_at", async () => {
    query.mockResolvedValueOnce([
      { stage: "lost", organisation_id: "g1", product: "mark8ly" },
    ]);
    await advanceStage({
      opportunityId: "o1",
      to: "won",
      product: "mark8ly",
      actor: "ava",
    });
    const [updateSql, updateParams] = query.mock.calls[1];
    expect(updateSql).toContain("closed_at = now()");
    expect(updateParams).toContain(null); // lost_reason cleared
  });

  it("always sets updated_at, since crm_opportunities has no update trigger", async () => {
    query.mockResolvedValueOnce([
      { stage: "contacted", organisation_id: "g1", product: null },
    ]);
    await advanceStage({ opportunityId: "o1", to: "qualified", product: "mark8ly", actor: "ava" });
    const [updateSql] = query.mock.calls[1];
    expect(updateSql).toContain("updated_at = now()");
  });

  // The grandfathered-row constraint (migration 0021): a row already sitting
  // at qualified/won/lost with a null product is rewritten by ANY update,
  // including a same-stage one that only supplies the missing product. This
  // is how such a row gets unblocked — not a special case, just the ordinary
  // "product changed" path with no stage transition attached.
  it("lets a same-stage write through when it supplies the missing product, but logs no stage_change", async () => {
    query.mockResolvedValueOnce([
      { stage: "qualified", organisation_id: "g1", product: null },
    ]);
    const result = await advanceStage({
      opportunityId: "o1",
      to: "qualified",
      product: "mark8ly",
      actor: "ava",
    });
    const sqlText = query.mock.calls.map(([sql]) => sql).join("\n");
    expect(sqlText).toMatch(/UPDATE crm_opportunities/);
    expect(sqlText).not.toContain("stage_change");
    expect(result).toEqual({ stageChanged: false, productChanged: true });
  });

  // A product re-pointed underneath a live deal, with the stage untouched,
  // must still leave a trace — the whole reason this branch exists (an
  // audit row alone can't be read by anyone browsing the organisation's
  // timeline).
  it("logs an activity for a stage-unchanged product change, not tagged stage_change", async () => {
    query.mockResolvedValueOnce([
      { stage: "qualified", organisation_id: "g1", product: "kora" },
    ]);
    await advanceStage({
      opportunityId: "o1",
      to: "qualified",
      product: "mark8ly",
      actor: "ava",
    });
    const [activitySql, activityParams] = query.mock.calls[2];
    expect(activitySql).toContain("INSERT INTO crm_activities");
    expect(activitySql).toContain("'note'");
    expect(activitySql).not.toContain("stage_change");
    expect(activityParams).toContain("Product set to mark8ly (was kora)");
  });

  it("throws when the opportunity does not exist", async () => {
    query.mockResolvedValueOnce([]);
    await expect(
      advanceStage({ opportunityId: "missing", to: "contacted", actor: "ava" }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("setNextAction", () => {
  it("schedules a next action", async () => {
    query.mockResolvedValueOnce([
      { stage: "contacted", product: null },
    ]);
    await setNextAction({
      opportunityId: "o1",
      at: "2026-08-20T09:00:00.000Z",
      note: "call back",
      actor: "ava",
    });
    const [updateSql, updateParams] = query.mock.calls[1];
    expect(updateSql).toContain("next_action_at");
    expect(updateSql).toContain("updated_at = now()");
    expect(updateParams).toContain("2026-08-20T09:00:00.000Z");
  });

  // The grandfathered-row constraint again: `setNextAction` has no product
  // argument to offer, so a row that needs one and doesn't have one is
  // refused outright — a clear, typed error, not a raw constraint violation
  // from Postgres reaching the operator.
  it("refuses to touch a grandfathered row instead of letting Postgres reject the UPDATE", async () => {
    query.mockResolvedValueOnce([
      { stage: "qualified", product: null },
    ]);
    await expect(
      setNextAction({ opportunityId: "o1", at: null, note: null, actor: "ava" }),
    ).rejects.toBeInstanceOf(MissingProductError);
    // Only the SELECT ran; the UPDATE that would trip the CHECK never did.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("allows a grandfathered row once it already carries a product", async () => {
    query.mockResolvedValueOnce([
      { stage: "won", product: "mark8ly" },
    ]);
    await setNextAction({ opportunityId: "o1", at: null, note: null, actor: "ava" });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("logActivity", () => {
  it("inserts a note without touching crm_opportunities", async () => {
    query.mockResolvedValueOnce([]);
    await logActivity({
      organisationId: "g1",
      opportunityId: "o1",
      kind: "note",
      actor: "ava",
      body: "left a voicemail",
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO crm_activities");
    expect(params).toContain("left a voicemail");
  });

  it("allows a note with no opportunity yet", async () => {
    query.mockResolvedValueOnce([]);
    await logActivity({ organisationId: "g1", kind: "note", actor: "ava", body: "first contact" });
    const [, params] = query.mock.calls[0];
    expect(params).toContain(null);
  });
});

describe("organisationDetail", () => {
  it("returns null for an organisation that does not exist, without reading the rest", async () => {
    query.mockResolvedValueOnce([]);
    const detail = await organisationDetail("missing");
    expect(detail).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("assembles the organisation, its contacts, opportunities and activities", async () => {
    query
      .mockResolvedValueOnce([
        {
          id: "g1",
          name: "Bondi Baker",
          website_url: "https://bondibaker.example",
          location: "Bondi",
          category: ["bakery"],
          tags: ["warm"],
          converted_product: null,
          converted_label: null,
          converted_at: null,
          created_at: new Date("2026-01-01T00:00:00Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "c1",
          name: "Priya",
          email: "priya@bondibaker.example",
          phone: null,
          instagram_handle: "@bondibaker",
          is_primary: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "o1",
          product: "mark8ly",
          stage: "qualified",
          owner: "ava@tesserix.app",
          next_action_at: null,
          next_action_note: null,
          last_contacted_at: new Date("2026-08-01T00:00:00Z"),
          is_starred: false,
          closed_at: null,
          lost_reason: null,
          created_at: new Date("2026-01-05T00:00:00Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "a1",
          opportunity_id: "o1",
          kind: "note",
          actor: "ava",
          body: "left a voicemail",
          occurred_at: new Date("2026-08-01T09:00:00Z"),
        },
      ]);

    const detail = await organisationDetail("g1");

    expect(detail?.organisation.name).toBe("Bondi Baker");
    expect(detail?.contacts).toHaveLength(1);
    expect(detail?.contacts[0].isPrimary).toBe(true);
    expect(detail?.opportunities).toHaveLength(1);
    expect(detail?.opportunities[0].stage).toBe("qualified");
    expect(detail?.activities).toHaveLength(1);
    expect(detail?.activities[0].kind).toBe("note");
    // Timestamps normalised to ISO strings, same contract as the queue rows.
    expect(detail?.organisation.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(detail?.activities[0].occurredAt).toBe("2026-08-01T09:00:00.000Z");
  });

  it("scopes contacts, opportunities and activities to the organisation", async () => {
    query.mockResolvedValueOnce([
      {
        id: "g1",
        name: "Bondi Baker",
        website_url: null,
        location: null,
        category: [],
        tags: [],
        converted_product: null,
        converted_label: null,
        converted_at: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    query.mockResolvedValue([]);
    await organisationDetail("g1");
    const calledSql = query.mock.calls.slice(1).map(([sql]) => sql as string);
    expect(calledSql.some((sql) => sql.includes("FROM crm_contacts") && sql.includes("organisation_id = $1"))).toBe(true);
    expect(calledSql.some((sql) => sql.includes("FROM crm_opportunities") && sql.includes("organisation_id = $1"))).toBe(true);
    expect(calledSql.some((sql) => sql.includes("FROM crm_activities") && sql.includes("organisation_id = $1"))).toBe(true);
  });
});
