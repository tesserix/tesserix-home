import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { FilterDescriptor } from "@/components/kit/filter-bar";
import type { OrganisationListRow, OrganisationSort } from "@/lib/db/crm-repo";
import { OrganisationsView } from "./organisations-view";

const replace = vi.fn();

// A cursor already on the URL, as if the operator paged deep into the list
// before touching a filter: changing a filter must drop the stale cursor, or
// the new query resumes from a position that belonged to the old one. Mutable
// so a test can put a different query on the URL — the sort links are built
// from it, so what it holds is under test rather than mere scenery.
const DEFAULT_QUERY = "cursor=abc123&q=priya";
const url = vi.hoisted(() => ({ query: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/platform/crm/organisations",
  useSearchParams: () => new URLSearchParams(url.query),
}));

const DESCRIPTORS: FilterDescriptor[] = [
  { key: "q", label: "Search organisations", type: "search" },
  {
    key: "product",
    label: "Product",
    type: "select",
    options: [{ value: "mark8ly", label: "Mark8ly" }],
  },
];

beforeEach(() => {
  replace.mockReset();
  url.query = DEFAULT_QUERY;
});

function renderView(sort: OrganisationSort | null = null) {
  render(
    <OrganisationsView
      rows={[]}
      state={{ kind: "ready" }}
      emptyMessage="No organisations yet."
      descriptors={DESCRIPTORS}
      values={{ q: "priya" }}
      total={0}
      precedingCount={0}
      nextHref={null}
      previousHref={null}
      sort={sort}
    />,
  );
}

describe("OrganisationsView filter changes", () => {
  it("drops ?cursor= from the URL when a filter is changed, without losing the new filter value", () => {
    renderView();

    fireEvent.click(screen.getByLabelText("Product"));
    fireEvent.click(screen.getByRole("option", { name: "Mark8ly" }));

    expect(replace).toHaveBeenCalledOnce();
    const [nextUrl] = replace.mock.calls[0] as [string];
    const [, query] = nextUrl.split("?");
    const params = new URLSearchParams(query);

    // The new filter made it into the URL...
    expect(params.get("product")).toBe("mark8ly");
    // ...and the stale cursor did not survive the change: paging to page 3
    // and then narrowing a filter must not land on an empty page 3 of a
    // now-shorter result set.
    expect(params.has("cursor")).toBe(false);
  });

  it("drops ?cursor= from the URL when filters are cleared", () => {
    renderView();

    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));

    expect(replace).toHaveBeenCalledOnce();
    const [nextUrl] = replace.mock.calls[0] as [string];
    if (nextUrl.includes("?")) {
      const [, query] = nextUrl.split("?");
      expect(new URLSearchParams(query).has("cursor")).toBe(false);
    }
    // Either the whole query is gone, or whatever remains has no cursor —
    // both read as "cleared", never as "still on the stale page".
    expect(nextUrl).not.toContain("cursor");
  });
});

/**
 * Renders one ready row, then hands back its cells. Every field the caller
 * does not override is the least interesting value that still renders, so
 * whichever cell the caller reads is the only thing under test.
 */
function renderRow(overrides: Partial<OrganisationListRow>) {
  render(
    <OrganisationsView
      rows={[
        {
          id: "org-1",
          name: "Acme",
          location: null,
          country: null,
          contactName: null,
          contactEmail: null,
          contactHandle: null,
          contactCount: 1,
          websiteUrl: null,
          openOpportunities: 0,
          followersCount: null,
          products: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          ...overrides,
        },
      ]}
      state={{ kind: "ready" }}
      emptyMessage="No organisations yet."
      descriptors={DESCRIPTORS}
      values={{}}
      total={1}
      precedingCount={0}
      nextHref={null}
      previousHref={null}
      sort={null}
    />,
  );
  // The body row; index 0 is the header row.
  return within(screen.getAllByRole("row")[1]).getAllByRole("cell");
}

function renderRowWithProducts(products: readonly string[]) {
  const cells = renderRow({ products });
  // Products sits between Followers and Added.
  return cells[cells.length - 2];
}

function renderRowWithFollowers(followersCount: number | null) {
  const cells = renderRow({ followersCount });
  // Followers sits between Open and Products, so it is the third-to-last.
  return cells[cells.length - 3];
}

function renderRowWithLocation(location: string | null, country: string | null) {
  const cells = renderRow({ location, country });
  // Location is the second column, after Name.
  return cells[1];
}

describe("OrganisationsView products cell", () => {
  it("renders an em-dash for an organisation with no products", () => {
    const cell = renderRowWithProducts([]);

    expect(cell.textContent).toBe("—");
    expect(cell.querySelector("[title]")).toBeNull();
  });

  it("renders a single product with no overflow marker", () => {
    const cell = renderRowWithProducts(["mark8ly"]);

    expect(cell.textContent).toBe("mark8ly");
    expect(cell.textContent).not.toContain("more");
  });

  it("renders every product with no overflow marker when the count is exactly at the cut-off", () => {
    const cell = renderRowWithProducts(["mark8ly", "homechef", "dwellm8"]);

    // The off-by-one that matters: three products must not read "+0 more".
    expect(cell.textContent).toBe("mark8ly, homechef, dwellm8");
    expect(cell.textContent).not.toContain("more");
    expect(cell.querySelector("[title]")).toBeNull();
  });

  it("summarises the overflow and keeps every product reachable when well over the cut-off", () => {
    const all = ["mark8ly", "homechef", "dwellm8", "kora", "devai", "hms"];
    const cell = renderRowWithProducts(all);

    // Visible: the first three, then how many were not shown.
    expect(cell.textContent).toContain("mark8ly, homechef, dwellm8");
    expect(cell.textContent).toContain("+3 more");

    // Reachable on hover...
    expect(cell.querySelector("[title]")?.getAttribute("title")).toBe(all.join(", "));
    // ...and, since `title` alone is neither keyboard- nor reliably
    // screen-reader-accessible, in the cell's accessible text too.
    for (const product of all) {
      expect(cell.textContent).toContain(product);
    }
  });
});

/**
 * The follower count is the CRM's only quantitative qualification signal, and
 * the column has to keep faith with the filter that reads the same number:
 * an absent count is `—`, never `0`, because the rows behind it have no
 * recorded value — see `UNKNOWN_LABEL` in `crm-filters.ts`, and the Unknown
 * band those rows fall into.
 */
describe("OrganisationsView followers cell", () => {
  it("renders an em-dash for an organisation with no follower count", () => {
    const cell = renderRowWithFollowers(null);

    // Not "0": a measured zero and an unmeasured contact are different
    // claims, and only one of them is true here.
    expect(cell.textContent).toBe("—");
    expect(cell.textContent).not.toContain("0");
    expect(cell.querySelector("[title]")).toBeNull();
  });

  it("renders a measured zero as a number, not as the empty state", () => {
    const cell = renderRowWithFollowers(0);

    expect(cell.textContent).toBe("0");
    expect(cell.textContent).not.toContain("—");
  });

  it("renders a small count in full", () => {
    const cell = renderRowWithFollowers(950);

    expect(cell.textContent).toBe("950");
  });

  it("abbreviates thousands to one decimal place", () => {
    const cell = renderRowWithFollowers(1240);

    expect(cell.textContent).toBe("1.2k");
  });

  it("drops the decimal once the count is five figures, and keeps the exact number reachable", () => {
    const cell = renderRowWithFollowers(15000);

    expect(cell.textContent).toBe("15k");
    expect(cell.querySelector("[title]")?.getAttribute("title")).toBe(
      `${(15000).toLocaleString()} followers`,
    );
  });

  it("abbreviates millions", () => {
    expect(renderRowWithFollowers(1_240_000).textContent).toBe("1.2M");
  });
});

/**
 * `country` is derived from `location` by `countryFromLocation` and stored,
 * so until it is rendered nobody can tell which rows the mapper resolved —
 * 208 of the 259 production rows have no derived country. The cell has to
 * keep the two absences behind that figure apart: no location recorded at
 * all, and a location the mapper has no entry for.
 */
describe("OrganisationsView location cell", () => {
  it("renders the derived country beneath the recorded location", () => {
    const cell = renderRowWithLocation("Chennai", "IN");

    // The label, not the stored code: `COUNTRY_LABELS` is the one mapper.
    expect(cell.textContent).toContain("Chennai");
    expect(cell.textContent).toContain("India");
  });

  it("says Unknown when a recorded location derived no country", () => {
    const cell = renderRowWithLocation("Ranchi", null);

    // The whole point of the column: this row is visibly one the mapper
    // failed on, and it says so in the same word the country filter's
    // sentinel option offers. Only the word is shared — that sentinel
    // matches `country IS NULL`, which also returns rows with no location
    // at all, and those render a bare em-dash rather than this.
    expect(cell.textContent).toContain("Ranchi");
    expect(cell.textContent).toContain("Unknown");
  });

  it("falls back to the stored code when the mapper has no label for it", () => {
    // `COUNTRY_LABELS` covers only the codes the table can produce today; a
    // code added to the table before its label must still render as itself
    // rather than vanish.
    const cell = renderRowWithLocation("Auckland", "NZ");

    expect(cell.textContent).toContain("NZ");
  });

  it("keeps a missing location distinct from a missing country", () => {
    const cell = renderRowWithLocation(null, null);

    // No location is nothing to derive from, so it is the plain em-dash the
    // other empty cells use — not "Unknown", which would claim a location
    // was recorded and merely failed to map.
    expect(cell.textContent).toBe("—");
    expect(cell.textContent).not.toContain("Unknown");
  });
});

/** The query of a sort link, so a test can read its params. */
function sortQuery(header: string): URLSearchParams {
  const link = within(screen.getByRole("columnheader", { name: header })).getByRole("link");
  const href = link.getAttribute("href") ?? "";
  const [path, query] = href.split("?");
  expect(path).toBe("/platform/crm/organisations");
  return new URLSearchParams(query);
}

/**
 * The columns this surface can order by, against the columns it cannot.
 *
 * The sortable three are the repo's whole allow-list (`OrganisationSortKey`).
 * The other three are subqueries or derived text with no ORDER BY behind them,
 * so a header that offered to sort them would promise something the server
 * refuses.
 */
const SORTABLE_HEADERS = ["Name", "Followers", "Added"];
const UNSORTABLE_HEADERS = ["Location", "Primary contact", "Open", "Products"];

describe("OrganisationsView sortable headers", () => {
  it("offers a sort control on exactly the three columns the repo can order by", () => {
    renderView();

    for (const header of SORTABLE_HEADERS) {
      const cell = screen.getByRole("columnheader", { name: header });
      expect(within(cell).getByRole("link")).toBeTruthy();
    }
    for (const header of UNSORTABLE_HEADERS) {
      const cell = screen.getByRole("columnheader", { name: header });
      expect(within(cell).queryByRole("link")).toBeNull();
      // No `aria-sort` at all, not "none": "none" would announce a column as
      // sortable when nothing here can sort it.
      expect(cell.getAttribute("aria-sort")).toBeNull();
    }
  });

  it("names only the column on a first click, leaving the direction to the surface's default", () => {
    renderView();

    const params = sortQuery("Followers");
    expect(params.get("sort")).toBe("followers");
    // `?dir=` without `?sort=` names no column and `?dir=` with a column the
    // operator has not yet sorted by would override the per-column default
    // (`SORT_DIRECTION_DEFAULTS`) with `nextSort`'s ascending — a follower
    // count is asked for biggest-first.
    expect(params.has("dir")).toBe(false);
  });

  it("carries the filters already on the URL and drops the position the old order named", () => {
    url.query = "cursor=abc123&q=priya&page=3";
    renderView();

    const params = sortQuery("Name");
    expect(params.get("sort")).toBe("name");
    expect(params.get("q")).toBe("priya");
    // Both positions belong to the previous ordering: a keyset cursor points
    // into `(created_at, id)` order and an offset counts rows in whatever
    // order produced it.
    expect(params.has("cursor")).toBe(false);
    expect(params.has("page")).toBe(false);
  });

  it("toggles the direction on the column already sorted", () => {
    renderView({ key: "followers", direction: "desc" });

    const params = sortQuery("Followers");
    expect(params.get("sort")).toBe("followers");
    expect(params.get("dir")).toBe("asc");
  });

  it("toggles back the other way", () => {
    renderView({ key: "name", direction: "asc" });

    expect(sortQuery("Name").get("dir")).toBe("desc");
  });

  it("still names only the column on a header that is not the sorted one", () => {
    renderView({ key: "name", direction: "desc" });

    const params = sortQuery("Followers");
    expect(params.get("sort")).toBe("followers");
    expect(params.has("dir")).toBe(false);
  });

  it("announces the direction on the sorted column and on no other", () => {
    renderView({ key: "followers", direction: "desc" });

    expect(screen.getByRole("columnheader", { name: "Followers" }).getAttribute("aria-sort")).toBe(
      "descending",
    );
    for (const header of ["Name", "Added"]) {
      expect(screen.getByRole("columnheader", { name: header }).getAttribute("aria-sort")).toBe(
        "none",
      );
    }
  });

  it("announces an ascending sort as ascending", () => {
    renderView({ key: "name", direction: "asc" });

    expect(screen.getByRole("columnheader", { name: "Name" }).getAttribute("aria-sort")).toBe(
      "ascending",
    );
  });

  it("marks every sortable column as sortable when nothing is sorted", () => {
    renderView();

    for (const header of SORTABLE_HEADERS) {
      // "none" rather than a missing attribute: it is what tells assistive
      // tech the column can be sorted at all.
      expect(screen.getByRole("columnheader", { name: header }).getAttribute("aria-sort")).toBe(
        "none",
      );
    }
  });
});
