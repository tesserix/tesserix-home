import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// `useUrlFilters` reads the router, which jsdom has no app-router context for.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/mark8ly/tenants",
  useSearchParams: () => new URLSearchParams(),
}));

import type { EntityPage } from "@/lib/entities";
import { EntityIndex } from "./entity-index";

const pager = { precedingCount: 0, nextHref: "/mark8ly/tenants?page=2", previousHref: null };

const page = (over: Partial<EntityPage> = {}): EntityPage => ({
  data: [
    {
      id: "mark8ly:t1",
      source: "mark8ly",
      type: "tenants",
      label: "Acme Retail",
      createdAt: "2026-08-01T09:00:00Z",
    },
  ],
  pagination: { page: 1, limit: 50, total: 18 },
  ...over,
});

function renderIndex(over: Partial<Parameters<typeof EntityIndex>[0]> = {}) {
  render(
    <EntityIndex
      descriptors={[{ key: "q", label: "Search records", type: "search" }]}
      values={{}}
      tableLabel="Mark8ly tenants"
      recordHeading="Tenants"
      page={page()}
      pager={pager}
      state={{ kind: "ready" }}
      emptyMessage="Mark8ly has no tenants yet."
      scopeNote="Search to narrow the list, or page through it."
      reauthReturnTo="/mark8ly/tenants"
      {...over}
    />,
  );
}

describe("EntityIndex", () => {
  it("names the table for the product and type it is showing", () => {
    // The accessible name is the only thing on the table that says WHICH
    // product's records these are — the columns are normalized and identical
    // for every product and type.
    renderIndex();
    expect(screen.getByRole("table", { name: "Mark8ly tenants" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Tenants" })).toBeInTheDocument();
  });

  it("renders a sublabel when the product sent one", () => {
    renderIndex({
      page: page({
        data: [
          {
            id: "mark8ly:u1",
            source: "mark8ly",
            type: "users",
            label: "Mahesh",
            sublabel: "@mahesh",
          },
        ],
      }),
    });
    expect(screen.getByText("@mahesh")).toBeInTheDocument();
  });

  it("renders no placeholder where the product sent no sublabel", () => {
    // §3.4 never defines the field and mark8ly emits none, so a placeholder
    // would make "this product sends no sublabel" look like "this record has
    // none". The row is the label alone.
    renderIndex();
    const cell = screen.getByText("Acme Retail").closest("td");
    expect(cell?.textContent).toBe("Acme Retail");
  });

  it("renders an em dash for a record with no creation instant", () => {
    // Optional per `EntityRecord`: not every entity type has a creation
    // instant that means anything.
    renderIndex({
      page: page({
        data: [{ id: "mark8ly:t2", source: "mark8ly", type: "tenants", label: "Brindle Books" }],
      }),
    });
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows the empty message and no table when the state is not ready", () => {
    renderIndex({ state: { kind: "empty" }, page: page({ data: [] }) });
    expect(screen.getByText("Mark8ly has no tenants yet.")).toBeInTheDocument();
    // And no table: an empty grid beside the message reads as a failed load
    // rather than as an answer.
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps the filter bar visible when the state is not ready", () => {
    // The search is how an operator gets OUT of an empty-filtered result, so
    // it must survive the state that most needs it.
    renderIndex({ state: { kind: "filtered-empty" }, page: page({ data: [] }) });
    expect(screen.getByLabelText("Search records")).toBeInTheDocument();
  });
});
