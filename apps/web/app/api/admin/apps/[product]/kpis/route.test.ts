import { describe, expect, it, vi, beforeEach } from "vitest";

const queryInstant = vi.fn();
const readKeyHealth = vi.fn();
vi.mock("@/lib/metrics/prometheus", () => ({ queryInstant: (q: string) => queryInstant(q) }));
vi.mock("@/lib/secrets/key-health", () => ({
  readKeyHealth: (projectId: string, names: ReadonlyArray<string>) => readKeyHealth(projectId, names),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";

function sample(v: number) {
  return [{ metric: {}, value: { time: Date.now(), value: v } }];
}

function req(product: string) {
  return GET(new Request(`http://x/api/admin/apps/${product}/kpis`), {
    params: Promise.resolve({ product }),
  });
}

// NB: block body, not an expression arrow — `mockReset()` returns the mock
// itself, and Vitest treats a value returned from `beforeEach` as an
// implicit cleanup callback, invoking it (with no args) after the test.
beforeEach(() => {
  queryInstant.mockReset();
  readKeyHealth.mockReset();
  readKeyHealth.mockResolvedValue({ configured: 2, oldestAgeDays: 7 });
});

describe("kora kpis", () => {
  it("returns all six tile keys from prometheus and key health", async () => {
    queryInstant.mockImplementation((q: string) => {
      if (q === "kora_food_index_missing") return Promise.resolve(sample(4078));
      if (q === 'sum(increase(kora_ai_calls_total{outcome="ok"}[24h]))') return Promise.resolve(sample(122));
      if (q === 'sum(increase(kora_ai_calls_total{outcome=~"error|timeout"}[24h]))') return Promise.resolve(sample(3));
      if (q.includes("kora_ai_latency_seconds")) return Promise.resolve(sample(4.5));
      throw new Error(`unexpected query: ${q}`);
    });

    const body = await (await req("kora")).json();
    expect(body.food_index_missing).toBe(4078);
    expect(body.ai_calls_24h).toBe(122);
    expect(body.ai_failures_24h).toBe(3);
    expect(body.decompose_over_budget_pct).toBe(4.5);
    expect(body.ai_keys_configured).toBe(2);
    expect(body.ai_key_age_days).toBe(7);

    // readKeyHealth must be called with the two Kora secret names, metadata
    // only — the client/project wiring lives in lib/secrets/key-health.ts.
    expect(readKeyHealth).toHaveBeenCalledWith("tesseracthub-480811", [
      "prod-kora-gemini-api-key",
      "prod-kora-openai-api-key",
    ]);

    // The mock branch above matches the budget query loosely (by substring),
    // so a mutation to its filters would still resolve to sample(4.5) and
    // pass the assertions above — this is the assertion that actually
    // discriminates on the query's content. `le="1.5"` is ai.textBudget and
    // a deliberate histogram bucket boundary (see route.ts); a mutant value
    // would silently make the panel interpolate instead of reading an exact
    // bucket while looking equally authoritative. `call_type="decompose"` is
    // what scopes the whole tile to the decompose call path.
    const budgetQuery = queryInstant.mock.calls
      .map(([q]) => q as string)
      .find((q) => q.includes("kora_ai_latency_seconds"));
    expect(budgetQuery).toContain('le="1.5"');
    expect(budgetQuery).toContain('call_type="decompose"');
  });

  // The "must not" — one dead query must not blank the others...
  it("degrades one failing query without losing the rest", async () => {
    queryInstant.mockImplementation((q: string) => {
      if (q.includes("kora_food_index_missing")) return Promise.reject(new Error("prometheus_unavailable: 503"));
      return Promise.resolve(sample(7));
    });

    const res = await req("kora");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.food_index_missing).toBe(0);
    expect(body.ai_calls_24h).toBe(7);
    expect(body.ai_failures_24h).toBe(7);
    expect(body.decompose_over_budget_pct).toBe(7);
  });

  // ...and its twin: an EMPTY result set (the metric exists in no series yet)
  // must read as 0 rather than NaN or undefined, both of which render as a
  // broken tile rather than an honest zero.
  it("reads an empty prometheus result as 0", async () => {
    queryInstant.mockResolvedValue([]);
    const body = await (await req("kora")).json();
    for (const k of ["food_index_missing", "ai_calls_24h", "ai_failures_24h", "decompose_over_budget_pct"]) {
      expect(body[k]).toBe(0);
    }
  });

  it("does not query prometheus for other products", async () => {
    const body = await (await req("fanzone")).json();
    expect(queryInstant).not.toHaveBeenCalled();
    expect(body).toEqual({});
  });

  // The two blocks are independent data sources (Prometheus vs Secret
  // Manager metadata) — a failure in one must not blank the other's tiles.
  it("blanks the key-health tiles without losing the prometheus tiles when Secret Manager is unreachable", async () => {
    queryInstant.mockResolvedValue(sample(5));
    readKeyHealth.mockResolvedValue({ configured: 0, oldestAgeDays: 0 });

    const body = await (await req("kora")).json();
    expect(body.food_index_missing).toBe(5);
    expect(body.ai_calls_24h).toBe(5);
    expect(body.ai_key_age_days).toBe(0);
    expect(body.ai_keys_configured).toBe(0);
  });
});
