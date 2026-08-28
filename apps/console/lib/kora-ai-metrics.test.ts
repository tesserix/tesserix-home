import { describe, expect, it } from "vitest";

import { parseKoraAiMetrics } from "./kora-ai-metrics";

/** Kora's `data` object as platform-api forwards it — the shape
 *  tesserix/kora#507's `aiMetricsData` documents. */
const body = {
  window: { from: "2026-08-01T00:00:00Z", to: "2026-08-28T00:00:00Z" },
  outcomes: {
    attempts: 42,
    by_kind: { exact: 30, fuzzy: 10, needs_review: 2 },
    needs_human: 2,
    first_try_rate_pct: 78.5,
  },
  users: [{ user_id: "u1", attempts: 4 }],
};

describe("parseKoraAiMetrics", () => {
  it("reads attempts, needs_human and first_try_rate_pct", () => {
    const metrics = parseKoraAiMetrics(body);
    expect(metrics.outcomes.attempts).toBe(42);
    expect(metrics.outcomes.needsHuman).toBe(2);
    expect(metrics.outcomes.firstTryRatePct).toBe(78.5);
  });

  // `window`, `by_kind` and `users` are real fields on Kora's response that
  // this parser deliberately does not model — only what the tile renders.
  it("ignores fields the overview tile does not render", () => {
    const metrics = parseKoraAiMetrics(body);
    expect(metrics).not.toHaveProperty("window");
    expect(metrics).not.toHaveProperty("users");
    expect(metrics.outcomes).not.toHaveProperty("by_kind");
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
    expect(() => parseKoraAiMetrics({ window: body.window })).toThrow(/outcomes/);
  });

  it("refuses a non-whole or negative attempts/needs_human", () => {
    expect(() =>
      parseKoraAiMetrics({ ...body, outcomes: { ...body.outcomes, attempts: -1 } }),
    ).toThrow(/attempts/);
    expect(() =>
      parseKoraAiMetrics({ ...body, outcomes: { ...body.outcomes, needs_human: 1.5 } }),
    ).toThrow(/needs_human/);
  });

  it("refuses a body that is not an object", () => {
    expect(() => parseKoraAiMetrics(null)).toThrow();
    expect(() => parseKoraAiMetrics([])).toThrow();
  });

  it("accepts zero attempts as a legitimate window, distinct from an absent rate", () => {
    const metrics = parseKoraAiMetrics({
      ...body,
      outcomes: { attempts: 0, needs_human: 0 },
    });
    expect(metrics.outcomes.attempts).toBe(0);
    expect(metrics.outcomes.firstTryRatePct).toBeUndefined();
  });
});
