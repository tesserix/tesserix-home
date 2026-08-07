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
      if (q === "max(kora_food_index_missing)") return Promise.resolve(sample(4078));
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
    // pass the assertions above — these are the assertions that actually
    // discriminate on the query's content. Asserted with `toBe` against the
    // FULL query string on purpose: two separate `toContain` checks for
    // `le="1.5"` and `call_type="decompose"` are each satisfied by EITHER of
    // the query's two occurrences (numerator and denominator), so swapping
    // just the numerator's selector to e.g. `call_type="photo"` would still
    // pass both — yielding a meaningless ratio (photo successes over
    // decompose call count) that can exceed 100% or go negative. `le="1.5"`
    // is ai.textBudget and a deliberate histogram bucket boundary (see
    // route.ts); an off-boundary value would silently make the panel
    // interpolate instead of reading an exact bucket, while looking equally
    // authoritative.
    const budgetQuery = queryInstant.mock.calls
      .map(([q]) => q as string)
      .find((q) => q.includes("kora_ai_latency_seconds"));
    expect(budgetQuery).toBe(
      "100 * (1 - (" +
        'sum(rate(kora_ai_latency_seconds_bucket{call_type="decompose",le="1.5"}[24h])) / ' +
        'sum(rate(kora_ai_latency_seconds_count{call_type="decompose"}[24h]))))',
    );
  });

  // Prometheus returns NaN for a 0/0 ratio, which — as the original version of
  // this test noted itself — means decompose had NO calls in the window. So 0
  // is the one answer that is definitely wrong: it asserts that 0% of decompose
  // calls breached the budget when no decompose call was measured at all. The
  // key is omitted and the tile reads "—".
  //
  // Still pins the Number.isFinite guard in route.ts: NaN must not reach the
  // response either, where it would serialize to `null`. `out[key] = v ?? 0`
  // would leave it NaN (NaN ?? 0 is NaN, since NaN is not null/undefined) and
  // still pass every other test.
  it("omits a NaN prometheus value rather than reporting it as 0", async () => {
    queryInstant.mockImplementation((q: string) => {
      if (q.includes("kora_ai_latency_seconds")) return Promise.resolve(sample(NaN));
      return Promise.resolve(sample(7));
    });

    const body = await (await req("kora")).json();
    expect("decompose_over_budget_pct" in body).toBe(false);
    // the other three still measured fine
    expect(body.ai_calls_24h).toBe(7);
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
    // OMITTED, not 0. These tiles are all worded so that 0 is the good value,
    // so a failed query reported as 0 renders a clean bill of health for a
    // system nobody measured. An absent key renders "—" in the UI instead.
    expect("food_index_missing" in body).toBe(false);
    expect(body.ai_calls_24h).toBe(7);
    expect(body.ai_failures_24h).toBe(7);
    expect(body.decompose_over_budget_pct).toBe(7);
  });

  // ...and its twin: an EMPTY result set (the metric exists in no series yet)
  // is also "not measured", not zero — same reasoning as above. This is the
  // case that actually bit: the monitoring namespace was scaled to 0 replicas,
  // every query returned nothing, and the overview reported food_index_missing
  // as 0 while the database held 1,071 rows with a NULL embedding.
  it("omits keys entirely when the prometheus result is empty", async () => {
    queryInstant.mockResolvedValue([]);
    const body = await (await req("kora")).json();
    for (const k of ["food_index_missing", "ai_calls_24h", "ai_failures_24h", "decompose_over_budget_pct"]) {
      expect(k in body).toBe(false);
    }
  });

  // The other half of the contract: a real measured 0 must survive as 0, or
  // the fix above would just move the lie (every healthy system would read
  // "unknown"). Distinguishing these two is the entire point.
  it("passes a genuine measured zero through as 0", async () => {
    queryInstant.mockResolvedValue(sample(0));
    const body = await (await req("kora")).json();
    for (const k of ["food_index_missing", "ai_calls_24h", "ai_failures_24h", "decompose_over_budget_pct"]) {
      expect(body[k]).toBe(0);
    }
  });

  it("does not query prometheus or secret manager for other products", async () => {
    const body = await (await req("fanzone")).json();
    expect(queryInstant).not.toHaveBeenCalled();
    // Twin of the assertion above: readKeyHealth is gated behind the same
    // `product === "kora"` guard. Without this, hoisting the readKeyHealth
    // call above the guard would pass every other test while every
    // mark8ly/homechef/devai KPI request silently started making two GCP
    // Secret Manager API calls.
    expect(readKeyHealth).not.toHaveBeenCalled();
    expect(body).toEqual({});
  });

  // The two blocks are independent data sources (Prometheus vs Secret
  // Manager metadata) — a failure in one must not blank the other's tiles.
  // A MEASURED zero (Secret Manager answered; no key has an enabled version)
  // must still surface as 0 — that is the alarm the tile exists to raise.
  it("reports a measured zero from Secret Manager as 0", async () => {
    queryInstant.mockResolvedValue(sample(5));
    readKeyHealth.mockResolvedValue({ configured: 0, oldestAgeDays: 0 });

    const body = await (await req("kora")).json();
    expect(body.food_index_missing).toBe(5);
    expect(body.ai_calls_24h).toBe(5);
    expect(body.ai_key_age_days).toBe(0);
    expect(body.ai_keys_configured).toBe(0);
  });

  // Its twin: readKeyHealth now signals "could not check" with null, and that
  // must blank the two key tiles without touching the four Prometheus ones.
  it("blanks only the key-health tiles when readKeyHealth returns null", async () => {
    queryInstant.mockResolvedValue(sample(5));
    readKeyHealth.mockResolvedValue(null);

    const body = await (await req("kora")).json();
    expect(body.food_index_missing).toBe(5);
    expect(body.decompose_over_budget_pct).toBe(5);
    expect("ai_keys_configured" in body).toBe(false);
    expect("ai_key_age_days" in body).toBe(false);
  });

  // readKeyHealth already catches its own errors internally (see
  // key-health.ts), but route.ts must not RELY on that — a mock (or a future
  // refactor) that rejects must not propagate. Without a try/catch around
  // the call site, this rejection would escape `GET` entirely, Next would
  // return a 500, and all six tiles would blank — the exact inverse of the
  // independent-degradation invariant the test above exists to prove.
  it("returns 200 with prometheus tiles intact when readKeyHealth rejects", async () => {
    queryInstant.mockResolvedValue(sample(5));
    readKeyHealth.mockRejectedValue(new Error("PERMISSION_DENIED"));

    const res = await req("kora");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.food_index_missing).toBe(5);
    expect(body.ai_calls_24h).toBe(5);
    expect(body.ai_failures_24h).toBe(5);
    expect(body.decompose_over_budget_pct).toBe(5);
    // Omitted rather than zeroed — a rejected lookup is "unknown", and
    // `ai_keys_configured: 0` is the alarm state, not the unknown state.
    expect("ai_keys_configured" in body).toBe(false);
    expect("ai_key_age_days" in body).toBe(false);
  });

  // Proves the two upstreams run CONCURRENTLY rather than sequentially: with
  // queryInstant hung on a promise that never resolves, readKeyHealth must
  // still have been invoked once pending microtasks flush. If the two calls
  // were composed sequentially (`await Promise.all(prometheus...)` completing
  // before `readKeyHealth(...)` is even called), readKeyHealth would never
  // be called at all here, since the prometheus leg never settles.
  it("invokes secret manager without waiting for prometheus to resolve first", async () => {
    // queryInstant is called once per query (four times) — every call must
    // be captured, not just the last, or the other three hang forever.
    const releasePrometheus: Array<() => void> = [];
    queryInstant.mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePrometheus.push(() => resolve(sample(1)));
        }),
    );
    readKeyHealth.mockResolvedValue({ configured: 2, oldestAgeDays: 7 });

    const pending = req("kora");

    // Flush pending microtasks without waiting on the (intentionally
    // never-resolving) prometheus promises.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(readKeyHealth).toHaveBeenCalled();

    // Let the request settle before the test ends.
    releasePrometheus.forEach((release) => release());
    await pending;
  });
});
