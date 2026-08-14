import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SEARCH_DEBOUNCE_MS, SearchFilterInput } from "./filter-bar";

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
