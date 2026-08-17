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

export default async function OrganisationDetailPage({
  params,
}: {
  params: Promise<{ organisation: string }>;
}) {
  const { organisation: organisationId } = await params;

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
