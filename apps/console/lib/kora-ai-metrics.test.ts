import { describe, expect, it } from "vitest";

import { parseKoraAiMetrics, parseKoraAiMetricsPagination } from "./kora-ai-metrics";

/** Kora's `data` object as platform-api forwards it — the shape
 *  tesserix/kora#507's `aiMetricsData` documents. */
const body = {
  window: { from: "2026-08-01T00:00:00Z", to: "2026-08-28T00:00:00Z" },
  outcomes: {
    attempts: 42,
    // Kora zero-fills this across all the kinds it measures — three shown
    // here is enough to prove the parser carries every key through,
    // including the zero, rather than hardcoding a kind list of its own.
    by_kind: { exact: 30, fuzzy: 10, needs_review: 2, no_match: 0 },
    needs_human: 2,
    first_try_rate_pct: 78.5,
  },
  users: [
    {
      user_id: "u1",
      attempts: 4,
      resolves: 3,
      corrections: 1,
      budget_refusals: 0,
      ai_calls: 4,
      last_activity_at: "2026-08-27T10:00:00Z",
    },
    {
      user_id: "u2",
      attempts: 1,
      resolves: 0,
      corrections: 0,
      budget_refusals: 1,
      ai_calls: 1,
      // No last_activity_at — a legitimate shape, not a deviation.
    },
  ],
};

const pagination = { page: 1, limit: 50, total: 2 };

describe("parseKoraAiMetrics", () => {
  it("reads attempts, needs_human and first_try_rate_pct", () => {
    const metrics = parseKoraAiMetrics(body);
    expect(metrics.outcomes.attempts).toBe(42);
    expect(metrics.outcomes.needsHuman).toBe(2);
    expect(metrics.outcomes.firstTryRatePct).toBe(78.5);
  });

  it("reads the window verbatim, both ends", () => {
    const metrics = parseKoraAiMetrics(body);
    expect(metrics.window).toEqual({
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-28T00:00:00Z",
    });
  });

  // `by_kind` is zero-filled by Kora across every kind it measures. The
  // parser carries every key through UNCHANGED rather than enumerating a
  // fixed list of kind names of its own — the same reason `kind` and
  // `severity` are rendered verbatim elsewhere in this console rather than
  // mapped through a console-side vocabulary that could drift from Kora's.
  it("carries every by_kind entry through, including a zero", () => {
    const metrics = parseKoraAiMetrics(body);
    expect(metrics.outcomes.byKind).toEqual({
      exact: 30,
      fuzzy: 10,
      needs_review: 2,
      no_match: 0,
    });
  });

  it("reads every user row's counters", () => {
    const metrics = parseKoraAiMetrics(body);
    expect(metrics.users).toHaveLength(2);
    expect(metrics.users[0]).toEqual({
      userId: "u1",
      attempts: 4,
      resolves: 3,
      corrections: 1,
      budgetRefusals: 0,
      aiCalls: 4,
      lastActivityAt: "2026-08-27T10:00:00Z",
    });
  });

  // `last_activity_at` is optional in the same way `first_try_rate_pct` is:
  // absent must stay absent, never defaulted to an epoch or a string like
  // "never" that would assert something the response did not say.
  it("leaves a user's last_activity_at undefined rather than inventing one", () => {
    const metrics = parseKoraAiMetrics(body);
    expect(metrics.users[1].lastActivityAt).toBeUndefined();
    expect(metrics.users[1]).not.toHaveProperty("lastActivityAt", null);
    expect(metrics.users[1]).not.toHaveProperty("lastActivityAt", "never");
  });

  // THE non-negotiable this parser exists to protect: Kora returns
  // first_try_rate_pct ABSENT, not 0.0, when the window measured nothing —
  // deliberate on Kora's side (ai_metrics.go:37-45). A caller that defaults
  // this to a number would render a confident, false zero.
  it("leaves first_try_rate_pct undefined rather than defaulting it when Kora omits it", () => {
    const { first_try_rate_pct: _omitted, ...outcomesWithoutRate } = body.outcomes;
    const metrics = parseKoraAiMetrics({ ...body, outcomes: outcomesWithoutRate });
    expect(metrics.outcomes.firstTryRatePct).toBeUndefined();
    // Not 0 — an absent rate and a measured 0% are different facts.
    expect(metrics.outcomes.firstTryRatePct).not.toBe(0);
  });

  it("refuses a present-but-malformed first_try_rate_pct rather than treating it as absent", () => {
    expect(() =>
      parseKoraAiMetrics({ ...body, outcomes: { ...body.outcomes, first_try_rate_pct: "78.5" } }),
    ).toThrow(/first_try_rate_pct/);
  });

  it("refuses a response with no outcomes", () => {
    expect(() => parseKoraAiMetrics({ window: body.window, users: body.users })).toThrow(
      /outcomes/,
    );
  });

  it("refuses a response with no window", () => {
    const { window: _omitted, ...withoutWindow } = body;
    expect(() => parseKoraAiMetrics(withoutWindow)).toThrow(/window/);
  });

  it("refuses a response with no users array", () => {
    const { users: _omitted, ...withoutUsers } = body;
    expect(() => parseKoraAiMetrics(withoutUsers)).toThrow(/users/);
  });

  it("refuses a non-whole or negative attempts/needs_human", () => {
    expect(() =>
      parseKoraAiMetrics({ ...body, outcomes: { ...body.outcomes, attempts: -1 } }),
    ).toThrow(/attempts/);
    expect(() =>
      parseKoraAiMetrics({ ...body, outcomes: { ...body.outcomes, needs_human: 1.5 } }),
    ).toThrow(/needs_human/);
  });

  it("refuses a non-whole or negative by_kind count", () => {
    expect(() =>
      parseKoraAiMetrics({
        ...body,
        outcomes: { ...body.outcomes, by_kind: { exact: -1 } },
      }),
    ).toThrow(/by_kind/);
  });

  it("refuses a user row missing a required counter", () => {
    expect(() =>
      parseKoraAiMetrics({ ...body, users: [{ user_id: "u1", attempts: 1 }] }),
    ).toThrow(/resolves/);
  });

  it("refuses a body that is not an object", () => {
    expect(() => parseKoraAiMetrics(null)).toThrow();
    expect(() => parseKoraAiMetrics([])).toThrow();
  });

  it("accepts zero attempts as a legitimate window, distinct from an absent rate", () => {
    const metrics = parseKoraAiMetrics({
      ...body,
      outcomes: { attempts: 0, needs_human: 0, by_kind: {} },
    });
    expect(metrics.outcomes.attempts).toBe(0);
    expect(metrics.outcomes.firstTryRatePct).toBeUndefined();
  });
});

describe("parseKoraAiMetricsPagination", () => {
  it("reads page, limit and total", () => {
    expect(parseKoraAiMetricsPagination({ ...body, pagination })).toEqual({
      page: 1,
      limit: 50,
      total: 2,
    });
  });

  it("refuses a response with no pagination", () => {
    expect(() => parseKoraAiMetricsPagination(body)).toThrow(/pagination/);
  });

  it("refuses a non-whole or negative total", () => {
    expect(() =>
      parseKoraAiMetricsPagination({ ...body, pagination: { ...pagination, total: -1 } }),
    ).toThrow(/total/);
  });
});
