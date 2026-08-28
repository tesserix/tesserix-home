import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fetchKoraAiMetricsPage = vi.fn();

vi.mock("@/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-api")>()),
  fetchKoraAiMetricsPage: (...args: unknown[]) => fetchKoraAiMetricsPage(...args),
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
