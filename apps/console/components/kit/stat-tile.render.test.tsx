import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { INSTRUMENTATION_UNAVAILABLE_MESSAGE } from "./states";
import { StatTile } from "./stat-tile";

// A stat tile is exactly where a parked observability endpoint's number lands,
// so it has to be able to say "we are not measuring this" — distinctly from
// "there is nothing to measure" and from "the request failed".

describe("StatTile", () => {
  it("renders a ready value and its delta", () => {
    render(<StatTile label="Runs today" value={42} delta="+3" trend="up" />);
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("+3")).toBeInTheDocument();
  });

  it("formats a Money value rather than stringifying the object", () => {
    render(<StatTile label="Spend" value={{ minor: 123400, currency: "INR" }} />);
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
    expect(screen.getByText(/1234/)).toBeInTheDocument();
  });

  it("still honours the legacy loading prop", () => {
    render(<StatTile label="Runs today" value={42} loading />);
    expect(screen.getByLabelText("Runs today loading")).toBeInTheDocument();
    expect(screen.queryByText("42")).toBeNull();
  });

  it("renders instrumentation-unavailable as a compact parked notice", () => {
    render(
      <StatTile
        label="Runs today"
        value={42}
        delta="+3"
        state={{ kind: "instrumentation-unavailable" }}
      />,
    );

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Not measured");
    expect(notice).toHaveTextContent(INSTRUMENTATION_UNAVAILABLE_MESSAGE);

    // Not the coerced value, not a permanent skeleton, and no stale delta.
    expect(screen.queryByText("42")).toBeNull();
    expect(screen.queryByText("+3")).toBeNull();
    expect(screen.queryByLabelText("Runs today loading")).toBeNull();

    // Compact, not the full Callout the table uses.
    expect(screen.queryByText("Instrumentation unavailable")).toBeNull();
  });

  it("keeps instrumentation-unavailable distinct from empty and from error", () => {
    const { rerender } = render(
      <StatTile label="Runs today" value={42} state={{ kind: "empty" }} />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No data")).toBeInTheDocument();

    rerender(
      <StatTile label="Runs today" value={42} state={{ kind: "error", message: "boom" }} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Not measured")).toBeNull();

    rerender(
      <StatTile
        label="Runs today"
        value={42}
        state={{ kind: "instrumentation-unavailable" }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Not measured");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No data")).toBeNull();
  });
});
