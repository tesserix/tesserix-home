import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FilterBar, SEARCH_DEBOUNCE_MS, SearchFilterInput } from "./filter-bar";

// The search box is the one kit primitive with a lifecycle: a controlled input
// fed by async router state drops characters, and a commit per keystroke means
// a navigation and a refetch per keystroke. Neither failure is visible from a
// pure-function test.

function typeInto(input: HTMLElement, text: string) {
  for (let i = 1; i <= text.length; i += 1) {
    fireEvent.change(input, { target: { value: text.slice(0, i) } });
  }
}

describe("SearchFilterInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps every character the user typed, without waiting for the URL", () => {
    const onCommit = vi.fn();
    render(<SearchFilterInput label="Search" value="" onCommit={onCommit} />);
    const input = screen.getByLabelText("Search");

    typeInto(input, "sunita");

    expect(input).toHaveValue("sunita");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits once, after typing pauses", () => {
    const onCommit = vi.fn();
    render(<SearchFilterInput label="Search" value="" onCommit={onCommit} />);
    const input = screen.getByLabelText("Search");

    typeInto(input, "sunita");
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    });
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("sunita");
  });

  it("commits immediately on blur, and the cancelled debounce does not fire again", () => {
    const onCommit = vi.fn();
    render(<SearchFilterInput label="Search" value="" onCommit={onCommit} />);
    const input = screen.getByLabelText("Search");

    typeInto(input, "sun");
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("sun");

    // A stale timer re-firing here costs a redundant router.replace and the
    // refetch behind it.
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    });
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("commits immediately on Enter, and the cancelled debounce does not fire again", () => {
    const onCommit = vi.fn();
    render(<SearchFilterInput label="Search" value="" onCommit={onCommit} />);
    const input = screen.getByLabelText("Search");

    typeInto(input, "sun");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("sun");

    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    });
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("does not commit when blurred without a change", () => {
    const onCommit = vi.fn();
    render(<SearchFilterInput label="Search" value="sun" onCommit={onCommit} />);

    fireEvent.blur(screen.getByLabelText("Search"));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("lets an external change (back button, clear filters) win over the draft", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <SearchFilterInput label="Search" value="sun" onCommit={onCommit} />,
    );
    const input = screen.getByLabelText("Search");

    typeInto(input, "sunita");
    rerender(<SearchFilterInput label="Search" value="" onCommit={onCommit} />);

    expect(input).toHaveValue("");
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

/**
 * A filter whose "unset" state is a real, narrow scope rather than "no
 * filter".
 *
 * The Trials view is the case: its default is the product's 7-day expiry
 * window, which is always in effect. Rendering the usual "All expiring" item
 * there would offer an option the surface cannot honour — choosing it clears
 * the param and lands back on 7 days — which is the same invisible-scope bug
 * that filter exists to fix.
 */
describe("FilterBar with a default-valued select", () => {
  const DESCRIPTORS = [
    {
      key: "days",
      label: "Expiring",
      type: "select" as const,
      defaultValue: "7",
      options: [
        { value: "7", label: "Next 7 days" },
        { value: "30", label: "Next 30 days" },
      ],
    },
  ];

  function open() {
    render(
      <FilterBar
        descriptors={DESCRIPTORS}
        values={{}}
        onChange={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Expiring"));
  }

  // Asserted on the trigger's own text — what an operator actually reads —
  // and on the option Radix marks checked. NOT on `aria-selected`: this
  // version of Radix leaves that "false" on every item including the checked
  // one, so an `aria-selected` assertion would fail against a correct render.
  it("shows the default as the selected option when the URL says nothing", () => {
    open();
    expect(screen.getByLabelText("Expiring")).toHaveTextContent("Next 7 days");
    expect(screen.getByRole("option", { name: "Next 7 days" })).toHaveAttribute(
      "data-state",
      "checked",
    );
  });

  it("offers no 'all' escape hatch, because there is no unfiltered state", () => {
    open();
    expect(screen.queryByRole("option", { name: /^All / })).toBeNull();
  });

  // A default that is merely the default is not an active filter: showing
  // "Clear filters" for it would offer to clear something nobody set.
  it("does not count the default as an active filter", () => {
    open();
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
  });

  // Unchanged for every other surface: a select with no default still offers
  // the "no filter" item, and that item still means "no filter".
  it("keeps the 'all' item for a filter that has no default", () => {
    render(
      <FilterBar
        descriptors={[{ key: "product", label: "Product", type: "select", options: [] }]}
        values={{}}
        onChange={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Product"));
    expect(screen.getByRole("option", { name: "All product" })).toBeInTheDocument();
  });
});
