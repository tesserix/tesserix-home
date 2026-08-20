import { describe, expect, it } from "vitest";
import {
  costFormatter,
  parseAiUsageBreakdown,
  parseAiUsageEvents,
  parseAiUsageGuardrails,
  parseAiUsageSummary,
  tokenFormatter,
} from "./ai-usage";
import { PlatformApiError } from "./platform-api-error";

const window = {
  key: "24h",
  from: "2026-08-19T10:00:00Z",
  to: "2026-08-20T10:30:00Z",
  bucket: "1h0m0s",
  bucket_seconds: 3600,
};

const tokens = { input: 1200, output: 340, cached_input: 500 };

describe("parseAiUsageSummary", () => {
  const payload = {
    window,
    totals: {
      requests: 42,
      tokens,
      cost_usd: 1.2345,
      ok_requests: 40,
      blocked_requests: 1,
      rate_limited_requests: 0,
      error_requests: 1,
      masked_requests: 3,
    },
    series: [{ bucket: "2026-08-19T10:00:00Z", requests: 42, tokens, cost_usd: 1.2345 }],
  };

  it("reads the window, the totals and the series", () => {
    const summary = parseAiUsageSummary(payload);
    expect(summary.window.key).toBe("24h");
    expect(summary.totals.requests).toBe(42);
    expect(summary.totals.tokens.cachedInput).toBe(500);
    expect(summary.totals.costUsd).toBeCloseTo(1.2345);
    expect(summary.series).toHaveLength(1);
    expect(summary.series[0].requests).toBe(42);
  });

  it("accepts a quiet window", () => {
    const quiet = { ...payload, totals: { ...payload.totals, requests: 0 }, series: [] };
    expect(parseAiUsageSummary(quiet).series).toEqual([]);
  });

  it("rejects a payload missing a total rather than rendering it as zero", () => {
    // A dash where a number should be is a reader's cue to check the gateway.
    // A zero is a claim that nothing was spent, and it is indistinguishable
    // from a quiet hour.
    const { requests: _dropped, ...rest } = payload.totals;
    expect(() => parseAiUsageSummary({ ...payload, totals: rest })).toThrow(PlatformApiError);
  });

  it("rejects a series point that is not an object", () => {
    expect(() => parseAiUsageSummary({ ...payload, series: ["nope"] })).toThrow(PlatformApiError);
  });
});

describe("parseAiUsageBreakdown", () => {
  const payload = {
    window,
    by: "provider",
    rows: [
      {
        key: "anthropic",
        requests: 10,
        tokens,
        cost_usd: 9,
        error_requests: 1,
        blocked_requests: 0,
      },
    ],
  };

  it("reads the axis and its rows", () => {
    const breakdown = parseAiUsageBreakdown(payload);
    expect(breakdown.by).toBe("provider");
    expect(breakdown.rows[0].key).toBe("anthropic");
    expect(breakdown.rows[0].costUsd).toBe(9);
  });

  it("keeps an unattributed row, labelled", () => {
    // Traffic the gateway could not attribute is the spend most worth seeing;
    // dropping the empty key would hide it.
    const unattributed = { ...payload, rows: [{ ...payload.rows[0], key: "" }] };
    expect(parseAiUsageBreakdown(unattributed).rows[0].key).toBe("");
  });
});

describe("parseAiUsageGuardrails", () => {
  const payload = {
    window,
    blocked_requests: 2,
    masked_requests: 5,
    rate_limited_requests: 1,
    rules: [
      {
        rule: "CreditCard",
        action: "reject",
        product: "kora",
        requests: 2,
        last_seen: "2026-08-20T09:59:00Z",
      },
    ],
  };

  it("reads the refusal counts and the rules that fired", () => {
    const guardrails = parseAiUsageGuardrails(payload);
    expect(guardrails.blocked).toBe(2);
    expect(guardrails.rateLimited).toBe(1);
    expect(guardrails.rules[0].action).toBe("reject");
  });

  it("rejects an action outside the vocabulary", () => {
    const rogue = { ...payload, rules: [{ ...payload.rules[0], action: "quarantine" }] };
    expect(() => parseAiUsageGuardrails(rogue)).toThrow(PlatformApiError);
  });
});

describe("parseAiUsageEvents", () => {
  const event = {
    span_id: "span-1",
    trace_id: "trace-1",
    occurred_at: "2026-08-20T09:59:00Z",
    gateway: "kora-ai",
    product: "kora",
    capability: null,
    provider: "vertex",
    request_model: "gemini-2.5-pro",
    response_model: "gemini-2.5-pro",
    tokens,
    cost_usd: 0.02,
    cost_source: "catalog",
    status_code: 200,
    outcome: "ok",
    guardrail_action: null,
    guardrail_rule: null,
    latency_ms: 412,
  };

  it("reads the tail, keeping nulls as nulls", () => {
    const page = parseAiUsageEvents({ window, events: [event] });
    expect(page.events[0].spanId).toBe("span-1");
    expect(page.events[0].capability).toBeNull();
    expect(page.events[0].latencyMs).toBe(412);
  });

  it("rejects an outcome outside the vocabulary", () => {
    expect(() => parseAiUsageEvents({ window, events: [{ ...event, outcome: "maybe" }] })).toThrow(
      PlatformApiError,
    );
  });
});

describe("formatters", () => {
  it("shows sub-cent spend as a cost, not as zero", () => {
    // A gateway request costs fractions of a cent. Rounded to two places, a
    // real cost reads as "$0.00" — which says "free", and it is not.
    expect(costFormatter(0.0042)).toBe("$0.0042");
    expect(costFormatter(12.5)).toBe("$12.50");
    expect(costFormatter(0)).toBe("$0.00");
  });

  it("abbreviates token counts", () => {
    expect(tokenFormatter(999)).toBe("999");
    expect(tokenFormatter(1_500)).toBe("1.5K");
    expect(tokenFormatter(2_400_000)).toBe("2.4M");
  });
});
