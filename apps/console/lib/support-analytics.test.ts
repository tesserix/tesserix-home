import { describe, expect, it } from "vitest";
import { PlatformApiError } from "./platform-api";
import {
  formatCsat,
  formatResolutionTime,
  formatResolvedRate,
  formatShare,
  parseSupportAnalytics,
} from "./support-analytics";

const VALID = {
  total: 120,
  open: 14,
  escalated: 30,
  ai_resolved: 76,
  avg_resolution_seconds: 5400,
  csat: 4.2,
  resolved_rate: 0.83,
  feedback_count: 41,
  by_status: { closed: 90, active: 20, pending: 10 },
  by_reason: { billing: 12, delivery: 8 },
  by_tenant: { "11111111-1111-1111-1111-111111111111": 70, fanzone: 50 },
  tenant_names: { "11111111-1111-1111-1111-111111111111": "Asha Threads" },
};

describe("parseSupportAnalytics", () => {
  it("reads the eight KPIs off the documented shape", () => {
    const stats = parseSupportAnalytics(VALID);

    expect(stats).toMatchObject({
      total: 120,
      open: 14,
      escalated: 30,
      aiResolved: 76,
      avgResolutionSeconds: 5400,
      csat: 4.2,
      resolvedRate: 0.83,
      feedbackCount: 41,
    });
  });

  it("rejects a missing KPI rather than coercing it to zero", () => {
    // Same contract as lib/tickets.ts: a dashboard that quietly reads 0% CSAT
    // because a field was renamed upstream looks measured and is not.
    const { csat: _omitted, ...withoutCsat } = VALID;
    expect(() => parseSupportAnalytics(withoutCsat)).toThrow(PlatformApiError);
  });

  it("rejects a numeric KPI arriving as a string", () => {
    expect(() => parseSupportAnalytics({ ...VALID, total: "120" })).toThrow(
      PlatformApiError,
    );
  });

  it("rejects a bucket whose count is not a number", () => {
    expect(() =>
      parseSupportAnalytics({ ...VALID, by_reason: { billing: "12" } }),
    ).toThrow(PlatformApiError);
  });

  it("accepts a null bucket map as no buckets — otto is Go, and a nil map is null", () => {
    const stats = parseSupportAnalytics({ ...VALID, by_reason: null });
    expect(stats.byReason).toEqual([]);
  });

  it("still rejects a bucket map that is neither null nor an object", () => {
    // Guards the guard above: accepting null must not become accepting anything.
    expect(() => parseSupportAnalytics({ ...VALID, by_reason: "billing" })).toThrow(
      PlatformApiError,
    );
    expect(() => parseSupportAnalytics({ ...VALID, by_status: [1, 2] })).toThrow(
      PlatformApiError,
    );
  });

  it("ranks each breakdown biggest first", () => {
    expect(parseSupportAnalytics(VALID).byStatus.map((row) => row.key)).toEqual([
      "closed",
      "active",
      "pending",
    ]);
  });

  it("breaks ties on the key so the order does not move between reads", () => {
    const stats = parseSupportAnalytics({
      ...VALID,
      by_reason: { zeta: 5, alpha: 5 },
    });
    expect(stats.byReason.map((row) => row.key)).toEqual(["alpha", "zeta"]);
  });

  it("resolves tenant ids to the names the proxy attached", () => {
    // The whole reason this is read through apps/web rather than from otto:
    // the console cannot reach the mark8ly database that holds these names.
    const byTenant = parseSupportAnalytics(VALID).byTenant;
    expect(byTenant[0]).toMatchObject({
      key: "11111111-1111-1111-1111-111111111111",
      label: "Asha Threads",
      count: 70,
    });
  });

  it("falls back to the raw id for a tenant the proxy could not resolve", () => {
    expect(parseSupportAnalytics(VALID).byTenant[1]).toMatchObject({
      key: "fanzone",
      label: "fanzone",
    });
  });

  it("computes each row's share of its own breakdown, not of the total", () => {
    // by_reason covers 20 categorised conversations out of 120 total; billing
    // is 60% of the reasons, not 10% of everything.
    const billing = parseSupportAnalytics(VALID).byReason[0];
    expect(billing.share).toBeCloseTo(0.6, 5);
  });

  it("reports a zero share instead of NaN for an empty breakdown", () => {
    const stats = parseSupportAnalytics({ ...VALID, by_status: { closed: 0 } });
    expect(stats.byStatus[0].share).toBe(0);
  });
});

describe("formatters", () => {
  it("renders durations coarsely", () => {
    expect(formatResolutionTime(0)).toBe("—");
    expect(formatResolutionTime(42)).toBe("42s");
    expect(formatResolutionTime(150)).toBe("2m 30s");
    expect(formatResolutionTime(5400)).toBe("1h 30m");
  });

  it("reports 0% rather than NaN% when nothing has happened", () => {
    expect(formatShare(0, 0)).toBe("0%");
    expect(formatShare(30, 120)).toBe("25%");
  });

  it("withholds CSAT and resolved rate when nobody has rated", () => {
    // "0.0 / 5" from an empty feedback set reads as a catastrophe rather than
    // as an absence of data.
    expect(formatCsat(0, 0)).toBe("—");
    expect(formatResolvedRate(0, 0)).toBe("—");
    expect(formatCsat(4.2, 41)).toBe("4.2 / 5");
    expect(formatResolvedRate(0.83, 41)).toBe("83%");
  });
});
