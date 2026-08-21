import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  INSTRUMENTATION_UNAVAILABLE_MESSAGE,
  SurfaceStateView,
  type SurfaceStateViewProps,
} from "./states";

// resolveState decides *which* state a surface is in; states.test.ts covers
// that. This covers the other half: that each state actually renders a
// treatment an operator can tell apart from the others. The one that matters
// most is instrumentation-unavailable — the whole reason there are five states
// and not four is that it must not read as "empty" or as "failed".

function renderState(
  state: SurfaceStateViewProps["state"],
  extra: Partial<SurfaceStateViewProps> = {},
) {
  return render(
    <SurfaceStateView state={state} emptyMessage="Runs appear here." {...extra} />,
  );
}

describe("SurfaceStateView", () => {
  it("renders nothing for ready, so callers can mount it unconditionally", () => {
    const { container } = renderState({ kind: "ready" });
    expect(container).toBeEmptyDOMElement();
  });

  it("marks the loading treatment busy", () => {
    renderState({ kind: "loading" });
    expect(screen.getByLabelText("Loading")).toHaveAttribute("aria-busy", "true");
  });

  it("renders the caller's copy for empty", () => {
    renderState({ kind: "empty" });
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.getByText("Runs appear here.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers a way out of filtered-empty when the caller can clear filters", () => {
    const onClearFilters = vi.fn();
    renderState({ kind: "filtered-empty" }, { onClearFilters });
    expect(screen.getByText("No matches")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClearFilters).toHaveBeenCalledOnce();
  });

  it("renders the failure message for error", () => {
    renderState({ kind: "error", message: "approval service returned 503" });
    expect(screen.getByText("approval service returned 503")).toBeInTheDocument();
    expect(screen.queryByText("Nothing here yet")).toBeNull();
  });

  it("renders instrumentation-unavailable as a parked notice, not as empty or error", () => {
    renderState({ kind: "instrumentation-unavailable" });

    expect(screen.getByText("Instrumentation unavailable")).toBeInTheDocument();
    expect(screen.getByText(INSTRUMENTATION_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    // A status, not an alert: nothing failed and there is nothing to retry.
    expect(screen.getByRole("status")).toBeInTheDocument();

    // Distinct from the other two "no data on screen" treatments, and from the
    // error treatment: no retry is offered because a retry cannot help.
    expect(screen.queryByText("Nothing here yet")).toBeNull();
    expect(screen.queryByText("No matches")).toBeNull();
    expect(screen.queryByText("Runs appear here.")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("keeps the instrumentation icon on the same row as its title", () => {
    // Callout renders a bare padded div with no icon slot, so an icon placed
    // as a plain sibling of the h5 wraps onto its own line above the heading.
    // Assert the structure that prevents it: one flex row holding both.
    const { container } = renderState({ kind: "instrumentation-unavailable" });

    const icon = container.querySelector("svg");
    const title = screen.getByText("Instrumentation unavailable");
    const row = icon?.parentElement;

    expect(row).not.toBeNull();
    expect(row?.className).toContain("flex");
    expect(row?.contains(title)).toBe(true);
  });
});

describe("SurfaceStateView — reauth-required", () => {
  it("tells the operator that signing in again restores the surface", () => {
    render(<SurfaceStateView state={{ kind: "reauth-required" }} emptyMessage="no tickets" />);
    expect(screen.getByRole("link", { name: /sign in again/i })).toBeInTheDocument();
  });

  it("returns the operator to where they were", () => {
    render(
      <SurfaceStateView
        state={{ kind: "reauth-required" }}
        emptyMessage="no tickets"
        reauthReturnTo="/platform/crm?stage=new"
      />,
    );
    expect(screen.getByRole("link", { name: /sign in again/i })).toHaveAttribute(
      "href",
      "/auth/login?returnTo=%2Fplatform%2Fcrm%3Fstage%3Dnew",
    );
  });

  it("falls back to a bare login link when no returnTo is given", () => {
    render(<SurfaceStateView state={{ kind: "reauth-required" }} emptyMessage="no tickets" />);
    expect(screen.getByRole("link", { name: /sign in again/i })).toHaveAttribute(
      "href",
      "/auth/login",
    );
  });

  it("does not name a token, an ADR, or a database row", () => {
    const { container } = render(
      <SurfaceStateView state={{ kind: "reauth-required" }} emptyMessage="no tickets" />,
    );
    expect(container.textContent).not.toMatch(/token|ADR-003|operator_api_tokens/i);
  });

  it("is not an error state — it offers no retry", () => {
    render(
      <SurfaceStateView
        state={{ kind: "reauth-required" }}
        emptyMessage="no tickets"
        onRetry={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /retry|try again/i })).toBeNull();
  });
});
