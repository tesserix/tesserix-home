import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { OrganisationListRow } from "@/lib/db/crm-repo";

const listOrganisations = vi.fn();

vi.mock("@/lib/db/crm-repo", () => ({
  listOrganisations: (...args: unknown[]) => listOrganisations(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/platform/crm/organisations",
  useSearchParams: () => new URLSearchParams(),
}));

import Page from "./page";

beforeEach(() => {
  listOrganisations.mockReset();
});

const ORG_ROW: OrganisationListRow = {
  id: "org-1",
  name: "Glebe Flowers",
  location: "Sydney",
  contactName: "Priya Raman",
  contactEmail: "priya@glebeflowers.example",
  openOpportunities: 1,
  products: [],
  createdAt: "2026-08-01T00:00:00.000Z",
};

function orgRows(count: number): OrganisationListRow[] {
  return Array.from({ length: count }, (_, index) => ({
    ...ORG_ROW,
    id: `org-${index}`,
    name: `Organisation ${index}`,
  }));
}

/** `listOrganisations` now returns `{ rows, total, nextCursor }` (Task 1).
 *  Defaults `total` to `rows.length` and `nextCursor` to `null` — the
 *  common case for these tests, which are about the page's own read of the
 *  rows/total it's handed, not about the cursor a later task's pager uses. */
function orgPage(
  rows: OrganisationListRow[],
  overrides: { total?: number; nextCursor?: string | null } = {},
) {
  return {
    rows,
    total: overrides.total ?? rows.length,
    nextCursor: overrides.nextCursor ?? null,
  };
}

describe("OrganisationsPage", () => {
  it("renders the rows it is given", async () => {
    listOrganisations.mockResolvedValue(orgPage([ORG_ROW]));
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("Glebe Flowers")).toBeInTheDocument();
  });

  it("passes the search term through to the repo rather than filtering in the page", async () => {
    // Filtering a returned page in TypeScript answers "matches among the
    // first N" rather than "the first N matches" — Ruling 11, the same
    // reason the queue filters in SQL.
    listOrganisations.mockResolvedValue(orgPage([]));
    render(await Page({ searchParams: Promise.resolve({ q: "priya" }) }));
    expect(listOrganisations).toHaveBeenCalledWith({ search: "priya" }, expect.any(Number), undefined);
  });

  it("shows the filtered-empty state when a search matches nothing", async () => {
    listOrganisations.mockResolvedValue(orgPage([]));
    render(await Page({ searchParams: Promise.resolve({ q: "nobody" }) }));
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("shows the plain empty state when there is no search and no data", async () => {
    listOrganisations.mockResolvedValue(orgPage([]));
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("shows the instrumentation-unavailable state when the tables are missing", async () => {
    // 42P01 — the CRM migrations have not been run. This must not read as
    // "no organisations exist".
    const undefinedTable = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    listOrganisations.mockRejectedValue(undefinedTable);
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("Not set up yet")).toBeInTheDocument();
  });

  // This isn't in the brief — it's a ruling. A later task links an import's
  // result page to `/platform/crm/organisations?import=<uuid>`; without
  // mapping `?import=` to `OrganisationFilter.importId` that link lands on
  // the unfiltered list showing every organisation, which is exactly the
  // "reports 47 created, shows you nothing" dead end #213 exists to close.
  it("maps ?import= to OrganisationFilter.importId", async () => {
    listOrganisations.mockResolvedValue(orgPage([]));
    render(
      await Page({
        searchParams: Promise.resolve({ import: "8f14e45f-ceea-467e-b7ea-05a3778a1234" }),
      }),
    );
    expect(listOrganisations).toHaveBeenCalledWith(
      { importId: "8f14e45f-ceea-467e-b7ea-05a3778a1234" },
      expect.any(Number),
      undefined,
    );
  });

  // Finding 1: real pagination lands in Task 2. The truncation notice this
  // replaced said only "there are more" — an operator sizing up a 259-lead
  // backlog needs the number, and a way to actually reach page 2.
  describe("pagination", () => {
    it("asks the repo for exactly PAGE_SIZE rows per page", async () => {
      listOrganisations.mockResolvedValue(orgPage([]));
      render(await Page({ searchParams: Promise.resolve({}) }));
      const [, limit] = listOrganisations.mock.calls[0];
      expect(limit).toBe(100);
    });

    it("shows how many of the total are on screen", async () => {
      listOrganisations.mockResolvedValue({ rows: orgRows(100), total: 259, nextCursor: "abc" });
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.getByText(/100 of 259/i)).toBeInTheDocument();
    });

    it("offers a next control only when there is a next page", async () => {
      listOrganisations.mockResolvedValue({ rows: orgRows(100), total: 259, nextCursor: "abc" });
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.getByRole("link", { name: /next/i })).toBeInTheDocument();
    });

    it("offers no next control on the last page", async () => {
      listOrganisations.mockResolvedValue({ rows: orgRows(9), total: 9, nextCursor: null });
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.queryByRole("link", { name: /next/i })).toBeNull();
    });

    it("passes the cursor through to the repo", async () => {
      listOrganisations.mockResolvedValue(orgPage([]));
      render(await Page({ searchParams: Promise.resolve({ cursor: "abc" }) }));
      expect(listOrganisations).toHaveBeenCalledWith(expect.anything(), expect.any(Number), "abc");
    });

    // Not in the brief — a ruling. A later task adds four more filter params
    // (`product`, `country`, `followers`, `email`); a next-link builder that
    // named only `q` and `import` would silently drop an operator's other
    // filters the moment they page, landing them on an unfiltered page 2
    // with no reason to suspect the link rather than the data.
    it("preserves an unrelated search param when building the next link", async () => {
      listOrganisations.mockResolvedValue({ rows: orgRows(100), total: 259, nextCursor: "abc" });
      render(
        await Page({ searchParams: Promise.resolve({ q: "priya", someFutureFilter: "x" }) }),
      );
      const next = screen.getByRole("link", { name: /next/i });
      const href = next.getAttribute("href") ?? "";
      const params = new URLSearchParams(href.split("?")[1]);
      expect(params.get("q")).toBe("priya");
      expect(params.get("someFutureFilter")).toBe("x");
      expect(params.get("cursor")).toBe("abc");
    });
  });

  it("shows the filtered-empty state, not the plain empty state, when an import filter matches nothing", async () => {
    listOrganisations.mockResolvedValue(orgPage([]));
    render(
      await Page({
        searchParams: Promise.resolve({ import: "8f14e45f-ceea-467e-b7ea-05a3778a1234" }),
      }),
    );
    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.queryByText("Nothing here yet")).toBeNull();
  });

  describe("filter bar", () => {
    it("passes every recognised filter through to the repo", async () => {
      listOrganisations.mockResolvedValue(orgPage([]));
      render(
        await Page({
          searchParams: Promise.resolve({
            q: "priya",
            product: "mark8ly",
            country: "IN",
            followers: "over10k",
            email: "1",
          }),
        }),
      );
      expect(listOrganisations).toHaveBeenCalledWith(
        { search: "priya", product: "mark8ly", country: "IN", followers: "over10k", hasEmail: true },
        expect.any(Number),
        undefined,
      );
    });

    it("drops an unrecognised follower band rather than passing it to SQL", async () => {
      // Same contract the queue's readQueueFilters follows: an unrecognised
      // value means no filter, never a value the repo has to defend against.
      listOrganisations.mockResolvedValue(orgPage([]));
      render(await Page({ searchParams: Promise.resolve({ followers: "banana" }) }));
      expect(listOrganisations).toHaveBeenCalledWith({}, expect.any(Number), undefined);
    });

    it("resolves filtered-empty, not empty, when a filter matches nothing", async () => {
      listOrganisations.mockResolvedValue(orgPage([]));
      render(await Page({ searchParams: Promise.resolve({ product: "mark8ly" }) }));
      expect(screen.getByText("No matches")).toBeInTheDocument();
      expect(screen.queryByText("Nothing here yet")).toBeNull();
    });

    it("offers Unassigned as a product option", async () => {
      // Every migrated lead is unassigned; without this option the product
      // filter hides the entire current dataset. The option lives inside a
      // Radix `Select`, which portals its content only once opened.
      listOrganisations.mockResolvedValue(orgPage([]));
      render(await Page({ searchParams: Promise.resolve({}) }));
      fireEvent.click(screen.getByLabelText("Product"));
      expect(screen.getByText(/unassigned/i)).toBeInTheDocument();
    });

    it("drops an unrecognised product rather than passing it to SQL", async () => {
      // Same contract as the followers rejection above: a product the
      // estate doesn't declare (and that isn't UNASSIGNED_PRODUCT) is not a
      // value the repo should ever have to defend against.
      listOrganisations.mockResolvedValue(orgPage([]));
      render(await Page({ searchParams: Promise.resolve({ product: "not-a-real-product" }) }));
      expect(listOrganisations).toHaveBeenCalledWith({}, expect.any(Number), undefined);
    });

    it("drops an unrecognised country rather than passing it to SQL", async () => {
      // Country is a closed set (COUNTRY_LABELS); a code outside it must
      // read as unfiltered, not reach the repo's exact-match clause.
      listOrganisations.mockResolvedValue(orgPage([]));
      render(await Page({ searchParams: Promise.resolve({ country: "ZZ" }) }));
      expect(listOrganisations).toHaveBeenCalledWith({}, expect.any(Number), undefined);
    });

    it("only recognises email=1, dropping any other value rather than enabling the filter", async () => {
      // `hasEmail` is a boolean gate: anything other than the exact string
      // "1" (a stray "true", an accidental "0") must not silently turn the
      // filter on.
      listOrganisations.mockResolvedValue(orgPage([]));
      render(await Page({ searchParams: Promise.resolve({ email: "true" }) }));
      expect(listOrganisations).toHaveBeenCalledWith({}, expect.any(Number), undefined);

      listOrganisations.mockClear();
      render(await Page({ searchParams: Promise.resolve({ email: "0" }) }));
      expect(listOrganisations).toHaveBeenCalledWith({}, expect.any(Number), undefined);
    });
  });
});
