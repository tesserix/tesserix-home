import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/health", () => ({ readEstateHealth: vi.fn() }));
vi.mock("@tesserix/platform-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentSession: vi.fn(),
}));
vi.mock("@/lib/internal-access", () => ({ requiresCapability: vi.fn() }));

import { readEstateHealth } from "@/lib/health";
import { getCurrentSession } from "@tesserix/platform-auth";
import { requiresCapability } from "@/lib/internal-access";
import HealthPage from "./page";

// `hasCapability` and `routeCapability` are deliberately left un-mocked: the
// gating this page performs is exactly what the ablation below is proving,
// and a mocked `hasCapability` would make that gate a no-op regardless of
// what `routes.ts` actually declares. See the ablation instructions in the
// task brief this test file was written for.

function health(overrides: Partial<Awaited<ReturnType<typeof readEstateHealth>>> = {}) {
  return {
    state: "healthy" as const,
    stale: false,
    checkedAt: "2026-08-23T12:00:00Z",
    reason: null,
    workloads: { total: 8, ready: 8 },
    databases: { total: 1, ready: 1 },
    ...overrides,
  };
}

/** An operator holding only the console-entry ticket — nothing else. */
function readOnlySession() {
  vi.mocked(requiresCapability).mockReturnValue(true);
  vi.mocked(getCurrentSession).mockResolvedValue({
    sub: "op-1",
    email: "op@t.test",
    roles: ["read"],
  } as never);
}

afterEach(() => vi.resetAllMocks());

describe("the health page", () => {
  it("renders the healthy state", async () => {
    readOnlySession();
    vi.mocked(readEstateHealth).mockResolvedValue(health({ state: "healthy" }));

    render(await HealthPage());

    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("renders the degraded state", async () => {
    readOnlySession();
    vi.mocked(readEstateHealth).mockResolvedValue(
      health({ state: "degraded", reason: "mp-orders 0/2 ready" }),
    );

    render(await HealthPage());

    expect(screen.getByText("Degraded")).toBeInTheDocument();
  });

  it("renders the unmeasured state", async () => {
    readOnlySession();
    vi.mocked(readEstateHealth).mockResolvedValue(
      health({ state: "unmeasured", workloads: { total: 0, ready: 0 }, databases: { total: 0, ready: 0 } }),
    );

    render(await HealthPage());

    expect(screen.getByText("Unmeasured")).toBeInTheDocument();
  });

  it("renders the degraded reason as text, not only in an attribute", async () => {
    readOnlySession();
    vi.mocked(readEstateHealth).mockResolvedValue(
      health({ state: "degraded", reason: "mp-orders 0/2 ready" }),
    );

    render(await HealthPage());

    // Not `getByTitle` — the whole point is that this text is reachable
    // without a mouse, which a `title` attribute is not. `getAllByText`
    // rather than `getByText`: the reason legitimately appears twice (the
    // state section's accessible sentence, and the measured section's own
    // line), and both are real text, not an attribute.
    expect(screen.getAllByText(/mp-orders 0\/2 ready/).length).toBeGreaterThan(0);
  });

  it("breaks a multi-problem reason onto separate lines", async () => {
    readOnlySession();
    vi.mocked(readEstateHealth).mockResolvedValue(
      health({
        state: "degraded",
        reason: "mp-orders 0/2 ready; products_db unreachable",
      }),
    );

    render(await HealthPage());

    const first = screen.getByText("mp-orders 0/2 ready");
    const second = screen.getByText("products_db unreachable");

    expect(first).toBeInTheDocument();
    expect(second).toBeInTheDocument();
    // Two distinct text nodes, not one string containing both — that is what
    // "separate lines" means for a DOM assertion.
    expect(first).not.toBe(second);
  });

  it("names all three not-yet-measured concerns", async () => {
    readOnlySession();
    vi.mocked(readEstateHealth).mockResolvedValue(health());

    render(await HealthPage());

    expect(screen.getByText(/Uptime/)).toBeInTheDocument();
    expect(screen.getByText(/Observability/)).toBeInTheDocument();
    expect(screen.getByText(/Custom domains/)).toBeInTheDocument();
  });

  it("never badges the not-yet-measured concerns as SOON", async () => {
    readOnlySession();
    vi.mocked(readEstateHealth).mockResolvedValue(health());

    render(await HealthPage());

    // Badging them SOON would just relocate the placeholder this page exists
    // to replace with an honest "nothing measures this yet".
    expect(screen.queryByText(/SOON/)).not.toBeInTheDocument();
  });

  it("does not list Databases or Service health as unmeasured", async () => {
    readOnlySession();
    vi.mocked(readEstateHealth).mockResolvedValue(health());

    render(await HealthPage());

    // "Databases" is a substring of nothing else on the not-yet-measured
    // list, so this is safe against the workload/database count labels,
    // which read "Databases ready" rather than bare "Databases".
    expect(screen.queryByText("Databases")).not.toBeInTheDocument();
    expect(screen.queryByText("Service health")).not.toBeInTheDocument();
  });

  it("renders for an operator holding only the console-entry ticket", async () => {
    // This is the ablation target: `routeCapability("platform.serviceHealth")`
    // must resolve to "read", which every operator holds. If routes.ts ever
    // regresses that to "platform", this operator (roles: ["read"]) is
    // refused and this assertion fails.
    readOnlySession();
    vi.mocked(readEstateHealth).mockResolvedValue(health());

    render(await HealthPage());

    expect(screen.queryByText(/do not have permission/i)).not.toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("refuses an operator with no roles at all", async () => {
    vi.mocked(requiresCapability).mockReturnValue(true);
    vi.mocked(getCurrentSession).mockResolvedValue({
      sub: "op-2",
      email: "op2@t.test",
      roles: [],
    } as never);
    vi.mocked(readEstateHealth).mockResolvedValue(health());

    render(await HealthPage());

    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
  });
});
