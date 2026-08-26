import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// `useUrlFilters` reads the router, which jsdom has no app-router context for.
// Mocked exactly as the tenant directory's tests mock it — this surface uses
// the same FilterBar.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/kora/foods",
  useSearchParams: () => new URLSearchParams(),
}));
import { PlatformApiError } from "@/lib/platform-api";
import type { EntityPage } from "@/lib/entities";
import {
  FOOD_EMPTY_MESSAGE,
  FOOD_UNAVAILABLE_MESSAGE,
  FOOD_UNAVAILABLE_TITLE,
  currentPath,
  foodReadError,
  indexState,
  readFoodFilters,
  toFilterValues,
} from "./page";
import { FoodIndex, formatCreated } from "./food-index";

// The page is a server component and cannot be rendered by Testing Library, so
// its logic is exercised through its exported pure functions and the client
// half is rendered directly.

const row = {
  id: "kora:528ea893",
  source: "kora",
  type: "foods",
  label: "Veg kolhapuri",
  createdAt: "2026-08-22T07:16:52Z",
};

const page = (over: Partial<EntityPage> = {}): EntityPage => ({
  data: [row],
  pagination: { page: 1, limit: 100, total: 6421 },
  ...over,
});

describe("readFoodFilters", () => {
  it("reads a search from the URL", () => {
    expect(readFoodFilters({ q: "ragi" })).toEqual({ q: "ragi" });
  });

  // A blank q is a BROWSE. Sending `q=` would filter on the empty string on a
  // product that treats the param as present.
  it("drops a blank search rather than sending it", () => {
    expect(readFoodFilters({ q: "   " })).toEqual({});
    expect(readFoodFilters({})).toEqual({});
  });

  // The endpoint takes one value per key, so honouring the first would apply a
  // filter the bar cannot display.
  it("ignores a repeated parameter", () => {
    expect(readFoodFilters({ q: ["a", "b"] })).toEqual({});
  });

  it("renders the applied filters as the bar's values", () => {
    expect(toFilterValues({ q: "ragi" })).toEqual({ q: "ragi" });
    expect(toFilterValues({})).toEqual({});
  });
});

describe("a 501 is not an error", () => {
  it("attaches this surface's own copy rather than the kit's default", () => {
    const surfaced = foodReadError(new PlatformApiError("not configured", 501));
    expect(surfaced?.unavailable?.title).toBe(FOOD_UNAVAILABLE_TITLE);
    expect(FOOD_UNAVAILABLE_MESSAGE).toMatch(/nothing to retry/);
  });

  it("leaves a real failure alone", () => {
    expect(foodReadError(new PlatformApiError("boom", 503))?.unavailable).toBeUndefined();
  });
});

describe("indexState", () => {
  it("is ready when rows came back", () => {
    expect(indexState({ error: null, rows: [row], filtered: false }).kind).toBe("ready");
  });

  // Unlike the inbox, this surface HAS a search — so "no results, clear the
  // search" is a true and useful thing to say, and a different thing from an
  // empty catalogue.
  it("distinguishes an empty catalogue from a search that matched nothing", () => {
    expect(indexState({ error: null, rows: [], filtered: false }).kind).toBe("empty");
    // `filtered-empty`, the kit's own name for it — the state that renders
    // "no results, clear the search" rather than "there are none".
    expect(indexState({ error: null, rows: [], filtered: true }).kind).toBe("filtered-empty");
  });

  it("replaces the table only when the read threw", () => {
    expect(indexState({ error: new PlatformApiError("boom", 503), rows: [], filtered: false }).kind).toBe(
      "error",
    );
  });
});

describe("formatCreated", () => {
  it("renders a date", () => {
    expect(formatCreated("2026-08-22T07:16:52Z")).toBe("2026-08-22");
  });

  it("renders an em dash when there is none", () => {
    expect(formatCreated(undefined)).toBe("—");
  });

  // Showing what the product sent is how someone finds out what is wrong with
  // it; a placeholder would hide a §4.3 deviation.
  it("renders an unparseable value verbatim rather than inventing one", () => {
    expect(formatCreated("not a date")).toBe("not a date");
  });
});

describe("currentPath", () => {
  it("preserves the operator's exact query so re-auth returns them there", () => {
    expect(currentPath({ q: "ragi" })).toBe("/kora/foods?q=ragi");
    expect(currentPath({})).toBe("/kora/foods");
  });
});

describe("FoodIndex", () => {
  /** A first page with more behind it, so the pager renders both states. */
  const pager = { precedingCount: 0, nextHref: "?page=2", previousHref: null };

  const common = {
    descriptors: [{ key: "q", label: "Search foods", type: "search" as const }],
    values: {},
    emptyMessage: FOOD_EMPTY_MESSAGE,
    scopeNote: "note",
    reauthReturnTo: "/kora/foods",
  };

  it("renders a food with its date", () => {
    render(
      <FoodIndex
        {...common}
        page={page()}
        pager={pager}
        state={indexState({ error: null, rows: [row], filtered: false })}
      />,
    );
    expect(screen.getByText("Veg kolhapuri")).toBeInTheDocument();
    expect(screen.getByText("2026-08-22")).toBeInTheDocument();
  });

  // A RANGE, not a bare count: with a count alone every page reads the same
  // and an operator cannot tell which one they are on. Kora reports 6421
  // foods, so the index is emphatically more than one page.
  it("shows the page's range within the whole index", () => {
    render(
      <FoodIndex
        {...common}
        page={page()}
        pager={pager}
        state={indexState({ error: null, rows: [row], filtered: false })}
      />,
    );
    expect(screen.getByText(/1–1 of 6421/)).toBeInTheDocument();
    // And offers a way to reach row 51 — an index with no pager is a dead end.
    expect(screen.getByRole("link", { name: /next page of foods/i })).toBeInTheDocument();
  });

  // A dead "Next" promises a page that is not there, and an operator who
  // clicks it concludes the surface is broken rather than finished.
  it("offers no next link when the page is the whole index", () => {
    render(
      <FoodIndex
        {...common}
        page={page({ pagination: { page: 1, limit: 100, total: 1 } })}
        pager={{ precedingCount: 0, nextHref: null, previousHref: null }}
        state={indexState({ error: null, rows: [row], filtered: false })}
      />,
    );
    expect(screen.getByText(/1–1 of 1/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /next page/i })).toBeNull();
  });
});
