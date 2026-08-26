import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// `useUrlFilters` reads the router, which jsdom has no app-router context for.
// Mocked exactly as `page.test.tsx` mocks it — this surface uses the same
// FilterBar.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/kora/foods",
  useSearchParams: () => new URLSearchParams(),
}));

import type { EntityPage, EntityRecord } from "@/lib/entities";
import { FoodIndex, type FoodIndexProps } from "./food-index";

// The disclosure is the whole of a food's detail: there is no get-one at any
// layer, so what a row can reveal is the rest of the `EntityRecord` and
// nothing else. These tests hold that shape honest — and hold the expansion
// state to the repo's immutability rule, which the two-row case is here to
// catch.

const KOLHAPURI: EntityRecord = {
  id: "kora:528ea893",
  source: "kora",
  type: "foods",
  label: "Veg kolhapuri",
  sublabel: "Aroma",
  createdAt: "2026-08-22T07:16:52Z",
};

const RAGI: EntityRecord = {
  id: "kora:9f31bc07",
  source: "kora",
  type: "foods",
  label: "Ragi mudde",
  sublabel: "Suvarna",
  createdAt: "2026-08-20T04:02:11Z",
};

const COMMON = {
  descriptors: [{ key: "q", label: "Search foods", type: "search" as const }],
  values: {},
  emptyMessage: "Kora has no foods yet.",
  scopeNote: "note",
  reauthReturnTo: "/kora/foods",
  state: { kind: "ready" } as const,
  pager: { precedingCount: 0, nextHref: "?page=2", previousHref: null },
};

function renderIndex(rows: readonly EntityRecord[], overrides: Partial<FoodIndexProps> = {}) {
  const page: EntityPage = {
    data: rows,
    pagination: { page: 1, limit: 100, total: 6421 },
  };
  return render(<FoodIndex {...COMMON} page={page} {...overrides} />);
}

describe("FoodIndex row disclosure", () => {
  it("keeps the record's identifiers out of the row until asked", () => {
    renderIndex([KOLHAPURI]);
    // The three fields the table does not already show. Absent while
    // collapsed — the index is a list, and an id on every row is noise the
    // operator did not ask for.
    expect(screen.queryByText("kora:528ea893")).toBeNull();
    expect(screen.queryByText("kora")).toBeNull();
    expect(screen.queryByText("foods")).toBeNull();
  });

  it("reveals them from the label, and hides them again", async () => {
    const user = userEvent.setup();
    renderIndex([KOLHAPURI]);

    // The label IS the trigger, and it is a real button: a row-level onClick
    // is unreachable by keyboard and invisible to a screen reader.
    const trigger = screen.getByRole("button", { name: "Veg kolhapuri" });
    await user.click(trigger);
    expect(screen.getByText("kora:528ea893")).toBeInTheDocument();
    expect(screen.getByText("kora")).toBeInTheDocument();
    expect(screen.getByText("foods")).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.queryByText("kora:528ea893")).toBeNull();
  });

  it("announces its state, and points at the row it reveals", async () => {
    const user = userEvent.setup();
    renderIndex([KOLHAPURI]);

    const trigger = screen.getByRole("button", { name: "Veg kolhapuri" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    // aria-controls that resolves to nothing is worse than none at all: a
    // screen reader offers the operator a jump to a row that is not there.
    const controls = trigger.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    const detail = document.getElementById(controls as string);
    expect(detail).not.toBeNull();
    expect(detail).toHaveTextContent("kora:528ea893");
  });

  it("expands two rows independently", async () => {
    const user = userEvent.setup();
    renderIndex([KOLHAPURI, RAGI]);

    await user.click(screen.getByRole("button", { name: "Veg kolhapuri" }));
    await user.click(screen.getByRole("button", { name: "Ragi mudde" }));

    // Both, still. This is the mutation guard: a toggle that calls `.add()` on
    // the Set it is holding passes React the same reference, the re-render is
    // skipped, and the first row silently collapses — or never opens.
    expect(screen.getByText("kora:528ea893")).toBeInTheDocument();
    expect(screen.getByText("kora:9f31bc07")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Veg kolhapuri" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Ragi mudde" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // And collapsing one leaves the other open.
    await user.click(screen.getByRole("button", { name: "Veg kolhapuri" }));
    expect(screen.queryByText("kora:528ea893")).toBeNull();
    expect(screen.getByText("kora:9f31bc07")).toBeInTheDocument();
  });

  it("gives two rows distinct detail ids, so neither trigger points at the other's row", async () => {
    const user = userEvent.setup();
    renderIndex([KOLHAPURI, RAGI]);

    await user.click(screen.getByRole("button", { name: "Veg kolhapuri" }));
    await user.click(screen.getByRole("button", { name: "Ragi mudde" }));

    const first = screen.getByRole("button", { name: "Veg kolhapuri" }).getAttribute("aria-controls");
    const second = screen.getByRole("button", { name: "Ragi mudde" }).getAttribute("aria-controls");
    expect(first).not.toBe(second);
    expect(document.getElementById(first as string)).toHaveTextContent("kora:528ea893");
    expect(document.getElementById(second as string)).toHaveTextContent("kora:9f31bc07");
  });

  // mark8ly emits no sublabel and §3.4 never defines the row, so absent is a
  // legitimate shape. A placeholder would make "this product sends none" look
  // like "this food has no brand". See #365.
  it("renders no placeholder for a food without a sublabel", () => {
    const { sublabel: _dropped, ...bare } = KOLHAPURI;
    const { container } = renderIndex([bare]);
    expect(screen.getByRole("button", { name: "Veg kolhapuri" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/unknown|n\/a/i);
  });
});

describe("FoodIndex pager placement", () => {
  // The two CRM surfaces put the pager above their table; Kora's sat below.
  // Asserted as DOM order rather than a snapshot so this fails loudly, and
  // only, if the order flips back.
  it("puts the pager before the table", () => {
    const { container } = renderIndex([KOLHAPURI]);
    const pager = screen.getByRole("navigation", { name: "foods pagination" });
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(
      pager.compareDocumentPosition(table as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
