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
  isSuppressed,
  addSuppression,
  removeSuppression,
  listSuppressions,
  previewImport,
  commitImport,
  findMatchingOrganisationId,
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
    expect(updateSql).toContain("lost_reason = $3");
    // Pinned by position, not `toContain(null)`: `updateParams` is
    // `[opportunityId, to, lostReason]` here (product is unchanged, so no
    // fourth param is pushed) — `toContain(null)` would pass just as well
    // if some OTHER parameter happened to be null, which proves nothing
    // about lost_reason specifically.
    expect(updateParams).toEqual(["o1", "qualified", null]);
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
    // Pinned by position (see the comment above): params are
    // `[opportunityId, to, lostReason]`, and lost_reason — index 2 — is the
    // one that must be null, not merely "some param is null".
    expect(updateParams).toEqual(["o1", "won", null]);
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

describe("suppressions", () => {
  // The whole point of the list: the partial UNIQUE indexes
  // (crm_suppressions_email_uq, crm_suppressions_ig_uq) are on `lower(...)`,
  // so a lookup that compares the raw value would miss a match that differs
  // only in case — and then collide on the very next insert.
  it("matches a suppression case-insensitively on either key", async () => {
    query.mockResolvedValue([{ id: "s1" }]);
    expect(await isSuppressed({ email: "Ava@Example.com" })).toBe(true);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("lower(");
  });

  // Fix round 3: `addSuppression` and migration 0022's trigger both trim the
  // stored email, so an untrimmed lookup that still passed the raw value
  // through would miss a real match on nothing but whitespace — exactly
  // what a CSV cell (Task 8's import) carries as a matter of course.
  it("trims whitespace from an email lookup before comparing", async () => {
    query.mockResolvedValue([{ id: "s1" }]);
    expect(await isSuppressed({ email: "  ava@example.com  " })).toBe(true);
    const [, params] = query.mock.calls[0];
    expect(params).toContain("ava@example.com");
    expect(params).not.toContain("  ava@example.com  ");
  });

  it("matches on instagram_handle too, case-insensitively", async () => {
    query.mockResolvedValue([{ id: "s1" }]);
    expect(await isSuppressed({ instagramHandle: "Bondi_Baker" })).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("lower(instagram_handle)");
    // Normalized (Ruling 18): lowercased before it ever reaches SQL, not
    // passed through raw and left to `lower()` alone.
    expect(params).toContain("bondi_baker");
    expect(params).not.toContain("Bondi_Baker");
  });

  // Ruling 18: a handle can arrive with or without a leading `@` depending on
  // where it came from. `lower()` does not bridge that — only stripping the
  // `@` at the boundary does, on both the write and the read side (the next
  // two tests pin both directions).
  it("strips a leading '@' before querying instagram_handle, so a lookup matches regardless of format", async () => {
    query.mockResolvedValue([{ id: "s1" }]);
    expect(await isSuppressed({ instagramHandle: "@BondiBaker" })).toBe(true);
    const [, params] = query.mock.calls[0];
    expect(params).toContain("bondibaker");
  });

  it("returns false without querying when neither key is supplied", async () => {
    expect(await isSuppressed({})).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns false when nothing matches", async () => {
    query.mockResolvedValue([]);
    expect(await isSuppressed({ email: "nobody@example.com" })).toBe(false);
  });

  it("adds a suppression keyed by email", async () => {
    query.mockResolvedValueOnce([
      {
        id: "s1",
        email: "ava@example.com",
        instagram_handle: null,
        reason: "unsubscribed",
        created_by: "ava@tesserix.app",
        created_at: new Date("2026-08-16T00:00:00Z"),
      },
    ]);
    const row = await addSuppression({
      email: "ava@example.com",
      reason: "unsubscribed",
      actor: "ava@tesserix.app",
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO crm_suppressions");
    expect(params).toEqual(["ava@example.com", null, "unsubscribed", "ava@tesserix.app"]);
    expect(row.email).toBe("ava@example.com");
    expect(row.createdAt).toBe("2026-08-16T00:00:00.000Z");
  });

  // The write-side half of Ruling 18: stored in its canonical form so the
  // read side's own normalization always has something consistent to match
  // against, regardless of how an operator (or an import row) typed it.
  it("strips a leading '@' and lowercases before storing an instagram handle", async () => {
    query.mockResolvedValueOnce([
      {
        id: "s1",
        email: null,
        instagram_handle: "bondibaker",
        reason: "unsubscribed",
        created_by: "ava@tesserix.app",
        created_at: new Date("2026-08-16T00:00:00Z"),
      },
    ]);
    await addSuppression({
      instagramHandle: "@BondiBaker",
      reason: "unsubscribed",
      actor: "ava@tesserix.app",
    });
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([null, "bondibaker", "unsubscribed", "ava@tesserix.app"]);
  });

  // Belt-and-braces alongside migration 0022's trigger (Ruling 19): trimmed
  // and lowercased here too, so the common case never has to round-trip
  // through the database to look normal.
  it("trims and lowercases the email before storing it", async () => {
    query.mockResolvedValueOnce([
      {
        id: "s1",
        email: "ava@example.com",
        instagram_handle: null,
        reason: "unsubscribed",
        created_by: "ava@tesserix.app",
        created_at: new Date("2026-08-16T00:00:00Z"),
      },
    ]);
    await addSuppression({
      email: "  Ava@Example.com  ",
      reason: "unsubscribed",
      actor: "ava@tesserix.app",
    });
    const [, params] = query.mock.calls[0];
    expect(params).toEqual(["ava@example.com", null, "unsubscribed", "ava@tesserix.app"]);
  });

  it("refuses to add a suppression with neither key, before touching the database", async () => {
    await expect(
      addSuppression({ reason: "unsubscribed", actor: "ava@tesserix.app" }),
    ).rejects.toThrow(/email|instagram/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("lists suppressions newest first", async () => {
    query.mockResolvedValue([]);
    await listSuppressions();
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("FROM crm_suppressions");
    expect(sql).toContain("ORDER BY created_at DESC");
  });

  // Ruling 17: `removeSuppression` is plain data access — no session to
  // check, no `auditedOperation` call, at this layer. Accountability for the
  // write lives in `suppressions/actions.ts`, via the shared `withCrmWrite`
  // (see `lib/crm-write.ts` and `suppressions/actions.test.ts`).
  describe("removeSuppression", () => {
    it("deletes by id and returns exactly the rows the DELETE reports, including the suppression key", async () => {
      query.mockResolvedValueOnce([{ id: "s1", email: "ava@example.com", instagram_handle: null }]);
      const rows = await removeSuppression("s1");
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain("DELETE FROM crm_suppressions");
      expect(sql).toContain("RETURNING id, email, instagram_handle");
      expect(params).toEqual(["s1"]);
      // Ruling 20: email/instagramHandle returned alongside id, and mapped
      // to camelCase — the caller (`suppressions/actions.ts`) needs these to
      // audit the suppression's key rather than the opaque uuid it was
      // looked up by.
      expect(rows).toEqual([{ id: "s1", email: "ava@example.com", instagramHandle: null }]);
    });

    // Important 3: a DELETE against a non-matching id succeeds with zero
    // rows, not an error — the caller (`suppressions/actions.ts`) needs this
    // real count to write an honest `{ removed: 0 }` rather than assuming
    // `{ removed: 1 }` for a removal that never happened.
    it("returns no rows, honestly, when nothing matched", async () => {
      query.mockResolvedValueOnce([]);
      const rows = await removeSuppression("missing");
      expect(rows).toEqual([]);
    });
  });
});

/**
 * CSV import (Task 8).
 *
 * The rule both `previewImport` and `commitImport` exist to hold: suppression
 * is checked at BOTH preview and commit, never only at preview. A preview
 * can be minutes old; someone can be suppressed in the gap, and committing a
 * stale preview would then contact a person who asked not to be. Every test
 * below that calls `commitImport` re-asserts the suppression check fires
 * there too — not "trust the preview already covered it".
 *
 * `query.mockImplementation` routes by SQL shape rather than call order, so
 * these tests don't depend on exactly how many statements `commitImport`
 * issues per row — only on which statements ran and with what effect.
 */
describe("import", () => {
  function routeQuery(overrides: {
    suppressed?: unknown[];
    matched?: unknown[];
  }) {
    return (sql: string) => {
      if (/INSERT INTO crm_imports/.test(sql)) {
        return Promise.resolve([{ id: "imp1" }]);
      }
      if (/FROM crm_suppressions/.test(sql)) {
        return Promise.resolve(overrides.suppressed ?? []);
      }
      if (/FROM crm_contacts/.test(sql)) {
        return Promise.resolve(overrides.matched ?? []);
      }
      if (/INSERT INTO crm_organisations/.test(sql)) {
        return Promise.resolve([{ id: "org1" }]);
      }
      return Promise.resolve([]);
    };
  }

  // Ruling 23: `isSuppressed`/`findMatchingOrganisationId` accept an
  // optional `query` override, defaulting to `tesserixQuery`. These two
  // tests prove the override actually takes precedence — not just that a
  // plausible answer comes back — by asserting the module's OWN connection
  // (`query`, what `tesserixQuery` routes to in this harness) is never
  // touched when an override is supplied. That's the mechanism
  // `commitImport` relies on to read its own transaction's uncommitted
  // writes; the shared single-spy harness elsewhere in this file can't
  // distinguish "two connections" from "one", so this is the one place that
  // isolates the override itself.
  describe("query overrides (Ruling 23)", () => {
    it("isSuppressed uses the supplied query, not the module's own connection", async () => {
      const override = vi.fn().mockResolvedValue([{ id: "s1" }]);
      const result = await isSuppressed({ email: "ava@example.com" }, override);
      expect(result).toBe(true);
      expect(override).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
    });

    it("findMatchingOrganisationId uses the supplied query, not the module's own connection", async () => {
      const override = vi.fn().mockResolvedValue([{ organisation_id: "org1" }]);
      const result = await findMatchingOrganisationId({ email: "ava@example.com" }, override);
      expect(result).toBe("org1");
      expect(override).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("previewImport", () => {
    it("skips suppressed rows at preview, before anything is written", async () => {
      query.mockImplementation(routeQuery({ suppressed: [{ id: "s1" }] }));
      const preview = await previewImport([{ email: "ava@example.com" }]);
      expect(preview.skippedSuppressed).toBe(1);
      expect(preview.toCreate).toBe(0);
      expect(preview.matchedExisting).toBe(0);
      // No call issued anything that could mutate the database — the
      // no-write property is structural (previewImport never calls
      // tesserixTx), not a single early return that a future edit could
      // route around.
      expect(query.mock.calls.every(([sql]) => !/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toBe(
        true,
      );
    });

    it("counts a row matching an existing contact as matchedExisting, not toCreate", async () => {
      query.mockImplementation(
        routeQuery({ suppressed: [], matched: [{ organisation_id: "org1" }] }),
      );
      const row = { email: "ava@example.com" };
      const preview = await previewImport([row]);
      expect(preview.matchedExisting).toBe(1);
      expect(preview.toCreate).toBe(0);
      // Judgement call 2: dedup-only is correct (never merge scraped CSV
      // data over an operator-curated row) — but the list of which rows
      // were left unchanged has to be discoverable, not just a bare count.
      expect(preview.matchedRows).toEqual([row]);
    });

    it("counts a fresh row as toCreate", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const preview = await previewImport([{ email: "new@example.com" }]);
      expect(preview.toCreate).toBe(1);
      expect(preview.matchedExisting).toBe(0);
      expect(preview.skippedSuppressed).toBe(0);
    });

    // Important 1 (review round 2): the exact regression. Before this fix,
    // two rows sharing an email both previewed as toCreate, while
    // commitImport (Ruling 23) correctly resolved the second as
    // matchedExisting — a preview silently misreporting the one input its
    // own module comments call "ordinary content for a scraped leads
    // sheet", on the one page whose entire premise is "preview what this
    // would do".
    it("resolves an intra-batch duplicate email as matchedExisting on the second row, matching what commitImport will do", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const preview = await previewImport([
        { email: "dup@example.com" },
        { email: "dup@example.com" },
      ]);
      expect(preview.toCreate).toBe(1);
      expect(preview.matchedExisting).toBe(1);
    });

    it("resolves an intra-batch duplicate Instagram handle the same way, format- and case-insensitively", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const preview = await previewImport([
        { instagramHandle: "@BondiBaker" },
        { instagramHandle: "bondibaker" },
      ]);
      expect(preview.toCreate).toBe(1);
      expect(preview.matchedExisting).toBe(1);
    });

    it("does not treat an email and an Instagram handle sharing normalised text as duplicates of each other", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const preview = await previewImport([
        { email: "bondibaker@example.com" },
        { instagramHandle: "bondibaker@example.com" },
      ]);
      // Namespaced keys (`email:`/`ig:`) — an email and a handle that
      // happen to share the same literal text are not the same identity.
      expect(preview.toCreate).toBe(2);
      expect(preview.matchedExisting).toBe(0);
    });

    it("counts a row with nothing to identify it as malformed, without querying the database for it", async () => {
      query.mockImplementation(routeQuery({}));
      const preview = await previewImport([{ phone: "0400000000" }]);
      expect(preview.malformed).toBe(1);
      expect(preview.toCreate).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });

    it("never issues a write statement at all, across a full mixed batch", async () => {
      query.mockImplementation(
        routeQuery({ suppressed: [], matched: [] }),
      );
      await previewImport([
        { email: "suppressed@example.com" },
        { email: "matched@example.com" },
        { email: "fresh@example.com" },
        {},
      ]);
      for (const [sql] of query.mock.calls) {
        expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)/i);
      }
    });
  });

  describe("commitImport", () => {
    it("still consults suppression when committing, not only at preview", async () => {
      // Guards the guard: checking only at preview means a stale preview
      // commits someone who was suppressed in between.
      query.mockImplementation(routeQuery({ suppressed: [{ id: "s1" }] }));
      const result = await commitImport([{ email: "ava@example.com" }], "ava@tesserix.app");
      expect(query.mock.calls.some(([sql]) => /FROM crm_suppressions/.test(sql))).toBe(true);
      expect(result.skippedSuppressed).toBe(1);
      expect(result.created).toBe(0);
      // A suppressed row must never reach the organisation insert.
      expect(query.mock.calls.some(([sql]) => /INSERT INTO crm_organisations/.test(sql))).toBe(
        false,
      );
    });

    it("skips a row matching an existing contact without creating a duplicate organisation", async () => {
      query.mockImplementation(
        routeQuery({ suppressed: [], matched: [{ organisation_id: "org1" }] }),
      );
      const result = await commitImport([{ email: "ava@example.com" }], "ava@tesserix.app");
      expect(result.matchedExisting).toBe(1);
      expect(result.created).toBe(0);
      expect(query.mock.calls.some(([sql]) => /INSERT INTO crm_organisations/.test(sql))).toBe(
        false,
      );
    });

    it("creates an organisation, contact and opportunity for a fresh row, stamped with the import id", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const result = await commitImport(
        [{ name: "Bondi Baker", email: "ava@example.com", instagramHandle: "@bondibaker" }],
        "ava@tesserix.app",
      );
      expect(result.created).toBe(1);

      const orgCall = query.mock.calls.find(([sql]) => /INSERT INTO crm_organisations/.test(sql));
      expect(orgCall).toBeDefined();
      const [, orgParams] = orgCall!;
      // import_id (from the crm_imports insert) is stamped on the row.
      expect(orgParams).toContain("imp1");

      const oppCall = query.mock.calls.find(([sql]) => /INSERT INTO crm_opportunities/.test(sql));
      expect(oppCall).toBeDefined();
      const [oppSql, oppParams] = oppCall!;
      // product stays null and stage lands at 'new' — migrated/imported
      // opportunities were never matched to a product, and the CHECK
      // constraint (crm_opp_product_required_when_qualified) only allows a
      // null product at 'new'/'contacted'.
      expect(oppSql).toContain("'new'");
      expect(oppParams).not.toContain("qualified");
    });

    it("counts a row with nothing to identify it as malformed and writes nothing for it", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const result = await commitImport([{ phone: "0400000000" }], "ava@tesserix.app");
      expect(result.malformed).toBe(1);
      expect(result.created).toBe(0);
      expect(query.mock.calls.some(([sql]) => /INSERT INTO crm_organisations/.test(sql))).toBe(
        false,
      );
    });

    it("writes one crm_imports batch row and records row/skipped counts on it", async () => {
      query.mockImplementation(routeQuery({ suppressed: [{ id: "s1" }], matched: [] }));
      await commitImport(
        [{ email: "ava@example.com" }, { phone: "0400000000" }],
        "ava@tesserix.app",
        "leads.csv",
      );
      const importInsert = query.mock.calls.find(([sql]) => /INSERT INTO crm_imports/.test(sql));
      expect(importInsert).toBeDefined();
      const updateCall = query.mock.calls.find(([sql]) => /UPDATE crm_imports/.test(sql));
      expect(updateCall).toBeDefined();
      const [, updateParams] = updateCall!;
      // 2 rows total, both skipped (1 suppressed, 1 malformed).
      expect(updateParams).toEqual(["imp1", 2, 2]);
    });

    // Important 1 (Ruling 23): the reproduction case. Two CSV rows sharing
    // an email is ordinary content for a scraped leads sheet, not an edge
    // case. Before the fix, row 2's dedup lookup ran on a separate
    // connection from the transaction's own client and could not see row
    // 1's still-uncommitted crm_contacts insert — it would attempt its own
    // insert, trip crm_contacts_email_lower_uq, and roll the WHOLE batch
    // back. This mock models the visibility a same-connection lookup gets
    // (a stateful router, not `routeQuery`'s per-call-only one): row 2's
    // "FROM crm_contacts" check only starts returning a match once row 1's
    // "INSERT INTO crm_contacts" has actually run.
    it("resolves an intra-batch duplicate email as matchedExisting on the second row, not a constraint violation", async () => {
      let contactInserted = false;
      query.mockImplementation((sql: string) => {
        if (/INSERT INTO crm_imports/.test(sql)) return Promise.resolve([{ id: "imp1" }]);
        if (/FROM crm_suppressions/.test(sql)) return Promise.resolve([]);
        if (/FROM crm_contacts/.test(sql)) {
          return Promise.resolve(contactInserted ? [{ organisation_id: "org1" }] : []);
        }
        if (/INSERT INTO crm_organisations/.test(sql)) return Promise.resolve([{ id: "org1" }]);
        if (/INSERT INTO crm_contacts/.test(sql)) {
          contactInserted = true;
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const result = await commitImport(
        [{ email: "dup@example.com" }, { email: "dup@example.com" }],
        "ava@tesserix.app",
      );

      expect(result.created).toBe(1);
      expect(result.matchedExisting).toBe(1);
      expect(
        query.mock.calls.filter(([sql]) => /INSERT INTO crm_organisations/.test(sql)),
      ).toHaveLength(1);
    });

    // Important 2 (Ruling 23): the mocked tesserixTx in this file is
    // `(fn) => fn(query)` — it does not implement real BEGIN/ROLLBACK, so
    // this cannot prove Postgres-level atomicity (crm-repo.write.integration.test.ts,
    // via runTesserixTx against pglite, is what proves that for the shared
    // transactional core). What this DOES pin: a failure partway through
    // the batch must propagate as a rejection, not be swallowed into a
    // partial `{ created: 1, ... }` the caller could mistake for full
    // success.
    it("rejects the whole commit when a write fails partway through the batch, rather than reporting partial success", async () => {
      let orgInsertCount = 0;
      query.mockImplementation((sql: string) => {
        if (/INSERT INTO crm_imports/.test(sql)) return Promise.resolve([{ id: "imp1" }]);
        if (/FROM crm_suppressions/.test(sql)) return Promise.resolve([]);
        if (/FROM crm_contacts/.test(sql)) return Promise.resolve([]);
        if (/INSERT INTO crm_organisations/.test(sql)) {
          orgInsertCount++;
          if (orgInsertCount === 2) return Promise.reject(new Error("connection terminated"));
          return Promise.resolve([{ id: "org1" }]);
        }
        return Promise.resolve([]);
      });

      await expect(
        commitImport(
          [{ email: "first@example.com" }, { email: "second@example.com" }],
          "ava@tesserix.app",
        ),
      ).rejects.toThrow("connection terminated");
    });

    // Minor: crm_imports.row_count previously counted only the rows that
    // survived client-side CSV parsing, under-reporting the source file by
    // however many parseImportCsv already dropped as malformed. `totalRows`
    // is how the caller (import/actions.ts) supplies the true file size.
    it("uses totalRows, not just the parsed batch size, so row_count reflects the whole file", async () => {
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      await commitImport(
        [{ email: "ava@example.com" }],
        "ava@tesserix.app",
        "leads.csv",
        5, // e.g. 4 rows the client-side parser already dropped as malformed
      );
      const updateCall = query.mock.calls.find(([sql]) => /UPDATE crm_imports/.test(sql));
      const [, updateParams] = updateCall!;
      // row_count is the full file (5), not just the 1 row that survived
      // parsing; skipped_count reconciles exactly: row_count - created = 4.
      expect(updateParams).toEqual(["imp1", 5, 4]);
    });

    it("lists the rows that matched an existing organisation, not just their count", async () => {
      query.mockImplementation(
        routeQuery({ suppressed: [], matched: [{ organisation_id: "org1" }] }),
      );
      const row = { email: "ava@example.com", name: "Bondi Baker" };
      const result = await commitImport([row], "ava@tesserix.app");
      expect(result.matchedRows).toEqual([row]);
    });

    it("preview and commit agree on counts for the same input", async () => {
      const rows = [
        { email: "suppressed@example.com" },
        { email: "matched@example.com" },
        { email: "fresh@example.com" },
        {},
      ];
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const preview = await previewImport(rows);

      query.mockReset();
      query.mockImplementation(routeQuery({ suppressed: [], matched: [] }));
      const committed = await commitImport(rows, "ava@tesserix.app");

      expect(committed.created).toBe(preview.toCreate);
      expect(committed.matchedExisting).toBe(preview.matchedExisting);
      expect(committed.skippedSuppressed).toBe(preview.skippedSuppressed);
      expect(committed.malformed).toBe(preview.malformed);
    });
  });
});
