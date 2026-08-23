// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthIndicator } from "./health-indicator";
import type { EstateHealth } from "@/lib/health";

function health(overrides: Partial<EstateHealth> = {}): EstateHealth {
  return {
    state: "healthy",
    stale: false,
    checkedAt: "2026-08-23T12:00:00Z",
    reason: null,
    workloads: { total: 8, ready: 8 },
    databases: { total: 1, ready: 1 },
    ...overrides,
  };
}

describe("HealthIndicator", () => {
  it("names each state in text, not colour alone", () => {
    // WCAG 2.1 AA: colour cannot be the only carrier of meaning, and an
    // operator with a red/green deficiency is exactly the person who most
    // needs this to be legible.
    for (const state of ["healthy", "degraded", "unmeasured"] as const) {
      const { unmount } = render(<HealthIndicator health={health({ state })} />);
      expect(screen.getByRole("status")).toHaveTextContent(new RegExp(state, "i"));
      unmount();
    }
  });

  it("gives unmeasured a different accessible description from healthy", () => {
    // The whole feature. If these two read the same to a screen reader, the
    // indicator is lying to the operators who cannot see the colour.
    const first = render(<HealthIndicator health={health({ state: "healthy" })} />);
    const healthy = screen.getByRole("status").getAttribute("aria-label");
    // Unmounted rather than left in the document: two `status` roles on the
    // page would make the second getByRole throw on ambiguity, and Testing
    // Library's cleanup only runs between tests, not within one.
    first.unmount();

    render(<HealthIndicator health={health({ state: "unmeasured" })} />);
    const unmeasured = screen.getByRole("status").getAttribute("aria-label");

    expect(unmeasured).not.toBe(healthy);
  });

  it("says so when the reading is stale", () => {
    render(<HealthIndicator health={health({ stale: true })} />);
    expect(screen.getByRole("status")).toHaveAccessibleName(/stale|last known/i);
  });

  it("names what is degraded", () => {
    render(
      <HealthIndicator
        health={health({ state: "degraded", reason: "mp-orders 0/2 ready" })}
      />,
    );
    expect(screen.getByRole("status")).toHaveAccessibleName(/mp-orders/);
  });
});
