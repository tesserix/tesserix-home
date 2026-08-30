import { describe, expect, it } from "vitest";
import { pageHref, readPage, sessionsPager } from "./pager";

describe("readPage", () => {
  it("reads a positive page from the URL", () => {
    expect(readPage({ page: "4" })).toBe(4);
  });

  it("falls back to the first page rather than refusing a hand-edited URL", () => {
    // Deliberately gentler than the platform API, which 400s the same input.
    for (const page of ["abc", "0", "-2", "", undefined]) {
      expect(readPage({ page })).toBe(1);
    }
  });

  it("ignores a repeated page param rather than picking one", () => {
    expect(readPage({ page: ["2", "3"] })).toBe(1);
  });
});

describe("pageHref", () => {
  it("keeps the source and every filter, so Next stays inside the query asked", () => {
    const href = pageHref({ source: "mark8ly", status: "in_progress", page: "2" }, 3);
    const url = new URL(href, "http://console.test");
    expect(url.pathname).toBe("/platform/onboarding/sessions");
    expect(url.searchParams.get("source")).toBe("mark8ly");
    expect(url.searchParams.get("status")).toBe("in_progress");
    expect(url.searchParams.get("page")).toBe("3");
  });

  it("gives the first page one canonical URL rather than two that render alike", () => {
    expect(pageHref({ page: "2" }, 1)).toBe("/platform/onboarding/sessions");
    expect(pageHref({}, 1)).toBe("/platform/onboarding/sessions");
  });
});

describe("sessionsPager", () => {
  it("counts preceding rows from the size the product APPLIED", () => {
    // 20, not the 50 this console asked for. Using the request would claim 100
    // rows had been seen when 40 had — silently, and in the direction that
    // makes an operator stop early.
    expect(sessionsPager({}, 3, 20, 137, 20, 50).precedingCount).toBe(40);
  });

  it("falls back to the requested size only when the API reported none", () => {
    expect(sessionsPager({}, 3, 50, 137, null, 50).precedingCount).toBe(100);
    // Page 1 multiplies it by zero, so the fallback cannot matter where it is
    // most likely to be wrong.
    expect(sessionsPager({}, 1, 50, 137, null, 50).precedingCount).toBe(0);
  });

  it("offers no next page once this one reaches the total", () => {
    // The classic off-by-one: an exact multiple of the page size must not
    // offer an empty page past the end.
    expect(sessionsPager({}, 2, 50, 100, 50, 50).nextHref).toBeNull();
    expect(sessionsPager({}, 2, 50, 101, 50, 50).nextHref).not.toBeNull();
  });

  it("offers no previous page on the first", () => {
    expect(sessionsPager({}, 1, 50, 500, 50, 50).previousHref).toBeNull();
    expect(sessionsPager({}, 2, 50, 500, 50, 50).previousHref).toBe(
      "/platform/onboarding/sessions",
    );
  });
});
