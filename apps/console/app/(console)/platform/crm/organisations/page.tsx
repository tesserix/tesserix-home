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
 * How many rows this surface renders. `listOrganisations` now returns a
 * total and a keyset cursor (Task 1), but the pager UI that would let an
 * operator actually reach page 2 is a later task — DELIBERATELY DEFERRED,
 * not built here.
 *
 * What is not deferrable is the silence. Until this branch, a 300-row import
 * linked here and showed 100 rows with nothing to say the other 200 existed,
 * and this page is the only way to reach a lead in its first fourteen days.
 * So this page still shows only the first page, but now names the true total
 * via `OrganisationsView`'s truncation notice instead of over-fetching by one
 * row to detect it.
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

  let rows: readonly OrganisationListRow[] = [];
  let truncated = false;
  let error: unknown = null;
  try {
    const page = await listOrganisations(filters, PAGE_SIZE);
    rows = page.rows;
    // The true total, not an over-fetched extra row: this is what makes
    // "there are exactly 100" distinguishable from "there are 300" without
    // asking for one row more than will ever be shown.
    truncated = page.total > PAGE_SIZE;
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
        truncated={truncated}
        pageSize={PAGE_SIZE}
      />
    </div>
  );
}
