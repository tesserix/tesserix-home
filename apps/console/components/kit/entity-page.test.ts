import { describe, expect, it } from "vitest";

import { pageHref, pagerLinks, readPage } from "./entity-page";

describe("readPage", () => {
  it("defaults to the first page", () => {
    expect(readPage({})).toBe(1);
  });

  it("reads a page from the URL", () => {
    expect(readPage({ page: "4" })).toBe(4);
  });

  // Deliberately gentler than the platform API, which 400s the same input: an
  // operator who hand-edits the URL should see the first page, not an error.
  it("treats nonsense as the first page rather than refusing it", () => {
    for (const raw of ["0", "-2", "abc", "1.5e3", ""]) {
      expect(readPage({ page: raw }), `page=${raw}`).toBe(1);
    }
  });

  it("ignores a repeated parameter", () => {
    expect(readPage({ page: ["2", "3"] })).toBe(1);
  });
});

describe("pageHref", () => {
  // An operator on page 2 of a search who clicks Next must stay in that
  // search. Dropping `q` would silently move them to page 3 of everything,
  // which looks like the search broke.
  it("preserves the search when paging", () => {
    expect(pageHref("/kora/foods", { q: "ragi", page: "2" }, 3)).toBe(
      "/kora/foods?q=ragi&page=3",
    );
  });

  // One canonical URL for the first page, not two that render identically.
  it("omits the page param on page 1", () => {
    expect(pageHref("/kora/foods", { q: "ragi", page: "2" }, 1)).toBe("/kora/foods?q=ragi");
    expect(pageHref("/kora/foods", { page: "5" }, 1)).toBe("/kora/foods");
  });

  it("preserves params it does not own", () => {
    expect(pageHref("/kora/users", { q: "a", tab: "x" }, 2)).toMatch(/tab=x/);
  });
});

describe("pagerLinks", () => {
  // ENTITIES_LIMIT is 50.
  it("offers no previous link on the first page", () => {
    const links = pagerLinks("/kora/foods", {}, 1, 50, 6421);
    expect(links.previousHref).toBeNull();
    expect(links.nextHref).toBe("/kora/foods?page=2");
    expect(links.precedingCount).toBe(0);
  });

  it("counts the rows ahead of a later page", () => {
    expect(pagerLinks("/kora/foods", {}, 3, 50, 6421).precedingCount).toBe(100);
  });

  // A dead "Next" promises a page that is not there, and an operator who
  // clicks it concludes the surface is broken rather than finished.
  it("offers no next link on the last page", () => {
    const links = pagerLinks("/kora/foods", {}, 2, 30, 80);
    expect(links.nextHref).toBeNull();
    expect(links.previousHref).toBe("/kora/foods");
  });

  // THE off-by-one this function exists to prevent: a result set that is an
  // exact multiple of the page size would offer one empty page past the end if
  // `next` were derived from `rows.length === limit`.
  it("offers no next page when the total is an exact multiple of the page size", () => {
    const links = pagerLinks("/kora/foods", {}, 2, 50, 100);
    expect(links.nextHref).toBeNull();
  });

  it("offers a next page when there is genuinely one more row", () => {
    expect(pagerLinks("/kora/foods", {}, 2, 50, 101).nextHref).toBe("/kora/foods?page=3");
  });

  it("handles a single short page", () => {
    const links = pagerLinks("/kora/users", {}, 1, 18, 18);
    expect(links.nextHref).toBeNull();
    expect(links.previousHref).toBeNull();
  });
});
