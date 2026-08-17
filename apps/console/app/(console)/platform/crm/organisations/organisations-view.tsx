"use client";

import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@tesserix/web";
import { SearchFilterInput, useUrlFilters, type FilterDescriptor } from "@/components/kit/filter-bar";
import { SurfaceStateView, type SurfaceState } from "@/components/kit/states";
import type { OrganisationListRow } from "@/lib/db/crm-repo";

/** A single descriptor, not a full `FilterBar`: this surface has one filter
 *  (free-text search), so `useUrlFilters` is reused directly for its URL
 *  round-trip rather than pulling in the multi-filter bar `queue-view.tsx`
 *  needs for product/stage/owner. */
const SEARCH_DESCRIPTOR: FilterDescriptor = { key: "q", label: "Search organisations", type: "search" };
const DESCRIPTORS: FilterDescriptor[] = [SEARCH_DESCRIPTOR];

function ProductsCell({ products }: { products: readonly string[] }) {
  if (products.length === 0) return <span className="text-muted-foreground">—</span>;
  return <span>{products.join(", ")}</span>;
}

export interface OrganisationsViewProps {
  rows: readonly OrganisationListRow[];
  state: SurfaceState;
  emptyMessage: string;
  /** The search term the server actually applied — not what the URL happens
   *  to say — same reasoning as `CrmQueueView`'s `values` prop. */
  search: string;
}

export function OrganisationsView({ rows, state, emptyMessage, search }: OrganisationsViewProps) {
  const { set, clear } = useUrlFilters(DESCRIPTORS);

  return (
    <div className="flex flex-col gap-6">
      <SearchFilterInput
        label={SEARCH_DESCRIPTOR.label}
        value={search}
        onCommit={(next) => set(SEARCH_DESCRIPTOR.key, next)}
      />

      {state.kind === "ready" ? (
        <Table aria-label="Organisations">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Primary contact</TableHead>
              <TableHead>Open</TableHead>
              <TableHead>Products</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link href={`/platform/crm/${row.id}`} className="font-medium hover:underline">
                    {row.name}
                  </Link>
                </TableCell>
                <TableCell>{row.location ?? <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell>
                  {row.contactName || row.contactEmail ? (
                    <div className="flex flex-col">
                      {row.contactName ? <span>{row.contactName}</span> : null}
                      {row.contactEmail ? (
                        <span className="text-muted-foreground">{row.contactEmail}</span>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>{row.openOpportunities}</TableCell>
                <TableCell>
                  <ProductsCell products={row.products} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <SurfaceStateView state={state} emptyMessage={emptyMessage} onClearFilters={clear} />
      )}
    </div>
  );
}
