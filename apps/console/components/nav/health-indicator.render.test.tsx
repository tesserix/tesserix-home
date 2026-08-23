// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// HealthIndicator now renders a next/link. Matches the mock shape used by
// sidebar.render.test.tsx, the other nav component that links via Link.
vi.mock("next/navigation", () => ({ usePathname: () => "/platform/tickets" }));

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

  it("is a link to the health page, resolved through the route helper", () => {
    // Not a hardcoded "/platform/health" — this pins consolePath's actual
    // output for platform.serviceHealth, so a route-table edit that changes
    // the path is caught here too.
    render(<HealthIndicator health={health()} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/platform/health");
  });

  it("carries the full sentence as the link's accessible name, not just the state word", () => {
    // role="status" lives on an inner element (ambient, not an alert) while
    // the anchor stays a link; if the anchor's accessible name collapsed to
    // "Healthy" a screen reader would announce far less than it does today.
    render(<HealthIndicator health={health({ state: "healthy" })} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAccessibleName(
      /Estate healthy: 8 of 8 workloads and 1 of 1 databases ready\./,
    );
  });

  it("renders an icon alongside the state dot, not instead of it", () => {
    render(<HealthIndicator health={health()} />);
    const link = screen.getByRole("link");
    // The icon is decorative (aria-hidden) — assert on the SVG itself rather
    // than an accessible query, since it must not add to the accessible name.
    expect(link.querySelectorAll("svg")).toHaveLength(1);
  });
});
