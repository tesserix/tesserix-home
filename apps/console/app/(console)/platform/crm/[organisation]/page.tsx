import { notFound } from "next/navigation";
import { ESTATE } from "@tesserix/console-core";
import { DetailLayout } from "@/components/kit/detail-layout";
// From `surface-state`, not `states`: this is a server component, and
// `states.tsx` is a "use client" module whose exports resolve to client
// references here. See tickets/[id]/page.tsx for the incident this guards
// against.
import { resolveState, toSurfaceError, type SurfaceState } from "@/components/kit/surface-state";
import { organisationDetail, type OrganisationDetail } from "@/lib/db/crm-repo";
import { ActivityTab, ContactsTab, OpportunitiesTab } from "./organisation-detail-view";

/**
 * One organisation: its identity facts in the summary rail, and its
 * activity, contacts and opportunities as tabs.
 *
 * `organisationDetail` returns `null` for a real "no such organisation" —
 * `notFound()` covers that before this renders anything. A thrown error
 * (database unreachable, etc.) is the other failure this surface can be in;
 * `detailState` distinguishes the two the same way the tickets detail page
 * does, so a real outage never quietly renders as "not found".
 */
export function detailState(input: {
  error: unknown;
  detail: OrganisationDetail | null;
}): SurfaceState {
  return resolveState({
    isLoading: false,
    error: toSurfaceError(input.error),
    rows: input.detail ? [input.detail] : [],
    filtered: false,
  });
}

// `crm_organisations.id` is a `uuid` column. Postgres rejects a non-UUID
// literal in a `WHERE id = $1` comparison with error 22P02
// ("invalid input syntax for type uuid") rather than simply matching no
// rows — so a mistyped or hand-edited path segment (`/platform/crm/nope`)
// would surface as the generic error state instead of the 404 it actually
// is. Validated at the route boundary, before the query ever runs, so the
// shape check — not a database error code — decides which of the two this
// is. Exported so the shape check itself is unit-testable without having to
// render the page and catch `notFound()`'s special-cased redirect.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidShaped(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export default async function OrganisationDetailPage({
  params,
}: {
  params: Promise<{ organisation: string }>;
}) {
  const { organisation: organisationId } = await params;

  if (!isUuidShaped(organisationId)) {
    notFound();
  }

  let detail: OrganisationDetail | null = null;
  let error: unknown = null;
  try {
    detail = await organisationDetail(organisationId);
  } catch (caught) {
    error = caught;
  }

  if (!detail && !error) {
    notFound();
  }

  const state: SurfaceState = detailState({ error, detail });

  if (!detail) {
    return (
      <DetailLayout
        title="Organisation"
        breadcrumbs={[
          { label: "CRM", href: "/platform/crm" },
          { label: "Organisation" },
        ]}
        summary={[]}
        tabs={[]}
        state={state}
      />
    );
  }

  const { organisation, contacts, opportunities, activities } = detail;
  const products = ESTATE.map((product) => ({ context: product.context, name: product.name }));

  return (
    <DetailLayout
      title={organisation.name}
      breadcrumbs={[
        { label: "CRM", href: "/platform/crm" },
        { label: organisation.name },
      ]}
      summary={[
        {
          label: "Website",
          value: organisation.websiteUrl ? (
            <a
              href={organisation.websiteUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {organisation.websiteUrl}
            </a>
          ) : (
            "Not recorded"
          ),
        },
        { label: "Location", value: organisation.location ?? "Not recorded" },
        {
          label: "Category",
          value: organisation.category.length > 0 ? organisation.category.join(", ") : "Not recorded",
        },
        {
          label: "Tags",
          value: organisation.tags.length > 0 ? organisation.tags.join(", ") : "None",
        },
        {
          label: "Converted",
          value: organisation.convertedAt
            ? `${organisation.convertedLabel ?? organisation.convertedProduct ?? "Yes"} · ${new Date(organisation.convertedAt).toLocaleDateString()}`
            : "Not converted",
        },
        { label: "Added", value: new Date(organisation.createdAt).toLocaleString() },
      ]}
      tabs={[
        {
          id: "activity",
          label: "Activity",
          content: <ActivityTab organisationId={organisation.id} activities={activities} />,
        },
        {
          id: "contacts",
          label: "Contacts",
          content: <ContactsTab contacts={contacts} />,
        },
        {
          id: "opportunities",
          label: "Opportunities",
          content: (
            <OpportunitiesTab
              organisationId={organisation.id}
              opportunities={opportunities}
              products={products}
            />
          ),
        },
      ]}
      state={state}
    />
  );
}
