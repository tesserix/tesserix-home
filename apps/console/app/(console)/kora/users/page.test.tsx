import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// `useUrlFilters` reads the router, which jsdom has no app-router context for.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/kora/users",
  useSearchParams: () => new URLSearchParams(),
}));

import { PlatformApiError } from "@/lib/platform-api";
import type { EntityPage } from "@/lib/entities";
import {
  USER_EMPTY_MESSAGE,
  USER_UNAVAILABLE_TITLE,
  currentPath,
  directoryState,
  readUserFilters,
  userReadError,
} from "./page";
import { UserDirectory } from "./user-directory";

const withHandle = {
  id: "kora:u1",
  source: "kora",
  type: "users",
  label: "Mahesh",
  sublabel: "@mahesh",
  createdAt: "2026-08-01T09:00:00Z",
};

const page = (over: Partial<EntityPage> = {}): EntityPage => ({
  data: [withHandle],
  pagination: { page: 1, limit: 100, total: 18 },
  ...over,
});

const common = {
  descriptors: [{ key: "q", label: "Search users", type: "search" as const }],
  values: {},
  emptyMessage: USER_EMPTY_MESSAGE,
  scopeNote: "note",
  reauthReturnTo: "/kora/users",
};

describe("readUserFilters", () => {
  it("reads a search, and drops a blank one", () => {
    expect(readUserFilters({ q: "mah" })).toEqual({ q: "mah" });
    // A blank q is a BROWSE; `q=` would filter on the empty string.
    expect(readUserFilters({ q: "  " })).toEqual({});
    expect(readUserFilters({})).toEqual({});
  });

  it("ignores a repeated parameter", () => {
    expect(readUserFilters({ q: ["a", "b"] })).toEqual({});
  });
});

describe("states", () => {
  it("attaches this surface's 501 copy rather than the kit's default", () => {
    expect(userReadError(new PlatformApiError("x", 501))?.unavailable?.title).toBe(
      USER_UNAVAILABLE_TITLE,
    );
  });

  // This surface has a search, so "no results, clear it" is true and useful —
  // and a different claim from "Kora has no users".
  it("distinguishes no users from a search that matched nothing", () => {
    expect(directoryState({ error: null, rows: [], filtered: false }).kind).toBe("empty");
    expect(directoryState({ error: null, rows: [], filtered: true }).kind).toBe("filtered-empty");
  });

  it("preserves the operator's query for re-auth", () => {
    expect(currentPath({ q: "mah" })).toBe("/kora/users?q=mah");
    expect(currentPath({})).toBe("/kora/users");
  });
});

describe("UserDirectory", () => {
  // THE reason the sublabel is carried through platform-api at all. Display
  // names are not unique: without it, two users called "Mahesh" render
  // identically and an operator cannot tell them apart.
  it("renders the handle beneath the name, which is what disambiguates them", () => {
    render(
      <UserDirectory
        {...common}
        page={page()}
        state={directoryState({ error: null, rows: [withHandle], filtered: false })}
      />,
    );
    expect(screen.getByText("Mahesh")).toBeInTheDocument();
    expect(screen.getByText("@mahesh")).toBeInTheDocument();
  });

  // mark8ly emits no sublabel and that is a legitimate shape. A placeholder
  // would make "this product sends none" look like "this user has no handle".
  it("renders nothing rather than a placeholder when there is no sublabel", () => {
    const { sublabel: _dropped, ...bare } = withHandle;
    const { container } = render(
      <UserDirectory
        {...common}
        page={page({ data: [bare] })}
        state={directoryState({ error: null, rows: [bare], filtered: false })}
      />,
    );
    expect(screen.getByText("Mahesh")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/—|unknown|n\/a/i);
  });

  it("says how many are shown of how many exist", () => {
    render(
      <UserDirectory
        {...common}
        page={page()}
        state={directoryState({ error: null, rows: [withHandle], filtered: false })}
      />,
    );
    expect(screen.getByText(/Showing 1 of 18 users/)).toBeInTheDocument();
  });

  // Kora serves DELETE /v1/admin/users/:id and this page deliberately does not
  // offer it — pending the verb-capability decision mark8ly#288 also waits on.
  // Asserted so adding one is a deliberate act rather than a drive-by.
  it("offers no destructive action", () => {
    render(
      <UserDirectory
        {...common}
        page={page()}
        state={directoryState({ error: null, rows: [withHandle], filtered: false })}
      />,
    );
    expect(screen.queryByRole("button", { name: /delete|remove/i })).toBeNull();
  });
});
