"use client";

import Link from "next/link";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import {
  FilterBar,
  useUrlFilters,
  type FilterDescriptor,
  type FilterValues,
} from "@/components/kit/filter-bar";
import { ResultPager } from "@/components/kit/result-pager";
import { SurfaceStateView, type SurfaceState } from "@/components/kit/states";
import type { OrganisationListRow } from "@/lib/db/crm-repo";

/**
 * Every filter mutation on this surface also drops `?cursor=`: it paginates
 * by cursor, not by the `page` param `mergeFiltersIntoQuery` already clears.
 * A module constant so the hook's memoised `push` keeps a stable identity.
 */
const CURSOR_PARAMS = ["cursor"] as const;

/**
 * How many products a row names before the rest collapse into "+N more".
 *
 * Three, because products come from `ESTATE` — seven contexts today — so an
 * unbounded join can put seven comma-separated names into one cell of a
 * five-column table and push the columns an operator actually scans (name,
 * location, contact) off to the side. Three names sit within the widths the
 * other cells already occupy, and cover a row's whole product set for the
 * single- and dual-product cases without any "+N more" at all.
 */
const PRODUCTS_SHOWN = 3;

/**
 * The row's products, capped at `PRODUCTS_SHOWN` with a muted "+N more" tail
 * — the same muted-secondary idiom the contact cell and the em-dash empty
 * states in this file already use, no new colour.
 *
 * Nothing becomes unreachable: the overflowing names are rendered as
 * `sr-only` text (so they are in the cell's accessible name and findable by
 * assistive tech) as well as in `title` (so a sighted mouse user can hover).
 * `title` alone would satisfy neither keyboard nor screen-reader users, which
 * is why it is the secondary affordance rather than the only one.
 */
function ProductsCell({ products }: { products: readonly string[] }) {
  if (products.length === 0) return <span className="text-muted-foreground">—</span>;

  const shown = products.slice(0, PRODUCTS_SHOWN);
  const hidden = products.slice(PRODUCTS_SHOWN);
  if (hidden.length === 0) return <span>{shown.join(", ")}</span>;

  return (
    <span title={products.join(", ")}>
      {shown.join(", ")}
      <span className="text-muted-foreground"> +{hidden.length} more</span>
      <span className="sr-only">: {hidden.join(", ")}</span>
    </span>
  );
}

/**
 * A row is a solo creator when it has exactly one contact and no website. For
 * those, the organisation name is derived from the Instagram profile and the
 * handle is the real identity, so the handle leads. Anything else is a
 * business and leads with its name.
 *
 * `location` is deliberately NOT part of this test, though an earlier draft of
 * this plan included it. Measured against production: 201 of 259 organisations
 * have no website, but only 159 of those also have no location — so requiring
 * `!location` would render 42 solo creators name-first purely because
 * Instagram listed a city on their profile. Location is scraped profile
 * metadata; it is no evidence of being a registered business. A website is.
 *
 * `contactCount === 1` is inert today (every one of the 259 has exactly one
 * contact) and is kept for the case it actually guards: a business with
 * several named contacts is a business regardless of its website.
 */
function leadsWithHandle(row: OrganisationListRow): boolean {
  return row.contactCount === 1 && !row.websiteUrl && Boolean(row.contactHandle);
}

/**
 * The row's leading identity cell. When `leadsWithHandle`, the handle is the
 * primary (larger, first) text and the organisation name renders beneath it
 * as secondary text — never dropped, since an operator may have searched for
 * that name (search covers organisation name and contact name/email/handle;
 * see `organisationFilterClauses`). The link's accessible name comes from its
 * full text content, so it always includes both the handle and the name —
 * never just "@handle" with the business itself unidentifiable.
 */
function NameCell({ row }: { row: OrganisationListRow }) {
  if (leadsWithHandle(row)) {
    return (
      <Link href={`/platform/crm/${row.id}`} className="flex flex-col hover:underline">
        <span className="font-medium">@{row.contactHandle}</span>
        <span className="text-muted-foreground">{row.name}</span>
      </Link>
    );
  }
  return (
    <Link href={`/platform/crm/${row.id}`} className="font-medium hover:underline">
      {row.name}
    </Link>
  );
}

export interface OrganisationsViewProps {
  rows: readonly OrganisationListRow[];
  state: SurfaceState;
  emptyMessage: string;
  /** The filter bar's descriptors, built server-side in `page.tsx` from
   *  `ESTATE`/`COUNTRY_LABELS`/`FOLLOWER_BANDS` — same split as
   *  `CrmQueueView`'s `descriptors` prop. */
  descriptors: FilterDescriptor[];
  /** The filters the server actually applied — not what the URL happens to
   *  say — same reasoning as `CrmQueueView`'s `values` prop. */
  values: FilterValues;
  /** True count matching the current filter, ignoring the page limit — an
   *  operator sizing up a 259-lead backlog needs the number, not a vague
   *  "there are more". */
  total: number;
  /** How many matching rows sort ahead of this page, straight from the repo
   *  — 0 on the first page. The range below is rendered from this, so the
   *  displayed position always describes the rows actually fetched. */
  precedingCount: number;
  /** Where `?cursor=` for the next page points, with every other active
   *  param carried over by `page.tsx`'s `buildNextHref`; `null` on the last
   *  page. */
  nextHref: string | null;
  /** The same for the previous page, built by `buildPreviousHref`; `null` on
   *  the first page. Required, not optional: `null` is the first-page answer,
   *  and a surface that simply forgot the prop would look identical to one
   *  that is genuinely on page one. */
  previousHref: string | null;
}

export function OrganisationsView({
  rows,
  state,
  emptyMessage,
  descriptors,
  values,
  total,
  precedingCount,
  nextHref,
  previousHref,
}: OrganisationsViewProps) {
  const { set, clear } = useUrlFilters(descriptors, CURSOR_PARAMS);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <FilterBar descriptors={descriptors} values={values} onChange={set} onClear={clear} />
        {/* A lead phoned in has no CSV row to import through — this is the
         *  other door into the CRM (#213), same manual-create surface
         *  `createOrganisationAction` writes through. */}
        <Button asChild size="sm">
          <Link href="/platform/crm/organisations/new">Add organisation</Link>
        </Button>
      </div>

      {state.kind === "ready" ? (
        <div className="flex flex-col gap-3">
          <ResultPager
            label="organisations"
            count={rows.length}
            total={total}
            precedingCount={precedingCount}
            nextHref={nextHref}
            previousHref={previousHref}
          />
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
                    <NameCell row={row} />
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
