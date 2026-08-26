import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/kora/users",
  useSearchParams: () => new URLSearchParams(),
}));

import type { EntityPage } from "@/lib/entities";
import { UserDirectory } from "./user-directory";

const MAHESH = {
  id: "kora:u1",
  source: "kora",
  type: "users",
  label: "Mahesh",
  sublabel: "@mahesh",
  createdAt: "2026-08-01T09:00:00Z",
};

const PAGE: EntityPage = {
  data: [MAHESH],
  pagination: { page: 1, limit: 100, total: 18 },
};

function renderDirectory() {
  return render(
    <UserDirectory
      descriptors={[{ key: "q", label: "Search users", type: "search" }]}
      values={{}}
      page={PAGE}
      pager={{ precedingCount: 0, nextHref: "?page=2", previousHref: null }}
      state={{ kind: "ready" }}
      emptyMessage="Kora has no users yet."
      scopeNote="note"
      reauthReturnTo="/kora/users"
    />,
  );
}

describe("UserDirectory pager placement", () => {
  // Matches the two CRM surfaces, and the food index alongside it. DOM order
  // rather than a snapshot, so this fails only if the order flips back.
  it("puts the pager before the table", () => {
    const { container } = renderDirectory();
    const pager = screen.getByRole("navigation", { name: "users pagination" });
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(
      pager.compareDocumentPosition(table as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Scope guard. The user rows carry the same six fields and the same
  // argument for a disclosure, but the request was foods; a trigger appearing
  // here means Change A leaked past its scope.
  it("leaves the user rows without a disclosure", () => {
    renderDirectory();
    expect(screen.queryByRole("button", { name: "Mahesh" })).toBeNull();
    expect(screen.getByText("Mahesh")).toBeInTheDocument();
  });
});
