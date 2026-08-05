import { beforeEach, describe, expect, it, vi } from "vitest";

// The page's whole reason for existing is that a failed upstream call never
// masquerades as "no results" — the previous implementer verified this with
// a temporary vitest test, confirmed it, then deleted the file. That leaves
// the property unprotected: the next edit to this page can silently
// reintroduce "an error renders as an empty index" with the rest of the
// suite still green. This file is that test, made permanent.
//
// Named `page.test.ts`, NOT `page.test.tsx`: vitest.config.ts's `include` is
// `app/**/*.test.ts` (glob-exact, does not match `.test.tsx`) — a probe
// confirmed a `.test.tsx` file here is silently never collected ("No test
// files found"). No JSX syntax is needed in this file itself (the page's
// returned element tree is walked as plain objects), so `.test.ts` is both
// correct and sufficient.
vi.mock("@/lib/api/kora-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/kora-admin")>(
    "@/lib/api/kora-admin",
  );
  return {
    ...actual,
    listKoraFoods: vi.fn(),
  };
});

import { KoraAdminError, listKoraFoods, type KoraFoodPage } from "@/lib/api/kora-admin";
import KoraFoodsPage from "./page";

const mockListKoraFoods = vi.mocked(listKoraFoods);

// mock.mockReset() as an arrow shorthand body (`() => mock.mockReset()`)
// returns the mock, and vitest treats a returned value from a `beforeEach`
// callback as a teardown function — silently breaking reset between tests.
// Block body avoids that.
beforeEach(() => {
  mockListKoraFoods.mockReset();
});

type PageElement = { type?: unknown; props?: Record<string, unknown> };

function isElement(node: unknown): node is PageElement {
  return typeof node === "object" && node !== null && "props" in node;
}

/** Depth-first search for the first descendant element with `props.role === role`. */
function findByRole(node: unknown, role: string): PageElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByRole(child, role);
      if (found) return found;
    }
    return undefined;
  }
  if (!isElement(node)) return undefined;
  if (node.props?.role === role) return node;
  return findByRole(node.props?.children, role);
}

/** Flattens all string/number leaves under a node into one string. */
function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (isElement(node)) return collectText(node.props?.children);
  return "";
}

/** Collects every `props.href` string found anywhere in the element tree. */
function collectHrefs(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(collectHrefs);
  if (!isElement(node)) return [];
  const own = typeof node.props?.href === "string" ? [node.props.href as string] : [];
  return [...own, ...collectHrefs(node.props?.children)];
}

function makePage(overrides: Partial<KoraFoodPage> = {}): KoraFoodPage {
  return { items: [], total: 0, ...overrides };
}

function renderPage(searchParams: Record<string, string> = {}) {
  return KoraFoodsPage({ searchParams: Promise.resolve(searchParams) });
}

describe("KoraFoodsPage error state", () => {
  it("renders the error alert, carrying status/code/message, and NOT the empty state, when listKoraFoods throws", async () => {
    mockListKoraFoods.mockRejectedValueOnce(
      new KoraAdminError(403, "forbidden", "not an admin identity"),
    );

    const element = await renderPage();

    const alert = findByRole(element, "alert");
    expect(alert).toBeDefined();
    const alertText = collectText(alert);
    // Telling a 401 from a 403 is the entire reason this data is plumbed
    // through — status, code, and message must all be visible.
    expect(alertText).toContain("403");
    expect(alertText).toContain("forbidden");
    expect(alertText).toContain("not an admin identity");

    const pageText = collectText(element);
    expect(pageText).not.toContain("No foods found.");
  });

  it("renders the empty state and NOT the error alert for a genuinely empty result", async () => {
    // Counter-check: without this half, the first test alone would also
    // pass against a page that shows the error alert unconditionally.
    mockListKoraFoods.mockResolvedValueOnce(makePage({ items: [], total: 0 }));

    const element = await renderPage();

    expect(findByRole(element, "alert")).toBeUndefined();
    expect(collectText(element)).toContain("No foods found.");
  });
});

describe("KoraFoodsPage out-of-range offset", () => {
  const PAGE_SIZE = 50;
  const TOTAL = 7898;
  // Matches page.tsx's own clamp: floor((total - 1) / PAGE_SIZE) * PAGE_SIZE.
  const LAST_VALID_OFFSET = Math.floor((TOTAL - 1) / PAGE_SIZE) * PAGE_SIZE;

  it("does not render an inverted range or the empty-index state for ?offset=100000", async () => {
    mockListKoraFoods.mockResolvedValueOnce(makePage({ items: [], total: TOTAL }));

    const element = await renderPage({ offset: "100000" });

    const pageText = collectText(element);
    // The inverted range this bug used to produce.
    expect(pageText).not.toContain("100,001");
    // Never present the empty-index state over a non-empty index.
    expect(pageText).not.toContain("No foods found.");
    // Total is still surfaced honestly.
    expect(pageText).toContain(TOTAL.toLocaleString("en-US"));
    // Both the "go to the last page" link and the Previous pager link point
    // back at a real, in-range page rather than at `offset - PAGE_SIZE`
    // (99,950), which would still be out of range.
    const hrefs = collectHrefs(element);
    expect(hrefs.some((href) => href.includes(`offset=${LAST_VALID_OFFSET}`))).toBe(true);
    expect(hrefs.some((href) => href.includes("offset=99950"))).toBe(false);
  });

  it("renders the ordinary range for an in-range offset", async () => {
    mockListKoraFoods.mockResolvedValueOnce(
      makePage({
        items: Array.from({ length: PAGE_SIZE }, (_, i) => ({
          id: String(i),
          name: `Food ${i}`,
          brand: "",
          provenance: "usda",
          serving_desc: "1 unit",
          serving_grams: 100,
          kcal_per_100g: 1,
          protein_per_100g: 1,
          carbs_per_100g: 1,
          fat_per_100g: 1,
          fiber_per_100g: 1,
          created_at: "2026-01-01T00:00:00Z",
        })),
        total: TOTAL,
      }),
    );

    const element = await renderPage({ offset: "50" });

    const pageText = collectText(element);
    expect(pageText).toContain("51");
    expect(pageText).toContain("100");
    expect(pageText).not.toContain("doesn't exist");
  });
});

describe("KoraFoodsPage searchParams normalization", () => {
  it("takes the first value when a param is repeated (?q=a&q=b)", async () => {
    mockListKoraFoods.mockResolvedValueOnce(makePage({ items: [], total: 0 }));

    await renderPage({ q: ["a", "b"] as unknown as string });

    expect(mockListKoraFoods).toHaveBeenCalledWith(
      expect.objectContaining({ q: "a" }),
    );
  });
});
