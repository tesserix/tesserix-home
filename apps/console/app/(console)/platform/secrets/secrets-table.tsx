"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Callout,
  CalloutDescription,
  CalloutTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import { AlertTriangle } from "lucide-react";
import { consolePath } from "@tesserix/console-core";
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
 * The way in to `/platform/secrets/new`.
 *
 * The console's create-mode form has always existed and nothing could reach
 * it — `[...path]/page.tsx` turns a 404 into `notFound()`, so a path holding
 * nothing has no page to offer a create from. This link is the entry point
 * whose absence was that bug.
 *
 * In the page HEADER's `actions` slot, not under the list: the prototype
 * (`#screen-secrets`) puts the button below the table, and this console puts
 * page actions in the header on every other surface that has one
 * (`billing/page.tsx`'s `CatalogLink`, the ticket and organisation detail
 * pages). Following the prototype here would make this the one surface where
 * an operator has to scroll past 602 rows to find the create action.
 *
 * Lives in this client module rather than beside the page, for the reason
 * every kit import in this console has one: `@tesserix/web`'s barrel is
 * `"use client"` and `Button` resolves to `undefined` inside a server
 * component. `page.tsx` renders this as a client reference, which is fine —
 * it never calls it.
 *
 * `consolePath` rather than a literal: the route's identity lives in
 * `packages/console-core/src/routes.ts`, and a second spelling here is
 * exactly the drift that package exists to prevent.
 */
export function NewSecretLink() {
  return (
    <Button asChild size="sm">
      <Link href={consolePath("platform.newSecret")}>New secret</Link>
    </Button>
  );
}

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

/**
 * Does `row.path` match a typed search query?
 *
 * Case-insensitive substring on the path only — never the store or reader
 * columns, which already have their own dedicated chips above. An empty (or
 * all-whitespace) query matches everything, so a freshly-typed-then-cleared
 * box behaves exactly like no search was ever entered.
 */
function matchesSearch(row: InventoryRow, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return true;
  return row.path.toLowerCase().includes(trimmed);
}

/**
 * Copy for the "nothing survived the filter" row.
 *
 * The prototype's original wording — "No secrets match this filter." — is
 * accurate when only a store chip narrowed the view, but wrong once the
 * visitor typed a path: it points at "this filter" when the actual reason is
 * the search box, and an operator debugging a zero-result search should see
 * their own query implicated, not a vaguer noun. Kept in the same short,
 * declarative register as the original rather than growing into a sentence
 * that echoes the typed text back.
 */
function noMatchesMessage(searchQuery: string): string {
  return searchQuery.trim() === "" ? "No secrets match this filter." : "No secrets match this search.";
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
  // Ephemeral, like `filter` above: neither is backed by the URL, and
  // graduating only one of the two to a query param would leave a search
  // that survives a reload sitting next to a chip that doesn't — an
  // asymmetry worse than either choice on its own.
  const [searchQuery, setSearchQuery] = useState("");

  // The rows shown are filtered client-side, but the counts above them never
  // are — see `FilterDescriptor`'s `count` below, which reads `counts`
  // directly rather than `rows.filter(...).length`. A count that moved with
  // the filter would answer "how many are on screen", a question this row of
  // buttons already answers by the table beneath it; its job is "how many are
  // in the estate". The search box composes with the chip (AND, not OR) by
  // adding a second predicate to the same `filter` call rather than a
  // separate pass, so there is still exactly one place "what's on screen"
  // is decided.
  const visibleRows = useMemo(
    () => rows.filter((row) => matchesFilter(row, filter) && matchesSearch(row, searchQuery)),
    [rows, filter, searchQuery],
  );

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
        <div className="flex flex-wrap items-end gap-4">
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

          <div>
            <label
              className="text-xs uppercase tracking-wide text-muted-foreground"
              htmlFor="secrets-search"
            >
              Search by path
            </label>
            <Input
              id="secrets-search"
              type="search"
              className="mt-1 h-9 w-64"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="stripe, db-password…"
            />
          </div>
        </div>
      ) : null}

      {state.kind === "ready" ? (
        visibleRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{noMatchesMessage(searchQuery)}</p>
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
