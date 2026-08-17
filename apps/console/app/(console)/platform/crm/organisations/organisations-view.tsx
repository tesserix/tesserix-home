"use client";

import Link from "next/link";
import {
  Button,
  Callout,
  CalloutDescription,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
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
  /** Whether the server found at least one row beyond the ones in `rows`.
   *  See `page.tsx`'s `PAGE_SIZE`: real pagination is deferred, so the honest
   *  minimum is to say the list is cut off rather than let rows vanish. */
  truncated: boolean;
  /** How many rows `rows` is capped at — named in the notice, so the operator
   *  knows the size of what they are not being shown. */
  pageSize: number;
}

/**
 * The truncation notice.
 *
 * `role="status"` (a polite live region), not muted text under the table: it
 * appears and disappears as the operator types a search, and a screen reader
 * user who has just narrowed a list has to be told the list is STILL cut off
 * — WCAG 2.1 AA, and the reason this is announced rather than merely
 * rendered.
 *
 * It names search as the remedy because search is the remedy that exists
 * today: `listOrganisations` filters in SQL, so narrowing genuinely reaches
 * rows past the cap rather than filtering the visible page.
 */
function TruncationNotice({ pageSize }: { pageSize: number }) {
  return (
    <Callout role="status">
      <CalloutDescription>
        Showing the {pageSize} most recent organisations. There are more — narrow the list with
        search to reach them.
      </CalloutDescription>
    </Callout>
  );
}

export function OrganisationsView({
  rows,
  state,
  emptyMessage,
  search,
  truncated,
  pageSize,
}: OrganisationsViewProps) {
  const { set, clear } = useUrlFilters(DESCRIPTORS);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <SearchFilterInput
          label={SEARCH_DESCRIPTOR.label}
          value={search}
          onCommit={(next) => set(SEARCH_DESCRIPTOR.key, next)}
        />
        {/* A lead phoned in has no CSV row to import through — this is the
         *  other door into the CRM (#213), same manual-create surface
         *  `createOrganisationAction` writes through. */}
        <Button asChild size="sm">
          <Link href="/platform/crm/organisations/new">Add organisation</Link>
        </Button>
      </div>

      {state.kind === "ready" ? (
        <div className="flex flex-col gap-3">
          {truncated ? <TruncationNotice pageSize={pageSize} /> : null}
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
        </div>
      ) : (
        <SurfaceStateView state={state} emptyMessage={emptyMessage} onClearFilters={clear} />
      )}
    </div>
  );
}
