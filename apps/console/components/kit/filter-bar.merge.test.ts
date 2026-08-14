import { describe, expect, it } from "vitest";
import { mergeFiltersIntoQuery, PAGE_PARAM, type FilterDescriptor } from "./filter-bar";

const DESCRIPTORS: readonly FilterDescriptor[] = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [{ value: "open", label: "Open" }],
  },
  { key: "q", label: "Search", type: "search" },
];

describe("mergeFiltersIntoQuery", () => {
  it("preserves query params the surface owns but no filter declares", () => {
    // Replacing the whole query string with the filter query is what silently
    // destroyed `sort`, a tab id, or a deep-linked row on every filter change.
    const query = mergeFiltersIntoQuery(
      new URLSearchParams("sort=created_at&dir=desc&tab=gates&row=run-1"),
      DESCRIPTORS,
      { status: "open" },
    );
    const result = new URLSearchParams(query);

    expect(result.get("sort")).toBe("created_at");
    expect(result.get("dir")).toBe("desc");
    expect(result.get("tab")).toBe("gates");
    expect(result.get("row")).toBe("run-1");
    expect(result.get("status")).toBe("open");
  });

  it("drops the page on any filter change", () => {
    // Narrowing a filter while on page 5 would otherwise land on an empty page
    // 5, which resolveState reports as filtered-empty — a correct-looking
    // state for an incorrect cause.
    const query = mergeFiltersIntoQuery(
      new URLSearchParams(`${PAGE_PARAM}=5&sort=created_at`),
      DESCRIPTORS,
      { q: "sunita" },
    );
    const result = new URLSearchParams(query);

    expect(result.has(PAGE_PARAM)).toBe(false);
    expect(result.get("sort")).toBe("created_at");
    expect(result.get("q")).toBe("sunita");
  });

  it("drops the page when filters are cleared, and keeps the rest", () => {
    const query = mergeFiltersIntoQuery(
      new URLSearchParams(`status=open&q=x&${PAGE_PARAM}=3&sort=created_at`),
      DESCRIPTORS,
      {},
    );

    expect(query).toBe("sort=created_at");
  });

  it("removes a filter whose value went blank rather than writing an empty param", () => {
    const query = mergeFiltersIntoQuery(
      new URLSearchParams("status=open&q=x"),
      DESCRIPTORS,
      { status: "", q: "x" },
    );

    expect(query).toBe("q=x");
  });

  it("overwrites rather than appends when a filter is already in the URL", () => {
    const query = mergeFiltersIntoQuery(
      new URLSearchParams("status=open"),
      DESCRIPTORS,
      { status: "closed" },
    );

    expect(query).toBe("status=closed");
  });

  it("leaves an unrelated param that happens to share a filter's shape alone", () => {
    const query = mergeFiltersIntoQuery(
      new URLSearchParams("evil=1"),
      DESCRIPTORS,
      { status: "open" },
    );
    const result = new URLSearchParams(query);

    expect(result.get("evil")).toBe("1");
    expect(result.get("status")).toBe("open");
  });
});
