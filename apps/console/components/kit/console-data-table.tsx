"use client";

import { useState } from "react";
import {
  BulkActionsBar,
  Checkbox,
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { SurfaceStateView, type SurfaceState } from "./states";

export interface Column<T> {
  key: string;
  header: string;
  sortable?: boolean;
  cell: (row: T) => React.ReactNode;
}

export interface SortSpec {
  key: string;
  dir: "asc" | "desc";
}

export interface BulkAction {
  id: string;
  label: string;
  destructive?: boolean;
  run(ids: string[]): Promise<void>;
}

export interface ConsoleDataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  total: number;
  page: number;
  pageSize: number;
  onPageChange(page: number): void;
  sort?: SortSpec;
  onSortChange?(s: SortSpec): void;
  state: SurfaceState;
  emptyMessage: string;
  selection?: { selected: Set<string>; onChange(s: Set<string>): void };
  bulkActions?: BulkAction[];
  onRetry?: () => void;
  onClearFilters?: () => void;
}

function nextSort(current: SortSpec | undefined, key: string): SortSpec {
  if (current?.key === key) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { key, dir: "asc" };
}

function SortIndicator({ sort, columnKey }: { sort?: SortSpec; columnKey: string }) {
  if (sort?.key !== columnKey) {
    return <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" aria-hidden="true" />;
  }
  return sort.dir === "asc" ? (
    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
  ) : (
    <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
  );
}

/**
 * Server-driven table. It never sorts or paginates in memory — `rows` is
 * exactly the page the caller fetched, and every interaction is reported
 * upward through `onPageChange`/`onSortChange`.
 *
 * Built alongside `@tesserix/web`'s `DataTable` rather than on top of it:
 * that one is entirely client-side and has no notion of a total count or a
 * page change, so a server-paged surface cannot be expressed with it.
 */
export function ConsoleDataTable<T>({
  columns,
  rows,
  rowKey,
  total,
  page,
  pageSize,
  onPageChange,
  sort,
  onSortChange,
  state,
  emptyMessage,
  selection,
  bulkActions,
  onRetry,
  onClearFilters,
}: ConsoleDataTableProps<T>) {
  const [runningAction, setRunningAction] = useState<string | null>(null);

  if (state.kind !== "ready") {
    return (
      <SurfaceStateView
        state={state}
        emptyMessage={emptyMessage}
        onRetry={onRetry}
        onClearFilters={onClearFilters}
      />
    );
  }

  const pageKeys = rows.map(rowKey);
  const selected = selection?.selected ?? new Set<string>();
  const allOnPageSelected = pageKeys.length > 0 && pageKeys.every((key) => selected.has(key));
  const someOnPageSelected = pageKeys.some((key) => selected.has(key));

  function toggleRow(key: string, checked: boolean) {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (checked) {
      next.add(key);
    } else {
      next.delete(key);
    }
    selection.onChange(next);
  }

  function togglePage(checked: boolean) {
    if (!selection) return;
    const next = new Set(selection.selected);
    for (const key of pageKeys) {
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
    }
    selection.onChange(next);
  }

  async function runBulkAction(actionId: string) {
    const action = bulkActions?.find((candidate) => candidate.id === actionId);
    if (!action || !selection) return;
    setRunningAction(actionId);
    try {
      await action.run([...selection.selected]);
      selection.onChange(new Set());
    } finally {
      setRunningAction(null);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);
  const showBulkBar = Boolean(bulkActions?.length) && selected.size > 0;

  return (
    <div className="space-y-3">
      {showBulkBar ? (
        <BulkActionsBar
          selectedCount={selected.size}
          actions={(bulkActions ?? []).map((action) => ({
            id: action.id,
            label: action.label,
            dangerous: action.destructive,
            disabled: runningAction !== null,
          }))}
          onAction={(actionId) => void runBulkAction(actionId)}
          onClearSelection={() => selection?.onChange(new Set())}
        />
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            {selection ? (
              <TableHead className="w-10">
                <Checkbox
                  aria-label="Select all rows on this page"
                  checked={
                    allOnPageSelected ? true : someOnPageSelected ? "indeterminate" : false
                  }
                  onCheckedChange={(checked) => togglePage(checked === true)}
                />
              </TableHead>
            ) : null}
            {columns.map((column) => {
              const sorted = sort?.key === column.key;
              const canSort = Boolean(column.sortable && onSortChange);
              return (
                <TableHead
                  key={column.key}
                  aria-sort={
                    sorted ? (sort?.dir === "asc" ? "ascending" : "descending") : undefined
                  }
                >
                  {canSort ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => onSortChange?.(nextSort(sort, column.key))}
                    >
                      {column.header}
                      <SortIndicator sort={sort} columnKey={column.key} />
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <TableRow key={key} data-state={selected.has(key) ? "selected" : undefined}>
                {selection ? (
                  <TableCell className="w-10">
                    <Checkbox
                      aria-label={`Select row ${key}`}
                      checked={selected.has(key)}
                      onCheckedChange={(checked) => toggleRow(key, checked === true)}
                    />
                  </TableCell>
                ) : null}
                {columns.map((column) => (
                  <TableCell key={column.key}>{column.cell(row)}</TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {`Showing ${firstRow}–${lastRow} of ${total}`}
        </p>
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                disabled={page <= 1}
                onClick={() => onPageChange(page - 1)}
              />
            </PaginationItem>
            <PaginationItem>
              <span className="px-3 text-sm text-muted-foreground">
                {`Page ${page} of ${totalPages}`}
              </span>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                disabled={page >= totalPages}
                onClick={() => onPageChange(page + 1)}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}
