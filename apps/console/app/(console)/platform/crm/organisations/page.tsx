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
 * Read the filters out of the URL.
 *
 * `q` maps to `OrganisationFilter.search`. `import` maps to
 * `OrganisationFilter.importId` — an import's result page links here as
 * `/platform/crm/organisations?import=<uuid>`, and without honouring that
 * param the link would land on the unfiltered list showing every
 * organisation, not just the batch the operator just imported.
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

  return filters;
}

const BASE_PATH = "/platform/crm/organisations";

/**
 * Builds the `?cursor=` link for the next page by copying every param
 * already on the URL and replacing only `cursor` — never by naming the
 * params this page currently knows about. A later task adds four more
 * filter params (`product`, `country`, `followers`, `email`); a builder
 * that enumerated known params would silently drop them the moment an
 * operator pages, landing them on an unfiltered page 2.
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
  // Counts `importId` toward `filtered`, not just `search`: an empty result
  // under `?import=` must resolve to `filtered-empty` ("this batch has
  // nothing"), not the plain `empty` state ("no organisations exist at
  // all") — the two read very differently to an operator following an
  // import's result link.
  const filtered = Boolean(filters.search) || Boolean(filters.importId);

  const rawCursor = resolvedSearchParams.cursor;
  const cursor = typeof rawCursor === "string" && rawCursor !== "" ? rawCursor : undefined;

  let rows: readonly OrganisationListRow[] = [];
  let total = 0;
  let nextHref: string | null = null;
  let error: unknown = null;
  try {
    // Omitted (not `undefined`) when there is no cursor: existing tests
    // assert `listOrganisations` was called with exactly two arguments on
    // the first page, and an explicit `undefined` third argument fails that
    // equality check.
    const page = cursor
      ? await listOrganisations(filters, PAGE_SIZE, cursor)
      : await listOrganisations(filters, PAGE_SIZE);
    rows = page.rows;
    total = page.total;
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
        search={filters.search ?? ""}
        total={total}
        nextHref={nextHref}
      />
    </div>
  );
}
