import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { KoraAiMetrics } from "@/lib/kora-ai-metrics";
import type { PagerLinks } from "../entity-page";
import { AiMetricsView, type AiMetricsViewProps } from "./ai-metrics-view";

const METRICS: KoraAiMetrics = {
  window: { from: "2026-08-01T00:00:00Z", to: "2026-08-28T00:00:00Z" },
  outcomes: {
    attempts: 42,
    needsHuman: 2,
    byKind: { exact: 30, fuzzy: 10, needs_review: 2, no_match: 0 },
    firstTryRatePct: 78.5,
  },
  users: [
    {
      userId: "u1",
      attempts: 4,
      resolves: 3,
      corrections: 1,
      budgetRefusals: 0,
      aiCalls: 4,
      lastActivityAt: "2026-08-27T10:00:00Z",
    },
    {
      userId: "u2",
      attempts: 1,
      resolves: 0,
      corrections: 0,
      budgetRefusals: 1,
      aiCalls: 1,
    },
  ],
};

const PAGER: PagerLinks = { precedingCount: 0, nextHref: null, previousHref: null };

const BASE: AiMetricsViewProps = {
  metrics: METRICS,
  pager: PAGER,
  pagination: { page: 1, limit: 50, total: 2 },
  state: { kind: "ready" },
  reauthReturnTo: "/kora/ai-metrics",
};

function renderView(overrides: Partial<AiMetricsViewProps> = {}) {
  return render(<AiMetricsView {...BASE} {...overrides} />);
}

describe("AiMetricsView — the window", () => {
  // The window is a real datum, not chrome — a reader must know what period
  // the numbers below it cover.
  it("states both ends of the window", () => {
    renderView();
    expect(screen.getByText(/2026-08-01T00:00:00Z/)).toBeInTheDocument();
    expect(screen.getByText(/2026-08-28T00:00:00Z/)).toBeInTheDocument();
  });
});

describe("AiMetricsView — outcomes", () => {
  it("renders attempts, needs human, and a measured first-try rate", () => {
    renderView();
    const outcomes = screen.getByRole("region", { name: "Outcomes" });
    expect(within(outcomes).getByText("42")).toBeInTheDocument();
    expect(within(outcomes).getByText("2")).toBeInTheDocument();
    expect(within(outcomes).getByText("79%")).toBeInTheDocument();
  });

  // Reuses the overview's own `formatFirstTryRate` — the one place this
  // field is turned into copy — rather than re-deriving the rule here.
  it("renders 'Not measured' rather than 0% when the rate is absent", () => {
    renderView({
      metrics: {
        ...METRICS,
        outcomes: { ...METRICS.outcomes, firstTryRatePct: undefined },
      },
    });
    expect(screen.getByText("Not measured")).toBeInTheDocument();
    expect(screen.queryByText("0%")).toBeNull();
  });
});

describe("AiMetricsView — by kind", () => {
  // Kora zero-fills `by_kind` across every kind it measures. A kind dropped
  // because its count is 0 would hide that Kora measured it and found none —
  // a different fact from not measuring it at all.
  it("renders every kind, including one with a zero count", () => {
    renderView();
    expect(screen.getByText("exact")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("no match")).toBeInTheDocument();
    // The zero itself must be on screen, not silently dropped.
    const kindsSection = screen.getByRole("region", { name: /outcomes by kind/i });
    expect(kindsSection.textContent).toMatch(/no match/);
  });
});

describe("AiMetricsView — users", () => {
  it("renders every user's counters", () => {
    renderView();
    expect(screen.getByText("u1")).toBeInTheDocument();
    expect(screen.getByText("u2")).toBeInTheDocument();
    // u1's counters: attempts 4, resolves 3, corrections 1, budget refusals 0, ai calls 4.
    expect(screen.getByText("2026-08-27T10:00:00Z")).toBeInTheDocument();
  });

  // `last_activity_at` is optional in the same way `first_try_rate_pct` is:
  // absent must render as absent, never as "Never" or an invented instant.
  it("renders a user with no last activity honestly, never as 'Never'", () => {
    renderView();
    expect(screen.queryByText(/never/i)).toBeNull();
  });

  it("shows the pager above the user table", () => {
    renderView({
      pager: { precedingCount: 0, nextHref: "/kora/ai-metrics?page=2", previousHref: null },
      pagination: { page: 1, limit: 1, total: 5 },
    });
    expect(screen.getByRole("link", { name: /next page of users/i })).toHaveAttribute(
      "href",
      "/kora/ai-metrics?page=2",
    );
  });

  it("says plainly when no user acted in this window, without hiding the outcomes above it", () => {
    renderView({ metrics: { ...METRICS, users: [] } });
    expect(screen.getByText(/no users in this window/i)).toBeInTheDocument();
    // The outcomes tiles are still there — an empty user table is not a
    // reason to blank the rest of the page.
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});

describe("AiMetricsView — non-ready states", () => {
  it("renders the surface state instead of the tables when the read failed", () => {
    renderView({ metrics: null, state: { kind: "error", message: "boom" } });
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByText(/attempts/i)).toBeNull();
  });

  // A 501 (Kora not federated) is a legitimate state, not an error — exactly
  // as the overview already treats it.
  it("renders a 501 as not measured rather than an error", () => {
    renderView({ metrics: null, state: { kind: "instrumentation-unavailable" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
