import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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

describe("OrganisationsPage", () => {
  it("renders the rows it is given", async () => {
    listOrganisations.mockResolvedValue([ORG_ROW]);
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("Glebe Flowers")).toBeInTheDocument();
  });

  it("passes the search term through to the repo rather than filtering in the page", async () => {
    // Filtering a returned page in TypeScript answers "matches among the
    // first N" rather than "the first N matches" — Ruling 11, the same
    // reason the queue filters in SQL.
    listOrganisations.mockResolvedValue([]);
    render(await Page({ searchParams: Promise.resolve({ q: "priya" }) }));
    expect(listOrganisations).toHaveBeenCalledWith({ search: "priya" }, expect.any(Number));
  });

  it("shows the filtered-empty state when a search matches nothing", async () => {
    listOrganisations.mockResolvedValue([]);
    render(await Page({ searchParams: Promise.resolve({ q: "nobody" }) }));
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("shows the plain empty state when there is no search and no data", async () => {
    listOrganisations.mockResolvedValue([]);
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
    listOrganisations.mockResolvedValue([]);
    render(
      await Page({
        searchParams: Promise.resolve({ import: "8f14e45f-ceea-467e-b7ea-05a3778a1234" }),
      }),
    );
    expect(listOrganisations).toHaveBeenCalledWith(
      { importId: "8f14e45f-ceea-467e-b7ea-05a3778a1234" },
      expect.any(Number),
    );
  });

  it("shows the filtered-empty state, not the plain empty state, when an import filter matches nothing", async () => {
    listOrganisations.mockResolvedValue([]);
    render(
      await Page({
        searchParams: Promise.resolve({ import: "8f14e45f-ceea-467e-b7ea-05a3778a1234" }),
      }),
    );
    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.queryByText("Nothing here yet")).toBeNull();
  });
});
