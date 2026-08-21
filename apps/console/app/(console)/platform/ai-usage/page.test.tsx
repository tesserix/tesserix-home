import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  AiUsageBreakdown,
  AiUsageEvents,
  AiUsageGuardrails,
  AiUsageSummary,
} from "@/lib/ai-usage";
import AiUsagePage, {
  aiUsageFilters,
  DEFAULT_WINDOW,
  EMPTY_MESSAGES,
  isNarrowed,
  readAiUsageFilters,
  toFilterValues,
  toRankedRows,
  usageState,
} from "./page";

// The filter bar reads the router; the page renders it inline here because
// Vitest has no RSC boundary.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/platform/ai-usage",
  useSearchParams: () => new URLSearchParams(),
}));

const fetchers = vi.hoisted(() => ({
  summary: vi.fn(),
  breakdown: vi.fn(),
  guardrails: vi.fn(),
  events: vi.fn(),
}));

// Mocked at the module boundary rather than at `fetch`: the transport itself —
// which params are sent, what a 422 does — is covered in lib/platform-api.test.ts,
// and going through it here would need the operator token store as well.
vi.mock("@/lib/platform-api", () => ({
  fetchAiUsageSummary: fetchers.summary,
  fetchAiUsageBreakdown: fetchers.breakdown,
  fetchAiUsageGuardrails: fetchers.guardrails,
  fetchAiUsageEvents: fetchers.events,
  AI_EVENTS_LIMIT: 50,
}));

const WINDOW = {
  key: "24h",
  from: "2026-08-19T07:00:00Z",
  to: "2026-08-20T07:00:00Z",
  bucketSeconds: 3600,
};

const TOKENS = { input: 1000, output: 250, cachedInput: 400 };

const SUMMARY: AiUsageSummary = {
  window: WINDOW,
  totals: {
    requests: 1240,
    tokens: TOKENS,
    costUsd: 0.0042,
    ok: 1230,
    blocked: 4,
    rateLimited: 3,
    errors: 3,
    masked: 7,
  },
  series: [
    { bucket: "2026-08-19T07:00:00Z", requests: 400, tokens: TOKENS, costUsd: 0.002 },
    { bucket: "2026-08-19T08:00:00Z", requests: 840, tokens: TOKENS, costUsd: 0.0022 },
  ],
};

function breakdown(by: string, keys: readonly string[]): AiUsageBreakdown {
  return {
    window: WINDOW,
    by,
    rows: keys.map((key, index) => ({
      key,
      requests: 100 - index * 10,
      tokens: TOKENS,
      costUsd: 1 - index * 0.1,
      errors: 0,
      blocked: 0,
    })),
  };
}

const GUARDRAILS: AiUsageGuardrails = {
  window: WINDOW,
  blocked: 4,
  masked: 7,
  rateLimited: 3,
  rules: [
    {
      rule: "CreditCard",
      action: "reject",
      product: "kora",
      requests: 4,
      lastSeen: "2026-08-20T06:59:00Z",
    },
  ],
};

const EVENTS: AiUsageEvents = { window: WINDOW, events: [] };

beforeEach(() => {
  fetchers.summary.mockResolvedValue(SUMMARY);
  fetchers.breakdown.mockImplementation(async (by: string) =>
    breakdown(by, by === "provider" ? ["anthropic", "vertex"] : ["kora", "hms"]),
  );
  fetchers.guardrails.mockResolvedValue(GUARDRAILS);
  fetchers.events.mockResolvedValue(EVENTS);
});

afterEach(() => {
  vi.clearAllMocks();
});

async function renderPage(searchParams: Record<string, string | string[] | undefined> = {}) {
  render(await AiUsagePage({ searchParams: Promise.resolve(searchParams) }));
}

describe("readAiUsageFilters", () => {
  it("defaults to the cheapest window", () => {
    expect(readAiUsageFilters({})).toEqual({
      window: DEFAULT_WINDOW,
      product: undefined,
      provider: undefined,
    });
  });

  it("keeps a window the API knows", () => {
    expect(readAiUsageFilters({ window: "30d" }).window).toBe("30d");
  });

  it("falls back rather than sending a window the API would refuse", () => {
    // A hand-edited URL should show 24 hours of traffic, not a 422 rendered as
    // a blank page.
    expect(readAiUsageFilters({ window: "90d" }).window).toBe(DEFAULT_WINDOW);
  });

  it("ignores a repeated param, which the API takes one value for", () => {
    expect(readAiUsageFilters({ product: ["kora", "hms"] }).product).toBeUndefined();
  });

  it("drops a value too long to be a slug", () => {
    expect(readAiUsageFilters({ provider: "x".repeat(200) }).provider).toBeUndefined();
  });

  it("passes a plausible product and provider through", () => {
    expect(readAiUsageFilters({ product: " kora ", provider: "vertex" })).toEqual({
      window: DEFAULT_WINDOW,
      product: "kora",
      provider: "vertex",
    });
  });
});

describe("isNarrowed", () => {
  it("is false on the default view, so an empty one reads as quiet", () => {
    expect(isNarrowed({ window: DEFAULT_WINDOW })).toBe(false);
  });

  it("is true once any filter is applied", () => {
    expect(isNarrowed({ window: DEFAULT_WINDOW, product: "kora" })).toBe(true);
    expect(isNarrowed({ window: "7d" })).toBe(true);
  });
});

describe("toFilterValues", () => {
  it("always shows the window, and only the filters in effect", () => {
    expect(toFilterValues({ window: "7d", provider: "vertex" })).toEqual({
      window: "7d",
      provider: "vertex",
    });
  });
});

describe("aiUsageFilters", () => {
  const filters = (options: Parameters<typeof aiUsageFilters>[0]) => ({
    product: aiUsageFilters(options).find((d) => d.key === "product"),
    provider: aiUsageFilters(options).find((d) => d.key === "provider"),
  });

  it("offers the providers the window actually shows", () => {
    const { provider } = filters({ products: [], providers: ["vertex", "anthropic"] });
    expect(provider?.options?.map((o) => o.value)).toEqual(["anthropic", "vertex"]);
  });

  it("keeps the applied provider even when it served nothing", () => {
    // Otherwise a saved URL renders a filter the bar shows as unset while the
    // page is still narrowed by it.
    const { provider } = filters({
      products: [],
      providers: [],
      applied: { window: "24h", provider: "bedrock" },
    });
    expect(provider?.options?.map((o) => o.value)).toEqual(["bedrock"]);
  });

  it("drops the unattributed key, which is not a provider anyone can pick", () => {
    const { provider } = filters({ products: [], providers: ["", "vertex"] });
    expect(provider?.options?.map((o) => o.value)).toEqual(["vertex"]);
  });

  it("offers only the products that actually sent traffic", () => {
    // The estate lists seven products; the gateway has seen two. Offering the
    // other five is offering filters that can only ever return nothing.
    const { product } = filters({ products: ["kora", "hms"], providers: [] });
    expect(product?.options?.map((o) => o.value)).toEqual(["hms", "kora"]);
  });

  it("labels a known product with its estate name and an unknown one as it came", () => {
    const { product } = filters({ products: ["kora", "somethingnew"], providers: [] });
    const labels = Object.fromEntries(
      (product?.options ?? []).map((o) => [o.value, o.label]),
    );
    expect(labels.kora).toBe("Kora");
    expect(labels.somethingnew).toBe("somethingnew");
  });

  it("keeps the applied product even when it served nothing", () => {
    const { product } = filters({
      products: [],
      providers: [],
      applied: { window: "24h", product: "dwellm8" },
    });
    expect(product?.options?.map((o) => o.value)).toEqual(["dwellm8"]);
  });
});

describe("toRankedRows", () => {
  it("ranks by request share", () => {
    const rows = toRankedRows([
      { key: "kora", requests: 75 },
      { key: "hms", requests: 25 },
    ]);
    expect(rows[0].share).toBeCloseTo(0.75);
    expect(rows[1].share).toBeCloseTo(0.25);
  });

  it("labels the unattributed row rather than dropping it", () => {
    expect(toRankedRows([{ key: "", requests: 5 }])[0].label).toBe("Unattributed");
  });

  it("does not divide by zero on a quiet window", () => {
    expect(toRankedRows([{ key: "kora", requests: 0 }])[0].share).toBe(0);
  });
});

describe("usageState", () => {
  it("reports a parked data plane rather than an error", () => {
    const state = usageState({ error: { status: 501 }, rows: [], filtered: false });
    expect(state.kind).toBe("instrumentation-unavailable");
  });

  it("separates a quiet window from one nothing matches", () => {
    expect(usageState({ error: null, rows: [], filtered: false }).kind).toBe("empty");
    expect(usageState({ error: null, rows: [], filtered: true }).kind).toBe("filtered-empty");
  });

  it("carries the API's message into the error state", () => {
    const state = usageState({
      error: { status: 403, message: "FORBIDDEN" },
      rows: [],
      filtered: false,
    });
    expect(state).toEqual({ kind: "error", message: "FORBIDDEN" });
  });
});

describe("the page", () => {
  it("asks every read for the same window and filters", async () => {
    await renderPage({ window: "7d", product: "kora" });

    const query = { window: "7d", product: "kora", provider: undefined };
    expect(fetchers.summary).toHaveBeenCalledWith(query);
    expect(fetchers.guardrails).toHaveBeenCalledWith(query);
    expect(fetchers.events).toHaveBeenCalledWith(query);
    // Four narrowed axes, then the two unnarrowed reads the filter bar's
    // vocabulary comes from.
    expect(fetchers.breakdown.mock.calls.map(([by]) => by)).toEqual([
      "product",
      "capability",
      "provider",
      "model",
      "product",
      "provider",
    ]);
    expect(fetchers.breakdown).toHaveBeenCalledWith("model", query);
    expect(fetchers.breakdown).toHaveBeenCalledWith("product", { window: "7d" });
  });

  it("keeps the product filter offering products the current filter excludes", async () => {
    // The narrowed read returns kora alone; the dropdown must still offer hms,
    // or a reader who picked kora can never pick anything else.
    await renderPage({ window: "24h", product: "kora" });
    const vocabulary = fetchers.breakdown.mock.calls.filter(
      ([by, q]) => by === "product" && q.product === undefined,
    );
    expect(vocabulary).toHaveLength(1);
  });

  it("shows sub-cent spend as a cost rather than as zero", async () => {
    await renderPage();
    expect(screen.getByText("$0.0042")).toBeInTheDocument();
  });

  it("counts blocked, rate-limited and errored requests as refused", async () => {
    // From the caller's side all three are a request that got no answer, so
    // the tile is one number: 4 + 3 + 3.
    await renderPage();
    const refused = screen.getByText("Refused").closest("div");
    expect(refused?.textContent).toContain("10");
  });

  it("keeps the cost tiles when the guardrail read fails", async () => {
    // Six independent reads, six states: one parked query must not blank the
    // surface that answers "what are we spending".
    fetchers.guardrails.mockRejectedValue(Object.assign(new Error("nope"), { status: 500 }));
    await renderPage();
    expect(screen.getByText("$0.0042")).toBeInTheDocument();
  });

  it("says the window is quiet rather than showing an empty chart", async () => {
    fetchers.summary.mockResolvedValue({ ...SUMMARY, series: [] });
    fetchers.breakdown.mockImplementation(async (by: string) => breakdown(by, []));
    await renderPage();
    expect(screen.getAllByText(EMPTY_MESSAGES.overview).length).toBeGreaterThan(0);
  });
});
