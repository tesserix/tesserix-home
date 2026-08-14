import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ConsoleDataTable, type Column, type SortSpec } from "./console-data-table";

interface Row {
  id: string;
  name: string;
  product: string;
}

const ROWS: Row[] = [
  { id: "run-1:gate-a", name: "Nightly index rebuild", product: "kora" },
  { id: "run-2:gate-b", name: "Feedback backfill", product: "kora" },
];

const COLUMNS: Column<Row>[] = [
  { key: "name", header: "Name", sortable: true, cell: (row) => row.name },
  { key: "product", header: "Product", cell: (row) => row.product },
];

function renderTable(overrides: Partial<React.ComponentProps<typeof ConsoleDataTable<Row>>> = {}) {
  return render(
    <ConsoleDataTable<Row>
      columns={COLUMNS}
      rows={ROWS}
      rowKey={(row) => row.id}
      total={2}
      page={1}
      pageSize={25}
      onPageChange={() => {}}
      state={{ kind: "ready" }}
      emptyMessage="Runs appear here."
      {...overrides}
    />,
  );
}

describe("ConsoleDataTable selection", () => {
  it("names a row's checkbox with rowLabel rather than the composite key", () => {
    renderTable({
      selection: { selected: new Set<string>(), onChange: () => {} },
      rowLabel: (row) => `run “${row.name}”`,
    });

    expect(screen.getByRole("checkbox", { name: "Select run “Nightly index rebuild”" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select row run-1:gate-a" })).toBeNull();
  });

  it("falls back to the key when no rowLabel is given", () => {
    renderTable({ selection: { selected: new Set<string>(), onChange: () => {} } });
    expect(screen.getByRole("checkbox", { name: "Select row run-1:gate-a" })).toBeInTheDocument();
  });

  it("shows the page checkbox as indeterminate when only some of the page is selected", () => {
    renderTable({
      selection: { selected: new Set(["run-1:gate-a"]), onChange: () => {} },
    });
    expect(screen.getByRole("checkbox", { name: "Select all rows on this page" }))
      .toHaveAttribute("aria-checked", "mixed");
  });

  it("shows the page checkbox as checked only when the whole page is selected", () => {
    renderTable({
      selection: { selected: new Set(["run-1:gate-a", "run-2:gate-b"]), onChange: () => {} },
    });
    expect(screen.getByRole("checkbox", { name: "Select all rows on this page" }))
      .toHaveAttribute("aria-checked", "true");
  });

  it("adds the page to the selection without disturbing off-page rows", () => {
    const onChange = vi.fn();
    renderTable({
      // "off-page-row" is selected from a previous page and must survive.
      selection: { selected: new Set(["off-page-row"]), onChange },
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows on this page" }));

    expect(onChange).toHaveBeenCalledOnce();
    expect([...onChange.mock.calls[0][0]].sort()).toEqual([
      "off-page-row",
      "run-1:gate-a",
      "run-2:gate-b",
    ]);
  });

  it("removes only this page's rows when the page checkbox is cleared", () => {
    const onChange = vi.fn();
    renderTable({
      selection: {
        selected: new Set(["off-page-row", "run-1:gate-a", "run-2:gate-b"]),
        onChange,
      },
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows on this page" }));

    expect([...onChange.mock.calls[0][0]]).toEqual(["off-page-row"]);
  });
});

describe("ConsoleDataTable sorting", () => {
  function sortHeader() {
    return within(screen.getByRole("columnheader", { name: /Name/ })).getByRole("button");
  }

  it("marks a sortable but unsorted column as sortable, and a static one as neither", () => {
    renderTable({ onSortChange: () => {} });
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "none");
    expect(screen.getByRole("columnheader", { name: "Product" })).not.toHaveAttribute("aria-sort");
  });

  it("sorts ascending on first press of an unsorted column", () => {
    const onSortChange = vi.fn();
    renderTable({ onSortChange });
    fireEvent.click(sortHeader());
    expect(onSortChange).toHaveBeenCalledWith({ key: "name", dir: "asc" });
  });

  it("toggles direction on the already-sorted column and reflects it in aria-sort", () => {
    const onSortChange = vi.fn();
    const sort: SortSpec = { key: "name", dir: "asc" };
    const { rerender } = renderTable({ sort, onSortChange });

    expect(screen.getByRole("columnheader", { name: /Name/ }))
      .toHaveAttribute("aria-sort", "ascending");

    fireEvent.click(sortHeader());
    expect(onSortChange).toHaveBeenCalledWith({ key: "name", dir: "desc" });

    rerender(
      <ConsoleDataTable<Row>
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        total={2}
        page={1}
        pageSize={25}
        onPageChange={() => {}}
        state={{ kind: "ready" }}
        emptyMessage="Runs appear here."
        sort={{ key: "name", dir: "desc" }}
        onSortChange={onSortChange}
      />,
    );
    expect(screen.getByRole("columnheader", { name: /Name/ }))
      .toHaveAttribute("aria-sort", "descending");
  });

  it("starts a newly sorted column ascending rather than inheriting the old direction", () => {
    const onSortChange = vi.fn();
    renderTable({
      columns: [
        ...COLUMNS.slice(0, 1),
        { key: "product", header: "Product", sortable: true, cell: (row) => row.product },
      ],
      sort: { key: "product", dir: "desc" },
      onSortChange,
    });
    fireEvent.click(sortHeader());
    expect(onSortChange).toHaveBeenCalledWith({ key: "name", dir: "asc" });
  });
});
