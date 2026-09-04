import { ESTATE } from "@tesserix/console-core";
import { ConsolePageHeader } from "@/components/kit/page-header";
// Imported from `surface-state` and not from `states`: this is a server
// component, and `states.tsx` is a "use client" module whose exports become
// client references that throw when called on the server. See
// `crm/page.tsx:7-11` for the incident this guards against.
import { resolveState, type SurfaceState } from "@/components/kit/surface-state";
// Not `toSurfaceError`: these rejections come straight off `pg`, and its
// verbatim `.message` would render a Postgres error to an operator. See
// `@/lib/db-read-error`.
import { dbReadError } from "@/lib/db-read-error";
import {
  listOrganisations,
  type ListOrganisationsOptions,
  type OrganisationFilter,
  type OrganisationListRow,
  type OrganisationSort,
  type OrganisationSortKey,
  type SortDirection,
} from "@/lib/db/crm-repo";
import { pagerLinks, readPage } from "@/components/kit/entity-page";
import { COUNTRY_LABELS } from "@/lib/db/crm-country";
import {
  FOLLOWER_BANDS,
  UNASSIGNED_PRODUCT,
  UNKNOWN_COUNTRY,
  UNKNOWN_FOLLOWERS,
  UNKNOWN_LABEL,
  isFollowerFilter,
} from "@/lib/db/crm-filters";
import type { FilterDescriptor, FilterValues } from "@/components/kit/filter-bar";
import { OrganisationsView } from "./organisations-view";

/**
 * The organisation browse and search surface (#213).
 *
 * `commitImport` creates every opportunity at stage 'new' with a null
 * `next_action_at` and null `last_contacted_at`, so a freshly imported lead
 * is on neither the Due nor the Drifting queue for fourteen days. This page
 * is the only way to reach it in the meantime.
 */

/**
 * How many rows this surface renders per page. A 300-row import linked here
 * and, before pagination, showed 100 rows with nothing to say the other 200
 * existed — this page is the only way to reach a lead in its first fourteen
 * days, so the count and the next-page link both matter.
 */
const PAGE_SIZE = 100;

export const EMPTY_MESSAGE = "No organisations yet. Import some leads to get started.";

export type OrganisationsSearchParams = Record<string, string | string[] | undefined>;

/**
 * The organisations surface's filter bar.
 *
 * Product options come from the estate, not from whatever rows happen to be
 * on the current page — same reasoning as `QUEUE_FILTERS` in `crm/page.tsx`.
 * "Unassigned" is last rather than alphabetised in: every migrated lead and
 * every import lands with a null product (the bug #213 fixes), so it answers
 * a different question ("show me the rows nothing has been assigned to yet")
 * than picking a product does, and it is the option that surfaces the entire
 * present dataset — omitting it would hide all 259 production organisations
 * behind a filter that looks like it covers everyone.
 *
 * Country options are the closed set `COUNTRY_LABELS` declares — chips over
 * the derived column, never a free-text box over the raw `location` that
 * column exists to replace.
 */
export const ORGANISATION_FILTERS: FilterDescriptor[] = [
  { key: "q", label: "Search organisations", type: "search" },
  {
    key: "product",
    label: "Product",
    type: "select",
    options: [
      ...ESTATE.map((product) => ({ value: product.context, label: product.name })),
      { value: UNASSIGNED_PRODUCT, label: "Unassigned" },
    ],
  },
  {
    key: "country",
    label: "Country",
    type: "select",
    // "Unknown" closes the set, last for the same reason "Unassigned" is:
    // 208 of the 259 organisations have no derived country, so the named
    // codes between them reach under a fifth of the table.
    options: [
      ...Object.entries(COUNTRY_LABELS).map(([code, label]) => ({ value: code, label })),
      { value: UNKNOWN_COUNTRY, label: UNKNOWN_LABEL },
    ],
  },
  {
    key: "followers",
    label: "Followers",
    type: "select",
    // Likewise: 51 organisations have no follower count on their primary
    // contact and match no band, so "Unknown" is the only way to see them.
    options: [
      ...Object.entries(FOLLOWER_BANDS).map(([value, band]) => ({ value, label: band.label })),
      { value: UNKNOWN_FOLLOWERS, label: UNKNOWN_LABEL },
    ],
  },
  {
    key: "email",
    label: "Email",
    type: "select",
    options: [{ value: "1", label: "Has email on file" }],
  },
];

/**
 * Read the filters out of the URL.
 *
 * A query string is untrusted input, so every filter follows the same
 * contract `readQueueFilters` (`crm/page.tsx`) established: an unrecognised
 * value — a `followers` band that isn't one of `FOLLOWER_BANDS`, a `product`
 * the estate doesn't declare and isn't `UNASSIGNED_PRODUCT`, a `country` not
 * in `COUNTRY_LABELS` — is treated as no filter at all, never forwarded to
 * SQL and never reported as an error. `q` maps to `OrganisationFilter.search`.
 * `import` maps to `OrganisationFilter.importId` — an import's result page
 * links here as `/platform/crm/organisations?import=<uuid>`, and without
 * honouring that param the link would land on the unfiltered list showing
 * every organisation, not just the batch the operator just imported.
 * `email=1` is the only recognised value for the boolean `hasEmail` filter;
 * anything else (including absence) leaves it unset.
 */
export function readOrganisationFilters(searchParams: OrganisationsSearchParams): OrganisationFilter {
  const filters: OrganisationFilter = {};

  const rawSearch = searchParams.q;
  if (typeof rawSearch === "string" && rawSearch !== "") {
    filters.search = rawSearch;
  }

  const rawImportId = searchParams.import;
  if (typeof rawImportId === "string" && rawImportId !== "") {
    filters.importId = rawImportId;
  }

  const rawProduct = searchParams.product;
  if (typeof rawProduct === "string" && rawProduct !== "") {
    // The sentinel is checked first, or it would fail the ESTATE check below
    // and round-trip through the URL as if it were an unrecognised value —
    // same ordering `readQueueFilters` uses.
    if (rawProduct === UNASSIGNED_PRODUCT || ESTATE.some((product) => product.context === rawProduct)) {
      filters.product = rawProduct;
    }
  }

  const rawCountry = searchParams.country;
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so
  // `?country=__proto__` (or `constructor`, `toString`) passed as a
  // recognised code and reached the repo's exact-match clause. Same guard
  // `isFollowerFilter` uses. The unknown sentinel names no country, so it is
  // admitted explicitly ahead of that check — otherwise picking "Unknown"
  // reads as an unrecognised code and silently unfilters the surface.
  if (
    typeof rawCountry === "string" &&
    (rawCountry === UNKNOWN_COUNTRY || Object.hasOwn(COUNTRY_LABELS, rawCountry))
  ) {
    filters.country = rawCountry;
  }

  const rawFollowers = searchParams.followers;
  if (typeof rawFollowers === "string" && isFollowerFilter(rawFollowers)) {
    filters.followers = rawFollowers;
  }

  if (searchParams.email === "1") {
    filters.hasEmail = true;
  }

  return filters;
}

/**
 * The direction each sortable column takes when the URL names no `?dir=`.
 *
 * Per column rather than one shared default because the columns are read
 * differently: a name reads A–Z, while a follower count and a creation date
 * are asked for biggest-first and newest-first. A single default would be
 * wrong for one of them.
 *
 * The KEYS are this page's copy of the repo's allow-list, and `satisfies`
 * keeps the copy honest: `Record<OrganisationSortKey, …>` fails to compile if
 * `ORGANISATION_SORTS` gains a column this record has not given a default, or
 * if this record names one the repo does not have. It is a type-only link, so
 * nothing here imports the repo's SQL at runtime — deliberately, since the
 * value it maps each key to is an ORDER BY expression and only the repo has
 * any business splicing that into a statement.
 */
const SORT_DIRECTION_DEFAULTS = {
  name: "asc",
  followers: "desc",
  created: "desc",
} satisfies Record<OrganisationSortKey, SortDirection>;

/**
 * The largest `?page=` this surface honours.
 *
 * `readPage` already turns nonsense into page 1, but it accepts any positive
 * integer, and `?page=999999999999999999999999` parses to 1e24 — which the
 * repo multiplies by the page size and passes as a query parameter, where
 * `String(1e26)` is the exponent form `"1e+26"` rather than an integer
 * literal. A page far past the end can only ever render empty, so refusing to
 * ask for one costs an operator nothing they could have wanted. 10,000 pages
 * is a million rows, against 259 today.
 */
const MAX_PAGE = 10_000;

/**
 * Read the ordering out of the URL.
 *
 * Same contract as `readOrganisationFilters` above and as `readQueueFilters`
 * (`crm/page.tsx`): a `?sort=` this surface does not offer reads as UNSORTED
 * — the default `created_at DESC` list — and is never forwarded. That is a
 * deliberate degradation of a hand-edited URL, not a swallowed error: the repo
 * throws `UnknownSortKeyError` on a key it cannot serve, which is the right
 * answer for a link-builder with a bug and the wrong one for an operator who
 * mistyped a query string, so this page is expected to be the first line and
 * the throw the backstop. A key that got past here would be a bug in this
 * function, and the repo would still refuse it rather than reorder silently.
 *
 * `Object.hasOwn`, never `in`: `in` walks the prototype chain, so
 * `?sort=__proto__` (or `constructor`, `toString`) would read as a recognised
 * column — the same defect `?country=__proto__` had, except that the value a
 * sort key resolves to is spliced into an `ORDER BY`.
 *
 * An unrecognised `?dir=` keeps the sort and falls back to the column's
 * default: the key is valid and only the direction is junk, so dropping the
 * sort as well would answer a typo by reordering the whole table.
 */
export function readOrganisationSort(searchParams: OrganisationsSearchParams): OrganisationSort | null {
  const rawSort = searchParams.sort;
  if (typeof rawSort !== "string" || !Object.hasOwn(SORT_DIRECTION_DEFAULTS, rawSort)) {
    return null;
  }
  const key = rawSort as OrganisationSortKey;

  const rawDirection = searchParams.dir;
  const direction: SortDirection =
    rawDirection === "asc" || rawDirection === "desc"
      ? rawDirection
      : SORT_DIRECTION_DEFAULTS[key];

  return { key, direction };
}

/** The applied filters as the bar's display values — same shape as
 *  `toFilterValues` in `crm/page.tsx`. */
export function toOrganisationFilterValues(filters: OrganisationFilter): FilterValues {
  const values: FilterValues = {};
  if (filters.search) values.q = filters.search;
  if (filters.product) values.product = filters.product;
  if (filters.country) values.country = filters.country;
  if (filters.followers) values.followers = filters.followers;
  if (filters.hasEmail) values.email = "1";
  return values;
}

const BASE_PATH = "/platform/crm/organisations";

/**
 * Builds a `?cursor=` link by copying every param already on the URL and
 * replacing only `cursor` — never by naming the params this page currently
 * knows about. This surface has five filter params (`q`, `product`,
 * `country`, `followers`, `email`) on top of `import`; a builder that
 * enumerated known params would silently drop whichever ones it forgot the
 * moment an operator pages, landing them on an unfiltered (or differently
 * filtered) page 2.
 *
 * One builder serves both controls because the cursor itself carries the
 * direction it points in (see `lib/db/keyset-cursor.ts`). A `?direction=`
 * beside it would be one copy-paste away from being lost, and a link whose
 * direction went missing renders the wrong page in silence.
 */
function buildCursorHref(searchParams: OrganisationsSearchParams, cursor: string | null): string | null {
  if (!cursor) return null;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "cursor") continue;
    if (typeof value === "string") {
      params.set(key, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) params.append(key, entry);
    }
  }
  params.set("cursor", cursor);

  return `${BASE_PATH}?${params.toString()}`;
}

/** The next page's link, or null when this is the last page. */
export function buildNextHref(searchParams: OrganisationsSearchParams, nextCursor: string | null): string | null {
  return buildCursorHref(searchParams, nextCursor);
}

/** The previous page's link, or null on the first page. Named rather than
 *  folded into one call site so a reader can see which control a link
 *  belongs to without decoding the cursor it carries. */
export function buildPreviousHref(
  searchParams: OrganisationsSearchParams,
  previousCursor: string | null,
): string | null {
  return buildCursorHref(searchParams, previousCursor);
}

/**
 * The URL's params with any `?cursor=` removed, for the sorted pager to build
 * `?page=` links from.
 *
 * This changes no query, because this page never sends a cursor under a sort:
 * `ListOrganisationsOptions` is a union whose sorted branch types `cursor` as
 * `undefined`, so the pair does not compile. Not because the repo would
 * discard one — `listOrganisations` decodes `options.cursor` and pushes its
 * keyset predicate whenever it is present, sort or no sort, so a call
 * carrying both would filter by `(created_at, id)` while ordering and
 * offsetting by something else. The union is what makes that unreachable.
 *
 * What this does change is the link: `pageHref` copies every param it does
 * not own, so a cursor left over from the unsorted view would ride along to
 * page 2 and out to whoever the link is shared with — where clearing the sort
 * would page them from a position they never chose. `page` needs no such
 * handling; `pageHref` owns it and replaces it.
 */
function withoutCursor(searchParams: OrganisationsSearchParams): OrganisationsSearchParams {
  const { cursor: _cursor, ...rest } = searchParams;
  return rest;
}

export interface OrganisationsStateInput {
  error: unknown;
  rows: readonly OrganisationListRow[];
  filtered: boolean;
}

export function organisationsState(input: OrganisationsStateInput): SurfaceState {
  return resolveState({
    isLoading: false,
    error: dbReadError(input.error, "organisations"),
    rows: input.rows,
    filtered: input.filtered,
  });
}

export default async function OrganisationsPage({
  searchParams,
}: {
  searchParams: Promise<OrganisationsSearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const filters = readOrganisationFilters(resolvedSearchParams);
  // Every active filter counts toward `filtered`, not just `search`: an
  // empty result under any one of them must resolve to `filtered-empty`
  // ("nothing matches what you asked for"), not the plain `empty` state
  // ("no organisations exist at all") — the two read very differently to an
  // operator who just narrowed the list, and only one has a way out
  // (`onClearFilters`).
  const filtered =
    Boolean(filters.search) ||
    Boolean(filters.importId) ||
    Boolean(filters.product) ||
    Boolean(filters.country) ||
    Boolean(filters.followers) ||
    Boolean(filters.hasEmail);

  const sort = readOrganisationSort(resolvedSearchParams);
  // Clamped rather than trusted — see MAX_PAGE. Read only under a sort: the
  // unsorted list has no offset to apply a `?page=` to, and honouring one
  // there would look like paging while changing nothing.
  const pageNumber = sort ? Math.min(readPage(resolvedSearchParams), MAX_PAGE) : 1;

  const rawCursor = resolvedSearchParams.cursor;
  const cursor = typeof rawCursor === "string" && rawCursor !== "" ? rawCursor : undefined;

  // A sort DROPS the cursor rather than carrying it: a keyset position names a
  // place in `(created_at, id)` order, which is not the order a sorted page is
  // in, so applying it would skip rows the URL asked to see.
  // `ListOrganisationsOptions` is a union so this is the only shape that
  // compiles — the two positions cannot both be asked for.
  const options: ListOrganisationsOptions = sort ? { sort, page: pageNumber } : { cursor };

  let rows: readonly OrganisationListRow[] = [];
  let total = 0;
  let precedingCount = 0;
  let nextHref: string | null = null;
  let previousHref: string | null = null;
  let error: unknown = null;
  try {
    const page = await listOrganisations(filters, PAGE_SIZE, options);
    rows = page.rows;
    total = page.total;
    // From the repo either way: under a sort it is the offset capped at
    // `total`, so a `?page=` past the end still states a range inside the
    // result set. `pagerLinks` computes its own, uncapped, and only its two
    // links are taken below.
    precedingCount = page.precedingCount;
    if (sort) {
      const links = pagerLinks(
        BASE_PATH,
        withoutCursor(resolvedSearchParams),
        pageNumber,
        page.rows.length,
        page.total,
        // This surface's own page size, not `ENTITIES_LIMIT`: at the default,
        // page 3 of 259 rows counts 100 ahead instead of 200 and offers a
        // Next to an empty page.
        PAGE_SIZE,
      );
      nextHref = links.nextHref;
      previousHref = links.previousHref;
    } else {
      nextHref = buildNextHref(resolvedSearchParams, page.nextCursor);
      previousHref = buildPreviousHref(resolvedSearchParams, page.previousCursor);
    }
  } catch (caught) {
    error = caught;
  }

  const state = organisationsState({ error, rows, filtered });

  return (
    <div className="flex flex-col gap-6">
      <ConsolePageHeader
        title="Organisations"
        description="Every business the CRM knows about, searchable by name, contact, or handle."
        breadcrumbs={[{ label: "CRM", href: "/platform/crm" }, { label: "Organisations" }]}
      />

      <OrganisationsView
        rows={rows}
        state={state}
        emptyMessage={EMPTY_MESSAGE}
        descriptors={ORGANISATION_FILTERS}
        values={toOrganisationFilterValues(filters)}
        total={total}
        precedingCount={precedingCount}
        nextHref={nextHref}
        previousHref={previousHref}
        sort={sort}
      />
    </div>
  );
}
