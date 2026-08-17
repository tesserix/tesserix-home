"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
  mergeFiltersIntoQuery,
  queryToFilters,
  type FilterDescriptor,
  type FilterValues,
  type UrlFilters,
} from "@/components/kit/filter-bar";
import { SurfaceStateView, type SurfaceState } from "@/components/kit/states";
import type { OrganisationListRow } from "@/lib/db/crm-repo";

/**
 * Same URL-round-trip contract as `useUrlFilters` (`filter-bar.tsx`), with
 * one addition: every filter mutation also drops `?cursor=`. This surface
 * paginates by cursor, not by the `page` param `mergeFiltersIntoQuery`
 * already knows to clear on a filter change, so without this it would be
 * possible to narrow a filter while on page 3 and land on an empty page 3 of
 * a now-shorter list — indistinguishable from "no results" rather than
 * "you're past the end". Both the merge and the cursor drop happen inside
 * one `push`, in one `router.replace`, so a quick filter change can never
 * race a separate cursor-clearing navigation into overwriting it.
 */
function useOrganisationUrlFilters(descriptors: FilterDescriptor[]): UrlFilters {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const searchString = searchParams.toString();

  const values = useMemo(
    () => queryToFilters(new URLSearchParams(searchString), descriptors),
    [searchString, descriptors],
  );

  // Same race guard as `useUrlFilters`: `router.replace` is asynchronous, so
  // `searchParams` still holds the old query for the rest of the tick.
  const pendingRef = useRef<string | null>(null);
  useEffect(() => {
    pendingRef.current = null;
  }, [searchString]);

  const push = useCallback(
    (update: (previous: FilterValues) => FilterValues) => {
      const current = new URLSearchParams(pendingRef.current ?? searchString);
      const previous = queryToFilters(current, descriptors);
      const merged = new URLSearchParams(mergeFiltersIntoQuery(current, descriptors, update(previous)));
      merged.delete("cursor");
      const query = merged.toString();
      pendingRef.current = query;
      router.replace(query ? `${pathname}?${query}` : pathname);
    },
    [router, pathname, searchString, descriptors],
  );

  const set = useCallback(
    (key: string, value: string) => {
      push((previous) => {
        const next = { ...previous, [key]: value };
        if (value === "") {
          delete next[key];
        }
        return next;
      });
    },
    [push],
  );

  const clear = useCallback(() => push(() => ({})), [push]);

  return { values, set, clear };
}

function ProductsCell({ products }: { products: readonly string[] }) {
  if (products.length === 0) return <span className="text-muted-foreground">—</span>;
  return <span>{products.join(", ")}</span>;
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
}

/**
 * The position of this page within the matching set, plus the next-page link.
 *
 * A range ("101–200 of 259"), not a bare count of the rows on screen: with
 * `rows.length` both page 1 and page 2 of a 259-row result read "100 of 259"
 * and an operator could not tell which page they were on.
 *
 * `aria-live="polite"` on the count: it changes both when the operator
 * types a search and when they page, and a screen reader user needs to
 * hear the new count without it stealing focus — WCAG 2.1 AA.
 *
 * The next control is an `<a href>`, not a button: a page of results is a
 * location, so it must be back-button-navigable and shareable, and it is
 * rendered only when `nextHref` is non-null — a dead "next" on the last
 * page promises a page that isn't there.
 */
interface ResultCountProps {
  rows: readonly OrganisationListRow[];
  total: number;
  precedingCount: number;
  nextHref: string | null;
}

function ResultCount({ rows, total, precedingCount, nextHref }: ResultCountProps) {
  const first = precedingCount + 1;
  const last = precedingCount + rows.length;
  return (
    <div className="flex items-center justify-between gap-2">
      <span aria-live="polite" className="text-sm text-muted-foreground">
        {first}–{last} of {total}
      </span>
      {nextHref ? (
        <Button asChild size="sm" variant="outline">
          <Link href={nextHref}>Next</Link>
        </Button>
      ) : null}
    </div>
  );
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
}: OrganisationsViewProps) {
  const { set, clear } = useOrganisationUrlFilters(descriptors);

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
          <ResultCount rows={rows} total={total} precedingCount={precedingCount} nextHref={nextHref} />
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
