import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { KoraAiMetrics } from "@/lib/kora-ai-metrics";
import { KoraOverview, formatFirstTryRate, type KoraOverviewProps } from "./overview-view";

const READY: KoraOverviewProps["foodsState"] = { kind: "ready" };
const UNAVAILABLE: KoraOverviewProps["foodsState"] = { kind: "instrumentation-unavailable" };
const FAILED: KoraOverviewProps["foodsState"] = { kind: "error", message: "boom" };
const REAUTH: KoraOverviewProps["foodsState"] = { kind: "reauth-required" };

const AI_METRICS = (firstTryRatePct?: number): KoraAiMetrics => ({
  window: { from: "2026-08-01T00:00:00Z", to: "2026-08-28T00:00:00Z" },
  outcomes: { attempts: 42, needsHuman: 2, byKind: { exact: 30, fuzzy: 12 }, firstTryRatePct },
  users: [],
});

const BASE: KoraOverviewProps = {
  foodsTotal: 6421,
  foodsState: READY,
  usersTotal: 318,
  usersState: READY,
  needsAttentionTotal: 4,
  needsAttentionState: READY,
  aiMetrics: AI_METRICS(78),
  aiMetricsState: READY,
  reauthReturnTo: "/kora",
};

function renderOverview(overrides: Partial<KoraOverviewProps> = {}) {
  return render(<KoraOverview {...BASE} {...overrides} />);
}

describe("formatFirstTryRate", () => {
  // THE non-negotiable: Kora returns first_try_rate_pct ABSENT, not 0.0, when
  // the window measured nothing. This must read as "not measured", never 0%.
  it("reads an absent rate as not measured, never as a zero", () => {
    expect(formatFirstTryRate(undefined)).toBe("Not measured");
    expect(formatFirstTryRate(undefined)).not.toMatch(/0/);
  });

  it("renders a measured rate as a rounded percentage", () => {
    expect(formatFirstTryRate(78.5)).toBe("79%");
  });

  // A genuinely measured 0% is a real, different fact from "not measured" —
  // both must be representable and distinguishable.
  it("renders a measured zero as 0%, distinct from not measured", () => {
    expect(formatFirstTryRate(0)).toBe("0%");
  });
});

describe("KoraOverview — the four independent tiles", () => {
  it("renders every tile's number when every read succeeds", () => {
    renderOverview();
    expect(screen.getByText("6421")).toBeInTheDocument();
    expect(screen.getByText("318")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("78%")).toBeInTheDocument();
  });

  // THE case the plan calls the single most likely way this page ships a
  // lie: a successful read whose first_try_rate_pct is absent must render
  // "Not measured" on the page, not "0%" and not "0".
  it("renders 'Not measured' for the AI tile when first_try_rate_pct is absent from an otherwise successful read", () => {
    renderOverview({ aiMetrics: AI_METRICS(undefined) });
    expect(screen.getByText("Not measured")).toBeInTheDocument();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("links the Foods and Users tiles to their own index pages", () => {
    renderOverview();
    expect(screen.getByRole("link", { name: "Foods 6421" })).toHaveAttribute(
      "href",
      "/kora/foods",
    );
    expect(screen.getByRole("link", { name: "Users 318" })).toHaveAttribute(
      "href",
      "/kora/users",
    );
  });

  it("links every AI resolution tile to the full ai-metrics surface", () => {
    renderOverview();
    for (const name of [/resolution attempts/i, /needs human/i, /first-try rate/i]) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", "/kora/ai-metrics");
    }
  });

  it("links Needs attention to the kora-scoped estate inbox", () => {
    renderOverview();
    expect(screen.getByRole("link", { name: /needs attention/i })).toHaveAttribute(
      "href",
      "/platform/inbox?source=kora",
    );
  });

  // One failed read must not blank the other three tiles.
  it("keeps the other three tiles ready when one read failed", () => {
    renderOverview({ foodsState: FAILED, foodsTotal: null });
    expect(screen.getByText("318")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("78%")).toBeInTheDocument();
  });

  // A 501 (this deployment does not federate Kora at all) is a legitimate
  // state, not an error — `StatTile` renders it as "Not measured" rather
  // than a red error line.
  it("renders a 501 tile as not measured rather than an error", () => {
    renderOverview({ foodsState: UNAVAILABLE, foodsTotal: null });
    expect(screen.getByText("Not measured")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // All three AI sub-tiles share the one read: a failed read must show the
  // shared state on every one of them, not silently render a stale number.
  it("shows every AI sub-tile as not-measured when the whole read is 501", () => {
    renderOverview({ aiMetrics: null, aiMetricsState: UNAVAILABLE });
    const notMeasured = screen.getAllByText("Not measured");
    expect(notMeasured.length).toBe(3);
  });

  it("shows one reauth banner, not four, when multiple reads need reauth", () => {
    renderOverview({ foodsState: REAUTH, foodsTotal: null, usersState: REAUTH, usersTotal: null });
    expect(screen.getAllByText(/sign in again/i).length).toBeGreaterThan(0);
    // Only one prompt — not stacked once per failing tile.
    expect(screen.getAllByRole("link", { name: /sign in again/i })).toHaveLength(1);
  });

  it("renders no reauth banner when nothing needs it", () => {
    renderOverview();
    expect(screen.queryByText(/sign in again/i)).toBeNull();
  });
});
