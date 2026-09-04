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
import { COUNTRY_LABELS } from "@/lib/db/crm-country";
import { UNKNOWN_LABEL } from "@/lib/db/crm-filters";
import type { OrganisationListRow, OrganisationSort } from "@/lib/db/crm-repo";

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
 * Compact follower count for the table cell — `1.2k`, `15k`, `1.2M` — so the
 * column stays as narrow as the numeric cells elsewhere in the console while
 * still ranking rows at a glance.
 *
 * Re-authored rather than imported: `formatFollowers` in
 * `apps/web/app/admin/apps/mark8ly/leads/page.tsx` is the same four lines over
 * the same kind of number, but it belongs to another app over a different
 * table and reaching across that boundary would couple two surfaces that only
 * happen to agree. (`lib/ai-usage.ts`'s `tokenFormatter` is not it: it is
 * named for tokens and capitalises the K.)
 *
 * The decimal is dropped from five figures up because at that size the tenth
 * of a thousand is noise the operator cannot act on, and the exact number is
 * a hover away in `title` regardless.
 */
function formatFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * The primary contact's follower count — the CRM's only quantitative
 * qualification signal, and until now visible on no surface at all even
 * though the filter bands on it.
 *
 * An absent count renders as the same muted em-dash the other empty cells in
 * this file use, never as `0`: the rows behind it have no recorded value,
 * which is not the claim a measured zero makes, and they are exactly the rows
 * the Unknown follower band holds (see `UNKNOWN_LABEL` in `crm-filters.ts`).
 *
 * The exact number stays reachable in `title`, as in the prior art. That is a
 * hover-only affordance, which is acceptable here and not in `ProductsCell`:
 * the abbreviation loses precision an operator may want, not content — the
 * cell's accessible text already carries the magnitude the column exists to
 * convey.
 */
function FollowersCell({ count }: { count: number | null }) {
  if (count === null) return <span className="text-muted-foreground">—</span>;

  return <span title={`${count.toLocaleString()} followers`}>{formatFollowers(count)}</span>;
}

/**
 * The recorded location, with the country derived from it on a muted second
 * line — `Chennai` over `India`.
 *
 * Inside the Location cell rather than in a column of its own: `country` is
 * only ever a reading of `location`, so the two belong in one cell, and
 * `ProductsCell` above sets out what another column costs this table.
 *
 * A location the mapper had no entry for renders `Unknown` — the word the
 * country filter's sentinel option uses (`UNKNOWN_LABEL`, `crm-filters.ts`)
 * — not a blank line. A blank would leave the filter's misses looking
 * exactly like its hits, which is the whole reason this line exists.
 *
 * The word is shared with that sentinel; the SET of rows is not. The
 * sentinel matches `country IS NULL` (`crm-repo.ts`), which is the wider
 * fact: filtering to Unknown also returns the rows described below, whose
 * cell is a bare em-dash because there was no location to consult a mapper
 * about. 208 of the 259 production organisations have no derived country at
 * all (`crm-filters.ts`), split across those two renderings — and at least
 * 159 of the 259 have no location at all (see `leadsWithHandle` below), so
 * most rows never reach this line: the em-dash is what they are read on.
 * That is the distinction the two renderings exist to keep, so neither may
 * be collapsed into the other.
 *
 * With no location there is nothing to derive from, so the cell is the same
 * muted em-dash the other empty cells in this file use — never `Unknown`,
 * which would claim the mapper was consulted and failed. That branch is
 * safe because no writer can attach a country to a NULL location: the three
 * application writes all derive it with `countryFromLocation` (create and
 * update in `crm-writes.ts`, CSV import in `crm-repo.ts`); the one-shot
 * backfill updates only rows its own mapping pass resolved, which requires a
 * location; and `seed-dev.mjs` — the one writer that sets both columns
 * independently and applies no mapper — picks its location from a list with
 * no null in it. So the two absences stay apart: "no location on file" and
 * "a location that mapped to nothing" are different facts about the row.
 */
function LocationCell({ location, country }: { location: string | null; country: string | null }) {
  if (location === null) return <span className="text-muted-foreground">—</span>;

  return (
    <div className="flex flex-col">
      <span>{location}</span>
      <span className="text-muted-foreground">
        {country === null ? UNKNOWN_LABEL : (COUNTRY_LABELS[country] ?? country)}
      </span>
    </div>
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
  /** The ordering the server actually applied — `null` for the default
   *  `created_at DESC` list — not what the URL happens to say, same reasoning
   *  as `values` above. Required rather than optional for the reason
   *  `previousHref` is: `null` is a real answer here, and a caller that simply
   *  forgot the prop would be indistinguishable from an unsorted surface.
   *
   *  Nothing renders it yet. The sortable column headers that display and
   *  change it are Task 3 (#252 section J); this carries the state to them. */
  sort: OrganisationSort | null;
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
                <TableHead className="text-right">Followers</TableHead>
                <TableHead>Products</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <NameCell row={row} />
                  </TableCell>
                  <TableCell>
                    <LocationCell location={row.location} country={row.country} />
                  </TableCell>
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
                  {/* `tabular-nums` fixes the digit width so the abbreviated
                   *  counts stay comparable down the column, and `text-right`
                   *  puts their last digits on a common edge. The pairing
                   *  isn't a firm console-wide convention: several of the
                   *  console's numeric tables use it (e.g.
                   *  `platform/ai-usage/events-table.tsx`), but it's not
                   *  universal — `Open`, right beside it in this same row,
                   *  uses neither class, and other tables
                   *  (`platform/inbox/inbox-queue.tsx`,
                   *  `kora/ai-metrics/ai-metrics-view.tsx`) use
                   *  `tabular-nums` alone. No `text-xs`: `Open` renders
                   *  beside it at the default size, and two adjacent numeric
                   *  columns at different sizes read as two kinds of number
                   *  rather than two counts. */}
                  <TableCell className="text-right tabular-nums">
                    <FollowersCell count={row.followersCount} />
                  </TableCell>
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
