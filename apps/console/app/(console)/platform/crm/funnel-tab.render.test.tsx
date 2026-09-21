import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FunnelSummary, StalledRow } from "@/lib/db/crm-repo";
import { CRM_STAGES } from "@/lib/crm";

const funnelSummary = vi.fn();
vi.mock("@/lib/db/crm-repo", () => ({
  funnelSummary: (...args: unknown[]) => funnelSummary(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/platform/crm",
  useSearchParams: () => new URLSearchParams(),
}));

import {
  renderFunnelTab,
  toBreakdownRows,
  toStalledItem,
  breakdownState,
  FUNNEL_EMPTY_MESSAGE,
  STALLED_EMPTY_MESSAGE,
} from "./funnel-tab";

const REAUTH = "/platform/crm?tab=funnel";

function summaryOf(
  counts: Partial<Record<(typeof CRM_STAGES)[number], number>>,
  stalled: StalledRow[] = [],
): FunnelSummary {
  const entries = CRM_STAGES.map((stage) => ({ stage, count: counts[stage] ?? 0 }));
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  return {
    counts: entries.map((entry) => ({
      ...entry,
      share: total === 0 ? 0 : entry.count / total,
    })),
    total,
    stalled,
  };
}

function stalledRow(overrides: Partial<StalledRow> = {}): StalledRow {
  return {
    id: "opp-1",
    organisationId: "org-1",
    organisationName: "Stalled Co",
    product: "mark8ly",
    stage: "contacted",
    owner: "Priya",
    since: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  funnelSummary.mockReset();
});

describe("toBreakdownRows", () => {
  it("keeps the funnel's order, not the ranking", async () => {
    // The component is called RankedBars; the funnel's own order is the
    // information here, so a bigger `lost` must not float to the top.
    const rows = toBreakdownRows(summaryOf({ new: 1, lost: 99 }));

    expect(rows.map((row) => row.key)).toEqual([...CRM_STAGES]);
    expect(rows.map((row) => row.label)).toEqual([
      "New",
      "Contacted",
      "Qualified",
      "Won",
      "Lost",
    ]);
  });
});

describe("toStalledItem", () => {
  it("dates the row from the stage's clock", () => {
    const item = toStalledItem(stalledRow());

    expect(item.waitingSince).toBe("2026-06-01T00:00:00.000Z");
    // A stalled deal has no deadline to miss; supplying one would render an
    // SLA this list does not have.
    expect(item.dueAt).toBeUndefined();
    expect(item.severity).toBe("normal");
    expect(item.href).toBe("/platform/crm/org-1");
    expect(item.status).toEqual({ label: "Contacted", tone: "neutral" });
  });

  it("omits the owner line rather than naming nobody", () => {
    expect(toStalledItem(stalledRow({ owner: null })).subtitle).toBeUndefined();
  });
});

describe("breakdownState", () => {
  it("reads an all-zero funnel as empty, not as five zeroes", () => {
    expect(breakdownState(null, 0)).toEqual({ kind: "empty" });
  });

  it("never reads an empty funnel as filtered-empty, because this tab filters nothing", () => {
    expect(breakdownState(null, 0).kind).not.toBe("filtered-empty");
  });

  it("is ready once there is a deal", () => {
    expect(breakdownState(null, 1)).toEqual({ kind: "ready" });
  });
});

describe("renderFunnelTab", () => {
  it("states a count for every stage", async () => {
    funnelSummary.mockResolvedValue(summaryOf({ new: 7, contacted: 2, won: 1 }));

    render(await renderFunnelTab({ reauthReturnTo: REAUTH }));

    for (const label of ["New", "Contacted", "Qualified", "Won", "Lost"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText(/^7 · /)).toBeInTheDocument();
  });

  it("lists the deals that are not moving", async () => {
    funnelSummary.mockResolvedValue(
      summaryOf({ contacted: 1 }, [stalledRow({ organisationName: "Quiet Bakery" })]),
    );

    render(await renderFunnelTab({ reauthReturnTo: REAUTH }));

    expect(screen.getByText("Quiet Bakery")).toBeInTheDocument();
    expect(screen.getByText("Owner: Priya")).toBeInTheDocument();
  });

  it("says the pipeline is empty rather than rendering five zeroes", async () => {
    funnelSummary.mockResolvedValue(summaryOf({}));

    render(await renderFunnelTab({ reauthReturnTo: REAUTH }));

    expect(screen.getByText(FUNNEL_EMPTY_MESSAGE)).toBeInTheDocument();
  });

  it("says nothing is stalled when the pipeline has deals but none are sitting still", async () => {
    funnelSummary.mockResolvedValue(summaryOf({ won: 3 }));

    render(await renderFunnelTab({ reauthReturnTo: REAUTH }));

    expect(screen.getByText(STALLED_EMPTY_MESSAGE)).toBeInTheDocument();
  });

  it("renders NEITHER half when the read fails, so a failure cannot read as a healthy pipeline", async () => {
    funnelSummary.mockRejectedValue(new Error("pg down"));

    render(await renderFunnelTab({ reauthReturnTo: REAUTH }));

    // The half that would otherwise say "nothing is stuck".
    expect(screen.queryByText(STALLED_EMPTY_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByText(FUNNEL_EMPTY_MESSAGE)).not.toBeInTheDocument();
    // And it must not leak the Postgres message to an operator.
    expect(screen.queryByText(/pg down/)).not.toBeInTheDocument();
  });

  it("never renders a raw Postgres message", async () => {
    funnelSummary.mockRejectedValue(new Error("relation \"crm_opportunities\" does not exist"));

    render(await renderFunnelTab({ reauthReturnTo: REAUTH }));

    expect(screen.queryByText(/relation/)).not.toBeInTheDocument();
  });
});
