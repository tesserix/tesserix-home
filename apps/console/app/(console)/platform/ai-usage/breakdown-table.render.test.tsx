import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { AiUsageBreakdownRow } from "@/lib/ai-usage";
import { BreakdownTable, UNATTRIBUTED_LABEL } from "./breakdown-table";

const ROW: AiUsageBreakdownRow = {
  key: "kora",
  requests: 1240,
  tokens: { input: 1000, output: 250, cachedInput: 400 },
  costUsd: 0.0042,
  errors: 2,
  blocked: 3,
};

function renderTable(rows: readonly AiUsageBreakdownRow[]) {
  render(
    <BreakdownTable
      title="By product"
      axisLabel="Product"
      rows={rows}
      state={{ kind: "ready" }}
      emptyMessage="nothing here"
    />,
  );
}

describe("BreakdownTable", () => {
  it("shows sub-cent spend as a cost, not as zero", () => {
    renderTable([ROW]);
    expect(screen.getByText("$0.0042")).toBeInTheDocument();
  });

  it("reports the cache hit rate as a share of input", () => {
    renderTable([ROW]);
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("counts blocked and errored together as refused", () => {
    renderTable([ROW]);
    const row = screen.getByText("kora").closest("tr");
    expect(within(row!).getByText("5")).toBeInTheDocument();
  });

  it("labels the row the gateway could not attribute rather than dropping it", () => {
    // Unattributed spend is the spend most worth seeing.
    renderTable([{ ...ROW, key: "" }]);
    expect(screen.getByText(UNATTRIBUTED_LABEL)).toBeInTheDocument();
  });

  it("renders the state instead of an empty table when the read failed", () => {
    render(
      <BreakdownTable
        title="By product"
        axisLabel="Product"
        rows={[]}
        state={{ kind: "error", message: "upstream is down" }}
        emptyMessage="nothing here"
      />,
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/upstream is down/)).toBeInTheDocument();
  });
});
