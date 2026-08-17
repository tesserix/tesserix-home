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

function orgRows(count: number): OrganisationListRow[] {
  return Array.from({ length: count }, (_, index) => ({
    ...ORG_ROW,
    id: `org-${index}`,
    name: `Organisation ${index}`,
  }));
}

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

  // Finding 1: full pagination is deliberately deferred, but the truncation
  // must not be silent — a 300-row import links here and this page is the
  // only way to reach a lead in its first fourteen days.
  describe("truncation", () => {
    it("over-fetches by one row so it can tell a full page from a truncated one", async () => {
      listOrganisations.mockResolvedValue([]);
      render(await Page({ searchParams: Promise.resolve({}) }));
      const [, limit] = listOrganisations.mock.calls[0];
      expect(limit).toBe(101);
    });

    it("renders only PAGE_SIZE rows and announces the truncation when there is more", async () => {
      listOrganisations.mockResolvedValue(orgRows(101));
      render(await Page({ searchParams: Promise.resolve({}) }));
      // The 101st row is evidence, never content: rendering it would make
      // the page silently one row longer than the cap it reports.
      expect(screen.queryByText("Organisation 100")).toBeNull();
      expect(screen.getByText("Organisation 99")).toBeInTheDocument();
      const notice = screen.getByRole("status");
      expect(notice).toHaveTextContent(/Showing the 100 most recent organisations/);
      expect(notice).toHaveTextContent(/search/);
    });

    it("shows no truncation notice when the whole list fits", async () => {
      listOrganisations.mockResolvedValue(orgRows(100));
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.getByText("Organisation 99")).toBeInTheDocument();
      expect(screen.queryByRole("status")).toBeNull();
    });
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
