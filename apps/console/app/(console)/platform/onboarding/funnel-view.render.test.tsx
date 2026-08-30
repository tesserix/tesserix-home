import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OnboardingFunnel } from "@/lib/onboarding-funnel";
import { FunnelView, formatMedianCompletion, stageLabel, windowLabel } from "./funnel-view";

// mark8ly's five stages, in the order its handler emits them.
const FUNNEL: OnboardingFunnel = {
  stages: [
    { stage: "started", count: 120 },
    { stage: "email_verified", count: 90 },
    { stage: "completed", count: 40 },
    { stage: "in_flight", count: 15 },
    { stage: "abandoned", count: 65 },
  ],
  medianCompletionSeconds: 842,
  last24h: { started: 7, completed: 2 },
  window: { from: "2026-08-01T00:00:00Z", to: "2026-08-30T00:00:00Z" },
};

function renderView(props: Partial<Parameters<typeof FunnelView>[0]> = {}) {
  render(
    <FunnelView
      funnel={FUNNEL}
      source="mark8ly"
      state={{ kind: "ready" }}
      reauthReturnTo="/platform/onboarding"
      {...props}
    />,
  );
}

describe("stageLabel", () => {
  it("is the product's own word with underscores opened up, nothing else", () => {
    // Presentation only, and reversible by eye. Anything more is a second
    // vocabulary — the exact drift #404's first rule forbids.
    expect(stageLabel("email_verified")).toBe("email verified");
    expect(stageLabel("payment_added")).toBe("payment added");
  });
});

describe("windowLabel", () => {
  it("says all time when the product applied no bound", () => {
    // mark8ly leaves both ends empty when no `created_from`/`created_to` was
    // sent, which is what this console does. Interpolating them produced
    // "mark8ly, to" in production — a fragment that reads as a date that
    // failed to load rather than as an unbounded window.
    expect(windowLabel({ from: "", to: "" })).toBe("all time");
  });

  it("reports a one-sided bound as the bound that exists", () => {
    // Flattening these to "all time" would be wrong in the half that IS
    // bounded, and the counts would be read as covering more than they do.
    expect(windowLabel({ from: "2026-08-01", to: "" })).toBe("from 2026-08-01");
    expect(windowLabel({ from: "", to: "2026-08-30" })).toBe("up to 2026-08-30");
  });

  it("states both ends when the product applied a real window", () => {
    expect(windowLabel({ from: "2026-08-01", to: "2026-08-30" })).toBe(
      "2026-08-01 to 2026-08-30",
    );
  });

  it("treats blank-but-present ends as absent", () => {
    expect(windowLabel({ from: "  ", to: "  " })).toBe("all time");
  });
});

describe("formatMedianCompletion", () => {
  it("says not measurable for null, and never prints a zero", () => {
    expect(formatMedianCompletion(null)).toBe("Not measurable");
    expect(formatMedianCompletion(null)).not.toContain("0");
  });

  it("distinguishes a real zero from an absent measurement", () => {
    expect(formatMedianCompletion(0)).not.toBe("Not measurable");
  });

  it("reads a long median in minutes and seconds", () => {
    expect(formatMedianCompletion(842)).toBe("14m 2s");
  });
});

describe("FunnelView", () => {
  it("renders every stage the product sent, in the product's order", () => {
    renderView();
    const labels = screen
      .getAllByTestId("funnel-stage")
      .map((node) => node.getAttribute("data-stage"));
    expect(labels).toEqual([
      "started",
      "email_verified",
      "completed",
      "in_flight",
      "abandoned",
    ]);
  });

  it("renders a stage this build has never heard of rather than dropping it", () => {
    renderView({
      funnel: {
        ...FUNNEL,
        stages: [...FUNNEL.stages, { stage: "payment_added", count: 12 }],
      },
    });
    expect(screen.getByText("payment added")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("shows a zero stage as the measurement it is", () => {
    renderView({
      funnel: { ...FUNNEL, stages: [{ stage: "completed", count: 0 }] },
    });
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("says not measurable for a null median instead of zero seconds", () => {
    renderView({ funnel: { ...FUNNEL, medianCompletionSeconds: null } });
    expect(screen.getByText("Not measurable")).toBeTruthy();
  });

  it("shows only started and completed in the live pulse", () => {
    // mark8ly's `last24hRow` pins two keys. Rendering the other three counters
    // there would print zeroes the product never measured.
    renderView();
    const pulse = screen.getByTestId("funnel-pulse");
    expect(pulse.textContent).toContain("Started");
    expect(pulse.textContent).toContain("Completed");
    expect(pulse.textContent).not.toContain("Abandoned");
  });

  it("names the window the product actually applied", () => {
    renderView();
    expect(screen.getByTestId("funnel-window").textContent).toContain("2026-08-01");
  });

  it("renders no funnel at all when the read was not made", () => {
    // THE rule: a funnel that could not be read is not a funnel of zeroes. A
    // parked federation must show the parked callout and NOTHING that could be
    // mistaken for a measurement.
    renderView({
      funnel: null,
      state: {
        kind: "instrumentation-unavailable",
        title: "Onboarding is not federated here",
        message: "This deployment federates no onboarding funnel.",
      },
    });
    expect(screen.getByText("Onboarding is not federated here")).toBeTruthy();
    expect(screen.queryAllByTestId("funnel-stage")).toHaveLength(0);
    expect(screen.queryByTestId("funnel-pulse")).toBeNull();
  });

  it("names the product it could not read when the read failed", () => {
    renderView({
      funnel: null,
      state: { kind: "error", message: "mark8ly could not be reached for its funnel" },
    });
    expect(screen.getByText(/mark8ly/)).toBeTruthy();
    expect(screen.queryAllByTestId("funnel-stage")).toHaveLength(0);
  });
});
