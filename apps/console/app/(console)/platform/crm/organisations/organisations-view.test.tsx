import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { FilterDescriptor } from "@/components/kit/filter-bar";
import { OrganisationsView } from "./organisations-view";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/platform/crm/organisations",
  // A cursor already on the URL, as if the operator paged to page 3 before
  // touching a filter — the exact scenario Ruling-style requirement 3 in
  // Task 6's brief is about.
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
      nextHref={null}
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
