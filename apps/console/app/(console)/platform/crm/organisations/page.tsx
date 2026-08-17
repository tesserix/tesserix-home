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
import { listOrganisations, type OrganisationFilter, type OrganisationListRow } from "@/lib/db/crm-repo";
import { COUNTRY_LABELS } from "@/lib/db/crm-country";
import { FOLLOWER_BANDS, UNASSIGNED_PRODUCT, isFollowerBand } from "@/lib/db/crm-filters";
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
    options: Object.entries(COUNTRY_LABELS).map(([code, label]) => ({ value: code, label })),
  },
  {
    key: "followers",
    label: "Followers",
    type: "select",
    options: Object.entries(FOLLOWER_BANDS).map(([value, band]) => ({ value, label: band.label })),
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
  // `isFollowerBand` uses.
  if (typeof rawCountry === "string" && rawCountry !== "" && Object.hasOwn(COUNTRY_LABELS, rawCountry)) {
    filters.country = rawCountry;
  }

  const rawFollowers = searchParams.followers;
  if (typeof rawFollowers === "string" && isFollowerBand(rawFollowers)) {
    filters.followers = rawFollowers;
  }

  if (searchParams.email === "1") {
    filters.hasEmail = true;
  }

  return filters;
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
 * Builds the `?cursor=` link for the next page by copying every param
 * already on the URL and replacing only `cursor` — never by naming the
 * params this page currently knows about. This surface now has five filter
 * params (`q`, `product`, `country`, `followers`, `email`) on top of
 * `import`; a builder that enumerated known params would silently drop
 * whichever ones it forgot the moment an operator pages, landing them on an
 * unfiltered (or differently filtered) page 2.
 */
export function buildNextHref(searchParams: OrganisationsSearchParams, nextCursor: string | null): string | null {
  if (!nextCursor) return null;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "cursor") continue;
    if (typeof value === "string") {
      params.set(key, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) params.append(key, entry);
    }
  }
  params.set("cursor", nextCursor);

  return `${BASE_PATH}?${params.toString()}`;
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

  const rawCursor = resolvedSearchParams.cursor;
  const cursor = typeof rawCursor === "string" && rawCursor !== "" ? rawCursor : undefined;

  let rows: readonly OrganisationListRow[] = [];
  let total = 0;
  let precedingCount = 0;
  let nextHref: string | null = null;
  let error: unknown = null;
  try {
    const page = await listOrganisations(filters, PAGE_SIZE, cursor);
    rows = page.rows;
    total = page.total;
    precedingCount = page.precedingCount;
    nextHref = buildNextHref(resolvedSearchParams, page.nextCursor);
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
      />
    </div>
  );
}
