import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { OrganisationListRow } from "@/lib/db/crm-repo";
import { UNKNOWN_COUNTRY, UNKNOWN_FOLLOWERS } from "@/lib/db/crm-filters";
import { COUNTRY_LABELS } from "@/lib/db/crm-country";

const listOrganisations = vi.fn();

vi.mock("@/lib/db/crm-repo", () => ({
  listOrganisations: (...args: unknown[]) => listOrganisations(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/platform/crm/organisations",
  useSearchParams: () => new URLSearchParams(),
}));

import Page, { ORGANISATION_FILTERS } from "./page";

beforeEach(() => {
  listOrganisations.mockReset();
});

const ORG_ROW: OrganisationListRow = {
  id: "org-1",
  name: "Glebe Flowers",
  location: "Sydney",
  contactName: "Priya Raman",
  contactEmail: "priya@glebeflowers.example",
  contactHandle: "glebeflowers",
  contactCount: 1,
  // A website means this is a registered business, not a solo creator —
  // ORG_ROW renders name-first, which is what most of this file's tests
  // (all written before Task 7) assume when they check for `row.name`.
  websiteUrl: "https://glebeflowers.example",
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

/** `listOrganisations` returns `{ rows, total, precedingCount, nextCursor,
 *  previousCursor }`. Defaults `total` to `rows.length`, `precedingCount` to
 *  0 and both cursors to `null` — the first-page case for these tests, which
 *  are about the page's own read of the rows/total it's handed. */
function orgPage(
  rows: OrganisationListRow[],
  overrides: {
    total?: number;
    precedingCount?: number;
    nextCursor?: string | null;
    previousCursor?: string | null;
  } = {},
) {
  return {
    rows,
    total: overrides.total ?? rows.length,
    precedingCount: overrides.precedingCount ?? 0,
    nextCursor: overrides.nextCursor ?? null,
    previousCursor: overrides.previousCursor ?? null,
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

    it("shows which rows of the total are on screen, as a range", async () => {
      listOrganisations.mockResolvedValue(orgPage(orgRows(100), { total: 259, nextCursor: "abc" }));
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.getByText(/1–100 of 259/i)).toBeInTheDocument();
    });

    it("reports the range for a later page, not the page size again", async () => {
      // The bug this pins: a bare `rows.length` made page 1 and page 2 both
      // read "100 of 259", so an operator could not tell which page they
      // were on.
      listOrganisations.mockResolvedValue(
        orgPage(orgRows(100), { total: 259, precedingCount: 100, nextCursor: "def" }),
      );
      render(await Page({ searchParams: Promise.resolve({ cursor: "abc" }) }));
      expect(screen.getByText(/101–200 of 259/i)).toBeInTheDocument();
    });

    it("reports the range for a short final page", async () => {
      listOrganisations.mockResolvedValue(orgPage(orgRows(59), { total: 259, precedingCount: 200 }));
      render(await Page({ searchParams: Promise.resolve({ cursor: "def" }) }));
      expect(screen.getByText(/201–259 of 259/i)).toBeInTheDocument();
    });

    it("offers a next control only when there is a next page", async () => {
      listOrganisations.mockResolvedValue(orgPage(orgRows(100), { total: 259, nextCursor: "abc" }));
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.getByRole("link", { name: /next/i })).toBeInTheDocument();
    });

    it("offers no next control on the last page", async () => {
      listOrganisations.mockResolvedValue(orgPage(orgRows(9)));
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.queryByRole("link", { name: /next/i })).toBeNull();
    });

    it("passes the cursor through to the repo", async () => {
      listOrganisations.mockResolvedValue(orgPage([]));
      render(await Page({ searchParams: Promise.resolve({ cursor: "abc" }) }));
      expect(listOrganisations).toHaveBeenCalledWith(expect.anything(), expect.any(Number), "abc");
    });

    it("offers a previous control only when there is a page behind this one", async () => {
      listOrganisations.mockResolvedValue(
        orgPage(orgRows(100), { total: 259, precedingCount: 100, nextCursor: "n", previousCursor: "p" }),
      );
      render(await Page({ searchParams: Promise.resolve({ cursor: "abc" }) }));
      const previous = screen.getByRole("link", { name: /previous page of organisations/i });
      expect(new URLSearchParams((previous.getAttribute("href") ?? "").split("?")[1]).get("cursor")).toBe("p");
    });

    it("offers no previous control on page one", async () => {
      listOrganisations.mockResolvedValue(orgPage(orgRows(100), { total: 259, nextCursor: "abc" }));
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.queryByRole("link", { name: /previous/i })).toBeNull();
    });

    it("carries every other param onto the previous link too", async () => {
      // Same defect as the next link: a builder that named the params it
      // knew about would drop an operator's filters the moment they paged
      // BACK, which is the direction nothing exercised until now.
      listOrganisations.mockResolvedValue(
        orgPage(orgRows(100), { total: 259, precedingCount: 100, previousCursor: "p" }),
      );
      render(
        await Page({
          searchParams: Promise.resolve({ q: "priya", someFutureFilter: "x", cursor: "abc" }),
        }),
      );
      const previous = screen.getByRole("link", { name: /previous/i });
      const params = new URLSearchParams((previous.getAttribute("href") ?? "").split("?")[1]);
      expect(params.get("q")).toBe("priya");
      expect(params.get("someFutureFilter")).toBe("x");
      // The stale cursor is replaced, never appended alongside the new one.
      expect(params.getAll("cursor")).toEqual(["p"]);
    });

    // Not in the brief — a ruling. A later task adds four more filter params
    // (`product`, `country`, `followers`, `email`); a next-link builder that
    // named only `q` and `import` would silently drop an operator's other
    // filters the moment they page, landing them on an unfiltered page 2
    // with no reason to suspect the link rather than the data.
    it("preserves an unrelated search param when building the next link", async () => {
      listOrganisations.mockResolvedValue(orgPage(orgRows(100), { total: 259, nextCursor: "abc" }));
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

    it("passes the unknown country and follower sentinels through to the repo", async () => {
      // Each sentinel fails the recognised-value check its filter applies to
      // real values (COUNTRY_LABELS / FOLLOWER_BANDS), so both have to be
      // admitted explicitly — otherwise picking "Unknown" reads as no filter
      // at all and the surface silently ignores the option it just offered.
      listOrganisations.mockResolvedValue(orgPage([]));
      render(
        await Page({
          searchParams: Promise.resolve({
            country: UNKNOWN_COUNTRY,
            followers: UNKNOWN_FOLLOWERS,
          }),
        }),
      );
      expect(listOrganisations).toHaveBeenCalledWith(
        { country: UNKNOWN_COUNTRY, followers: UNKNOWN_FOLLOWERS },
        expect.any(Number),
        undefined,
      );
    });

    it("offers Unknown on both the country and follower filters", async () => {
      // 208 of 259 organisations have no derived country and 51 no follower
      // count; without these options the filters hide them with nothing said.
      //
      // Asserted per descriptor rather than by opening both `Select`s and
      // counting "Unknown" in the DOM: Radix portals each open select's
      // content, and a rendered-text assertion passed even with the follower
      // option deleted, because the country select's own "Unknown" was still
      // mounted. The exact-value assertion below cannot confuse the two.
      const options = (key: string) =>
        ORGANISATION_FILTERS.find((d) => d.key === key)?.options?.map((o) => o.value);
      expect(options("country")).toEqual([...Object.keys(COUNTRY_LABELS), UNKNOWN_COUNTRY]);
      expect(options("followers")).toEqual([
        "under1k",
        "k1to10k",
        "over10k",
        UNKNOWN_FOLLOWERS,
      ]);
      // A data state, never a value: "0" or "None" would read as a measured
      // follower count of zero.
      for (const key of ["country", "followers"]) {
        const descriptor = ORGANISATION_FILTERS.find((d) => d.key === key);
        expect(descriptor?.options?.at(-1)?.label).toBe("Unknown");
      }

      // And it reaches the operator: the option lives inside a Radix
      // `Select`, which portals its content only once opened.
      listOrganisations.mockResolvedValue(orgPage([]));
      render(await Page({ searchParams: Promise.resolve({}) }));
      fireEvent.click(screen.getByLabelText("Followers"));
      expect(screen.getByText("Unknown")).toBeInTheDocument();
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

    it("drops an Object.prototype member name as a country rather than passing it to SQL", async () => {
      // `rawCountry in COUNTRY_LABELS` walked the prototype chain, so
      // `?country=__proto__` (or `constructor`, `toString`) read as a
      // recognised code and reached the repo's exact-match clause.
      for (const key of ["__proto__", "constructor", "toString"]) {
        listOrganisations.mockClear();
        listOrganisations.mockResolvedValue(orgPage([]));
        render(await Page({ searchParams: Promise.resolve({ country: key }) }));
        expect(listOrganisations).toHaveBeenCalledWith({}, expect.any(Number), undefined);
      }
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

  describe("handle-first identity for solo creators", () => {
    const soloCreatorRow: OrganisationListRow = {
      ...ORG_ROW,
      id: "org-solo",
      name: "Glebe Flowers",
      contactHandle: "glebeflowers",
      contactCount: 1,
      websiteUrl: null,
    };

    const realBusinessRow: OrganisationListRow = {
      ...ORG_ROW,
      id: "org-business",
      name: "Newtown Roasters",
      contactHandle: "newtownroasters",
      contactCount: 1,
      websiteUrl: "https://newtownroasters.example",
    };

    it("leads with the handle for a single-contact organisation with no website", async () => {
      // 201 of 259 production rows are exactly this shape: a solo creator whose
      // organisation name is derived from their profile.
      listOrganisations.mockResolvedValue(orgPage([soloCreatorRow]));
      render(await Page({ searchParams: Promise.resolve({}) }));
      const link = screen.getByRole("link", { name: /@glebeflowers/ });
      expect(link).toBeInTheDocument();
    });

    it("leads with the organisation name when it is a real business", async () => {
      // A row with a website or several contacts is a business, and its name is
      // the thing an operator recognises. 58 of 259 have a website.
      listOrganisations.mockResolvedValue(orgPage([realBusinessRow]));
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.getByRole("link", { name: /Newtown Roasters/ })).toBeInTheDocument();
    });

    it("still shows the organisation name as secondary when leading with a handle", async () => {
      // Never hide it — the operator may have typed that name into search.
      listOrganisations.mockResolvedValue(orgPage([soloCreatorRow]));
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.getByText("Glebe Flowers")).toBeInTheDocument();
    });

    it("leads with the organisation name when the org has more than one contact, even with no website and a handle present", async () => {
      // The case `contactCount === 1` exists to guard: several named contacts
      // means a real business regardless of website. Untested until now, this
      // clause could be removed or flipped to `!== 1` without any test here
      // catching it.
      const multiContactRow: OrganisationListRow = {
        ...ORG_ROW,
        id: "org-multi",
        name: "Newtown Roasters",
        contactHandle: "newtownroasters",
        contactCount: 2,
        websiteUrl: null,
      };
      listOrganisations.mockResolvedValue(orgPage([multiContactRow]));
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.getByRole("link", { name: /Newtown Roasters/ })).toBeInTheDocument();
      expect(screen.queryByText("@newtownroasters")).toBeNull();
    });
  });
});
