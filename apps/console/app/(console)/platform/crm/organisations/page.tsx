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
 * How many rows this surface renders. Real pagination — offset/cursor, a
 * total, page controls — is the actual fix and is DELIBERATELY DEFERRED: it
 * needs a count query and a paging contract `listOrganisations` does not have
 * (`crm-repo.ts` issues a bare `LIMIT` with no offset and no total).
 *
 * What is not deferrable is the silence. Until this branch, a 300-row import
 * linked here and showed 100 rows with nothing to say the other 200 existed,
 * and this page is the only way to reach a lead in its first fourteen days.
 * So the page over-fetches by one row and tells the operator when the extra
 * row came back — see `OrganisationsView`'s truncation notice.
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

  // `PAGE_SIZE + 1`, not `PAGE_SIZE`: the extra row is never rendered, it is
  // only the evidence that a further row exists. Asking for exactly
  // `PAGE_SIZE` cannot tell "there are exactly 100" from "there are 300" —
  // which is how the truncation went unannounced.
  let fetched: OrganisationListRow[] = [];
  let error: unknown = null;
  try {
    fetched = await listOrganisations(filters, PAGE_SIZE + 1);
  } catch (caught) {
    error = caught;
  }

  const truncated = fetched.length > PAGE_SIZE;
  const rows = truncated ? fetched.slice(0, PAGE_SIZE) : fetched;

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
