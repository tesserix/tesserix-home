import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultPager, type ResultPagerProps } from "./result-pager";

// The pager is the only thing telling an operator how much of a result set
// they are looking at, so the arithmetic is the contract: a page that lies
// about its position is the same defect class as a queue that silently drops
// 159 rows. The other three cases guard the two conditionals — a "Next" on
// the last page and a "Previous" on the first both promise a page that isn't
// there.

const BASE: ResultPagerProps = {
  label: "organisations",
  count: 100,
  total: 259,
  precedingCount: 0,
  nextHref: "/platform/crm/organisations?cursor=abc",
};

function renderPager(overrides: Partial<ResultPagerProps> = {}) {
  return render(<ResultPager {...BASE} {...overrides} />);
}

describe("ResultPager range", () => {
  it("reports the page's absolute position, not the rows on screen", () => {
    // Page two of a 259-row result: without precedingCount both pages would
    // read "100 of 259" and an operator could not tell them apart.
    renderPager({ precedingCount: 100 });
    expect(screen.getByText("101–200 of 259")).toBeInTheDocument();
  });

  it("starts the first page at 1, not 0", () => {
    renderPager();
    expect(screen.getByText("1–100 of 259")).toBeInTheDocument();
  });

  it("ends a short final page on its own last row", () => {
    renderPager({ precedingCount: 200, count: 59, nextHref: null });
    expect(screen.getByText("201–259 of 259")).toBeInTheDocument();
  });

  it("announces the range politely, so paging is heard without stealing focus", () => {
    renderPager();
    expect(screen.getByText("1–100 of 259")).toHaveAttribute("aria-live", "polite");
  });
});

describe("ResultPager controls", () => {
  it("renders Next as a real link, so results stay back-button-navigable", () => {
    renderPager();
    const next = screen.getByRole("link", { name: "Next page of organisations" });
    expect(next).toHaveAttribute("href", BASE.nextHref);
    expect(next.tagName).toBe("A");
  });

  it("omits Next on the last page rather than offering a dead control", () => {
    renderPager({ precedingCount: 200, count: 59, nextHref: null });
    expect(screen.queryByRole("link", { name: /Next page/ })).toBeNull();
  });

  it("omits Previous when none is supplied", () => {
    // Nothing passes previousHref yet; the prop exists so the bidirectional
    // cursor PR changes no caller's shape.
    renderPager();
    expect(screen.queryByRole("link", { name: /Previous page/ })).toBeNull();
  });

  it("renders Previous as a link when one is supplied", () => {
    renderPager({
      precedingCount: 100,
      previousHref: "/platform/crm/organisations?cursor=xyz",
    });
    const previous = screen.getByRole("link", { name: "Previous page of organisations" });
    expect(previous).toHaveAttribute("href", "/platform/crm/organisations?cursor=xyz");
    expect(previous.tagName).toBe("A");
  });

  it("names its region from the label, so two pagers on one page are distinguishable", () => {
    renderPager({ label: "the drifting queue" });
    expect(
      screen.getByRole("navigation", { name: "the drifting queue pagination" }),
    ).toBeInTheDocument();
  });
});
