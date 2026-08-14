import { describe, expect, it } from "vitest";
import { filtersToQuery, queryToFilters } from "./filter-bar";

const DESCRIPTORS = [
  { key: "status", label: "Status", type: "select" as const,
    options: [{ value: "open", label: "Open" }] },
  { key: "q", label: "Search", type: "search" as const },
];

describe("filter serialisation", () => {
  it("round-trips through a query string", () => {
    const q = filtersToQuery({ status: "open", q: "sunita" });
    expect(queryToFilters(new URLSearchParams(q), DESCRIPTORS))
      .toEqual({ status: "open", q: "sunita" });
  });

  it("drops empty values so the URL stays clean", () => {
    expect(filtersToQuery({ status: "", q: "x" })).toBe("q=x");
  });

  it("ignores query params not in the descriptor list", () => {
    expect(queryToFilters(new URLSearchParams("status=open&evil=1"), DESCRIPTORS))
      .toEqual({ status: "open" });
  });
});
