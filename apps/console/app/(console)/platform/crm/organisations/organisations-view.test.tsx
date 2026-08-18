import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { FilterDescriptor } from "@/components/kit/filter-bar";
import { OrganisationsView } from "./organisations-view";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/platform/crm/organisations",
  // A cursor already on the URL, as if the operator paged deep into the list
  // before touching a filter: changing a filter must drop the stale cursor,
  // or the new query resumes from a position that belonged to the old one.
  useSearchParams: () => new URLSearchParams("cursor=abc123&q=priya"),
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
});

function renderView() {
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
 * Builds one ready row carrying `products`; every other field is the least
 * interesting value that still renders, so the Products cell is the only
 * thing under test.
 */
function renderRowWithProducts(products: readonly string[]) {
  render(
    <OrganisationsView
      rows={[
        {
          id: "org-1",
          name: "Acme",
          location: null,
          contactName: null,
          contactEmail: null,
          contactHandle: null,
          contactCount: 1,
          websiteUrl: null,
          openOpportunities: 0,
          products,
          createdAt: "2026-01-01T00:00:00.000Z",
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
    />,
  );
  // The body row (index 0 is the header row); Products is the last column.
  const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
  return cells[cells.length - 1];
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
