import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// `AiMetricsView` (rendered inside this server page) now drives part C's
// search + activity filters through `useUrlFilters`, which reads the
// router — jsdom has no app-router context for it. Mocked exactly as
// `ai-metrics-view.render.test.tsx` mocks it.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/kora/ai-metrics",
  useSearchParams: () => new URLSearchParams(),
}));

const fetchKoraAiMetricsPage = vi.fn();
const fetchProductEntities = vi.fn();

vi.mock("@/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-api")>()),
  fetchKoraAiMetricsPage: (...args: unknown[]) => fetchKoraAiMetricsPage(...args),
  fetchProductEntities: (...args: unknown[]) => fetchProductEntities(...args),
}));

import { PlatformApiError } from "@/lib/platform-api";
import type { KoraAiMetrics } from "@/lib/kora-ai-metrics";
import KoraAiMetricsPage, { aiMetricsState, currentPath } from "./page";

// Server component; rendered directly, the same pattern `kora/page.test.tsx`
// uses for `KoraOverviewPage`.

const METRICS = (userCount: number): KoraAiMetrics => ({
  window: { from: "2026-08-01T00:00:00Z", to: "2026-08-28T00:00:00Z" },
  outcomes: { attempts: 42, needsHuman: 2, byKind: { exact: 30 }, firstTryRatePct: 78.5 },
  users:
    userCount > 0
      ? [{ userId: "u1", attempts: 4, resolves: 3, corrections: 1, budgetRefusals: 0, aiCalls: 4 }]
      : [],
});

async function renderPage(searchParams: Record<string, string | string[] | undefined> = {}) {
  render(await KoraAiMetricsPage({ searchParams: Promise.resolve(searchParams) }));
}

// A sane default for every test that is not exercising the name join itself:
// an empty page of kora users, so an unmocked join read cannot make an
// unrelated test flaky or throw on `.data`.
beforeEach(() => {
  fetchProductEntities.mockReset();
  fetchProductEntities.mockResolvedValue({
    data: [],
    pagination: { page: 1, limit: 50, total: 0 },
  });
});

describe("aiMetricsState", () => {
  it("resolves ready when the read succeeded, even with zero attempts", () => {
    const metrics = { ...METRICS(0), outcomes: { ...METRICS(0).outcomes, attempts: 0 } };
    expect(aiMetricsState({ error: null, metrics }).kind).toBe("ready");
  });

  it("resolves instrumentation-unavailable for a 501, not an error", () => {
    expect(
      aiMetricsState({ error: new PlatformApiError("not configured", 501), metrics: null }).kind,
    ).toBe("instrumentation-unavailable");
  });

  it("resolves error for a genuine failure", () => {
    expect(
      aiMetricsState({ error: new PlatformApiError("boom", 503), metrics: null }).kind,
    ).toBe("error");
  });
});

describe("currentPath", () => {
  it("carries the page param through for the reauth return URL", () => {
    expect(currentPath({ page: "2" })).toBe("/kora/ai-metrics?page=2");
  });

  it("is the bare path on page one", () => {
    expect(currentPath({})).toBe("/kora/ai-metrics");
  });
});

describe("KoraAiMetricsPage", () => {
  it("reads page one by default", async () => {
    fetchKoraAiMetricsPage.mockResolvedValue({
      metrics: METRICS(1),
      pagination: { page: 1, limit: 50, total: 1 },
    });
    await renderPage();
    expect(fetchKoraAiMetricsPage).toHaveBeenCalledWith(1);
  });

  it("reads the page named in the URL", async () => {
    fetchKoraAiMetricsPage.mockResolvedValue({
      metrics: METRICS(1),
      pagination: { page: 2, limit: 50, total: 51 },
    });
    await renderPage({ page: "2" });
    expect(fetchKoraAiMetricsPage).toHaveBeenCalledWith(2);
  });

  it("renders the outcomes and the window on a successful read", async () => {
    fetchKoraAiMetricsPage.mockResolvedValue({
      metrics: METRICS(1),
      pagination: { page: 1, limit: 50, total: 1 },
    });
    await renderPage();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText(/2026-08-01T00:00:00Z/)).toBeInTheDocument();
  });

  it("renders a legible error rather than crashing when the read fails", async () => {
    fetchKoraAiMetricsPage.mockRejectedValue(new PlatformApiError("kora unreachable", 503));
    await renderPage();
    expect(screen.getByText("kora unreachable")).toBeInTheDocument();
  });

  // 501 (kora not federated to platform-api) is a legitimate state, exactly
  // as part 1's overview already treats it — not an error.
  it("renders a 501 as not measured, not an error", async () => {
    fetchKoraAiMetricsPage.mockRejectedValue(new PlatformApiError("not configured", 501));
    await renderPage();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("KoraAiMetricsPage — user name join", () => {
  it("fetches one page of kora users to join names, not a request per row", async () => {
    fetchKoraAiMetricsPage.mockResolvedValue({
      metrics: METRICS(1),
      pagination: { page: 1, limit: 50, total: 1 },
    });
    fetchProductEntities.mockResolvedValue({
      data: [{ id: "u1", source: "kora", type: "users", label: "mahesh" }],
      pagination: { page: 1, limit: 50, total: 1 },
    });

    await renderPage();

    // ONE read for the whole table, not one per row — the page has one user.
    expect(fetchProductEntities).toHaveBeenCalledTimes(1);
    expect(fetchProductEntities).toHaveBeenCalledWith("kora", "users");
    expect(screen.getByText("mahesh")).toBeInTheDocument();
  });

  // The join read is independent of the metrics read: a failure here must
  // not blank a metrics table that loaded fine.
  it("falls back to the raw id when the name join fails, without blanking the metrics table", async () => {
    fetchKoraAiMetricsPage.mockResolvedValue({
      metrics: METRICS(1),
      pagination: { page: 1, limit: 50, total: 1 },
    });
    fetchProductEntities.mockRejectedValue(new PlatformApiError("entities: boom", 503));

    await renderPage();

    expect(screen.getByText("u1")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});
