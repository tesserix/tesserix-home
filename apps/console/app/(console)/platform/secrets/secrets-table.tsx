"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Callout,
  CalloutDescription,
  CalloutTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import { AlertTriangle } from "lucide-react";
import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
// Type-only because only types are needed here — this file uses `InventoryRow`,
// `SecretsInventory` and `SecretStore` purely as shapes, never as values.
// Unlike `outbox-table.tsx`'s identical-looking `import type` (which really is
// guarding against dragging `pg` into the browser bundle via `lib/outbox.ts`'s
// value import of `platform-api`), there is nothing to guard against here:
// `lib/secrets.ts` has zero imports of its own — it's a dependency-free leaf,
// downstream of `secrets-api.ts` rather than upstream of it. A value import of
// it would drag in nothing.
import type { InventoryRow, SecretsInventory, SecretStore } from "@/lib/secrets";

/**
 * The client half of the secrets inventory — the filter row, the counts, the
 * table, and the completeness notice.
 *
 * A client component for the same reason every sibling surface table is:
 * `@tesserix/web`'s barrel is `"use client"`, and the filter row here needs
 * `useState`. The page stays a server component so the estate walk happens on
 * the server.
 */

const STORE_LABEL: Record<SecretStore, string> = {
  openbao: "OpenBao",
  gcpsm: "Google Secret Manager",
};

/**
 * The row-level reader chip.
 *
 * `hasReader` is compared against its three states explicitly — `=== false`,
 * `=== null`, and otherwise `true` — rather than negated. `!row.hasReader`
 * would also catch `null`, which silently marks every Google Secret Manager
 * row as an orphan: `null` means "the console cannot see GSM's IAM bindings",
 * not "nothing can read this". Only an OpenBao row that genuinely has no
 * grant gets the alarm.
 */
export function ReaderChip({ hasReader }: { hasReader: boolean | null }) {
  if (hasReader === null) {
    return <Badge variant="neutral">Access via IAM</Badge>;
  }
  if (hasReader === false) {
    return <Badge variant="warning">No reader</Badge>;
  }
  return <Badge variant="success">Has a reader</Badge>;
}

/**
 * The estate walk was cut short by its depth or node bound, so `rows` may not
 * be the whole estate.
 *
 * This surface's entire job is flagging a secret nothing can read — "not in
 * the list" is exactly the signal an operator is meant to act on here, so a
 * truncated walk presented as the whole estate would read as a false
 * all-clear rather than an omission. Rendered unconditionally would defeat
 * the point: it must appear only when `SecretsInventory.complete` is false.
 */
export function IncompleteInventoryNotice() {
  return (
    <Callout variant="warning" role="status">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <CalloutTitle>This inventory may be incomplete</CalloutTitle>
      </div>
      <CalloutDescription>
        The estate walk that built this list stopped before reaching every secret. A secret not
        shown below is not evidence that it does not exist, or that it has a reader.
      </CalloutDescription>
    </Callout>
  );
}

/**
 * The detail route's href for one row: the path becomes the catch-all
 * segment, and the store rides along as `?store=`, because a path alone does
 * not identify a secret — the same path can exist in both stores. See the
 * "How the store reaches this route" comment on `[...path]/page.tsx` for why
 * a search param was chosen over folding the store into the path segment.
 *
 * Each path segment is encoded on its own, matching `encodeSecretPath` in
 * `lib/secrets-api.ts` — a literal "/" inside a segment is already rejected
 * at the listing boundary (`parseSecretList`), but encoding per-segment
 * rather than the joined string keeps this link correct even if that ever
 * changes.
 */
export function secretDetailHref(row: Pick<InventoryRow, "path" | "store">): string {
  const encodedPath = row.path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/platform/secrets/${encodedPath}?store=${encodeURIComponent(row.store)}`;
}

type FilterId = "all" | "openbao" | "gcpsm" | "noReader";

interface FilterDescriptor {
  readonly id: FilterId;
  readonly label: string;
  readonly count: number;
}

/**
 * Does `row` belong to `filter`?
 *
 * The `noReader` case is compared against `=== false` for the same reason
 * `ReaderChip` is: `!row.hasReader` would pull every Google Secret Manager row
 * into a filter named "no reader", which is exactly the false alarm this
 * surface exists to avoid.
 */
function matchesFilter(row: InventoryRow, filter: FilterId): boolean {
  switch (filter) {
    case "all":
      return true;
    case "openbao":
    case "gcpsm":
      return row.store === filter;
    case "noReader":
      return row.hasReader === false;
  }
}

export interface SecretsTableProps {
  inventory: SecretsInventory;
  state: SurfaceState;
  emptyMessage: string;
  reauthReturnTo: string;
}

export function SecretsTable({ inventory, state, emptyMessage, reauthReturnTo }: SecretsTableProps) {
  const { rows, counts, complete } = inventory;
  const [filter, setFilter] = useState<FilterId>("all");

  // The rows shown are filtered client-side, but the counts above them never
  // are — see `FilterDescriptor`'s `count` below, which reads `counts`
  // directly rather than `rows.filter(...).length`. A count that moved with
  // the filter would answer "how many are on screen", a question this row of
  // buttons already answers by the table beneath it; its job is "how many are
  // in the estate".
  const visibleRows = useMemo(() => rows.filter((row) => matchesFilter(row, filter)), [rows, filter]);

  const filters: readonly FilterDescriptor[] = [
    { id: "all", label: "All", count: counts.all },
    { id: "openbao", label: "OpenBao", count: counts.openbao },
    { id: "gcpsm", label: "Google Secret Manager", count: counts.gcpsm },
    { id: "noReader", label: "No reader", count: counts.noReader },
  ];

  return (
    <div className="flex flex-col gap-4">
      {complete ? null : <IncompleteInventoryNotice />}

      {state.kind === "ready" ? (
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Filter secrets"
        >
          {filters.map((f) => (
            <Button
              key={f.id}
              type="button"
              size="sm"
              variant={filter === f.id ? "default" : "outline"}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label} ({f.count})
            </Button>
          ))}
        </div>
      ) : null}

      {state.kind === "ready" ? (
        visibleRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No secrets match this filter.</p>
        ) : (
          <Table aria-label="Secrets inventory">
            <TableHeader>
              <TableRow>
                <TableHead>Path</TableHead>
                <TableHead>Store</TableHead>
                <TableHead>Reader</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row: InventoryRow) => (
                <TableRow key={`${row.store}:${row.path}`}>
                  <TableCell className="font-mono text-xs">
                    <Link
                      href={secretDetailHref(row)}
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      {row.path}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{STORE_LABEL[row.store]}</Badge>
                  </TableCell>
                  <TableCell>
                    <ReaderChip hasReader={row.hasReader} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      ) : (
        <SurfaceStateView state={state} emptyMessage={emptyMessage} reauthReturnTo={reauthReturnTo} />
      )}
    </div>
  );
}
