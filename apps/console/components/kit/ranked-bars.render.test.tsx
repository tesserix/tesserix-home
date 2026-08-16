import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { RankedBars, type RankedBarRow } from "./ranked-bars";

const ROWS: RankedBarRow[] = [
  { key: "closed", label: "Closed", count: 90, share: 0.75 },
  { key: "active", label: "Active", count: 30, share: 0.25 },
];

describe("RankedBars", () => {
  it("shows each row's count and share, which a bar chart hides in a tooltip", () => {
    render(<RankedBars title="By status" rows={ROWS} emptyMessage="Nothing yet." />);

    const list = screen.getByRole("list");
    expect(within(list).getByText("Closed")).toBeInTheDocument();
    expect(within(list).getByText("90 · 75%")).toBeInTheDocument();
    expect(within(list).getByText("30 · 25%")).toBeInTheDocument();
  });

  it("scales the bars to the largest row so the ranking is visible", () => {
    // Scaling to the total instead would make a 40/30/30 split three bars of
    // near-identical width.
    const { container } = render(
      <RankedBars title="By status" rows={ROWS} emptyMessage="Nothing yet." />,
    );

    const widths = Array.from(
      container.querySelectorAll<HTMLElement>("li > span > span"),
    ).map((bar) => bar.style.width);
    expect(widths).toEqual(["100%", `${(30 / 90) * 100}%`]);
  });

  it("reads as empty rather than as an empty list when there is nothing to rank", () => {
    render(<RankedBars title="By reason" rows={[]} emptyMessage="No reasons recorded." />);

    expect(screen.getByText("No reasons recorded.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("defers to a non-ready state over its own row count", () => {
    // A parked endpoint has zero rows too; "no reasons recorded" would claim
    // the data plane answered when it did not.
    render(
      <RankedBars
        title="By reason"
        rows={[]}
        emptyMessage="No reasons recorded."
        state={{ kind: "instrumentation-unavailable" }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Instrumentation unavailable");
    expect(screen.queryByText("No reasons recorded.")).toBeNull();
  });

  it("truncates a long tail and says how much it withheld", () => {
    const many: RankedBarRow[] = Array.from({ length: 11 }, (_, i) => ({
      key: `t${i}`,
      label: `Tenant ${i}`,
      count: 11 - i,
      share: 0.1,
    }));

    render(
      <RankedBars title="By tenant" rows={many} emptyMessage="None." limit={8} />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(9); // 8 rows + the note
    expect(screen.getByText("+3 more")).toBeInTheDocument();
  });
});
