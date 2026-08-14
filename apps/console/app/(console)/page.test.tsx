import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlatformApiError } from "@/lib/platform-api";
import { DashboardView, dashboardState } from "./page";

const DATA = {
  tenants: { total: 12, active: 9 },
  stores: { total: 4 },
  leads: {
    by_status: { new: 3, contacted: 2, qualified: 1, converted: 5, lost: 0 },
    total: 11,
  },
  apps: { active: 6 },
  generated_at: "2026-08-14T07:00:00.000Z",
};

describe("dashboardState", () => {
  it("maps a 501 to instrumentation-unavailable, not an error", () => {
    expect(dashboardState(new PlatformApiError("parked", 501))).toEqual({
      kind: "instrumentation-unavailable",
    });
  });

  it("maps a 500 to an error", () => {
    expect(dashboardState(new PlatformApiError("boom", 500))).toEqual({
      kind: "error",
      message: "boom",
    });
  });

  it("maps a transport failure to an error", () => {
    expect(dashboardState(new PlatformApiError("ECONNREFUSED"))).toEqual({
      kind: "error",
      message: "ECONNREFUSED",
    });
  });

  it("reports ready when data arrived", () => {
    expect(dashboardState(null)).toEqual({ kind: "ready" });
  });

  it("maps a non-Error rejection to an error without an undefined message", () => {
    expect(dashboardState("boom")).toEqual({ kind: "error", message: "boom" });
  });
});

describe("DashboardView", () => {
  // NOTE: assertions use plain truthiness rather than jest-dom matchers
  // (`toBeInTheDocument`), because the console's vitest setup may not register
  // jest-dom. If it does, tightening these is fine; do not add the dependency
  // just to satisfy this test.
  it("renders the platform counts", () => {
    render(<DashboardView data={DATA} state={{ kind: "ready" }} />);
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy();
  });

  it("shows the parked message instead of zeroes when uninstrumented", () => {
    render(
      <DashboardView data={null} state={{ kind: "instrumentation-unavailable" }} />,
    );
    // The whole point: a parked plane must never render a confident 0.
    expect(screen.queryByText("0")).toBeNull();
    // Every tile independently renders the parked message, so more than one
    // node matches — assert presence, not a single unique match.
    expect(screen.getAllByText(/not measured/i).length).toBeGreaterThan(0);
  });

  it("renders the error message instead of the parked message on a real failure", () => {
    render(
      <DashboardView data={null} state={{ kind: "error", message: "boom" }} />,
    );
    // Same multi-tile fan-out as above: every tile renders the error message.
    expect(screen.getAllByText("boom").length).toBeGreaterThan(0);
    expect(screen.queryByText(/not measured/i)).toBeNull();
  });
});
