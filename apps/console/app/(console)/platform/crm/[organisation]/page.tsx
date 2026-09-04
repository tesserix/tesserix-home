import { notFound } from "next/navigation";
import { getCurrentSession, hasCapability } from "@tesserix/platform-auth";
import { ESTATE } from "@tesserix/console-core";
import { DetailLayout } from "@/components/kit/detail-layout";
// From `surface-state`, not `states`: this is a server component, and
// `states.tsx` is a "use client" module whose exports resolve to client
// references here. See tickets/[id]/page.tsx for the incident this guards
// against.
import { resolveState, type SurfaceState } from "@/components/kit/surface-state";
// Not `toSurfaceError` — see `@/lib/db-read-error`.
import { dbReadError } from "@/lib/db-read-error";
import { requiresCapability } from "@/lib/internal-access";
import { COUNTRY_LABELS } from "@/lib/db/crm-country";
import { organisationDetail, type OrganisationDetail } from "@/lib/db/crm-repo";
import { listTemplates, type TemplateRow } from "@/lib/db/crm-templates";
import {
  ActivityTab,
  ContactsTab,
  DeleteOrganisationButton,
  OpportunitiesTab,
} from "./organisation-detail-view";
import { OrganisationEditForm } from "./organisation-edit-form";

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
    error: dbReadError(input.error, "this organisation"),
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

  // Same gate as tickets/[id]/page.tsx's `canRespond`: a role-less session
  // under the pre-cutover `google` provider is treated as holding every
  // capability, so hard-delete controls behave the same as they always
  // have until the Zitadel cutover actually carries roles.
  const session = await getCurrentSession();
  const canHardDelete = !requiresCapability() || hasCapability(session?.roles, "hard-delete");

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

  // Live `dm` templates for the composer, read in its OWN try/catch rather
  // than alongside `organisationDetail` above.
  //
  // The split is deliberate: a template read that fails must not take the
  // organisation page down with it. Everything else on this page — the
  // timeline, the contacts, the deals, the edit form — is unaffected by
  // `crm_templates` being unreadable, and failing the whole surface for the
  // one composer would trade a working page for an outage. The failure the
  // console can actually be in here is 0043 not yet applied, and an operator
  // meeting an empty composer that points at the authoring surface will find
  // that surface refuses too. Logged so the cause is not silent.
  //
  // Not `channel` un-narrowed: this composer logs `dm_sent`, and
  // `recordTemplatedDm` refuses an email template server-side. Filtering here
  // is what stops the operator being offered one at all.
  let templates: TemplateRow[] = [];
  try {
    templates = await listTemplates({ channel: "dm" });
  } catch (caught) {
    console.error("[console] failed to read DM templates from tesserix-postgres", caught);
  }

  return (
    <DetailLayout
      title={organisation.name}
      breadcrumbs={[
        { label: "CRM", href: "/platform/crm" },
        { label: organisation.name },
      ]}
      actions={
        <div className="flex flex-wrap gap-2">
          {/* Editing is not gated on `hard-delete`: a correction to a name or
              a website is the ordinary CRM write, and `updateOrganisationAction`
              sits at `withCrmWrite`'s default capability alongside create. */}
          <OrganisationEditForm organisation={organisation} />
          {canHardDelete ? (
            <DeleteOrganisationButton
              organisationId={organisation.id}
              organisationName={organisation.name}
            />
          ) : null}
        </div>
      }
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
          label: "Country",
          // "Not derived", not the rail's "Not recorded" used above: this
          // column is computed from `location` by `countryFromLocation`, and
          // nobody ever fills it in. An absent value therefore says the
          // mapper has no entry for the recorded location — 208 of 259
          // production rows — which is a different fact from a field left
          // blank, and the operator has to be able to tell them apart.
          value: organisation.country
            ? (COUNTRY_LABELS[organisation.country] ?? organisation.country)
            : "Not derived",
        },
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
          // "No conversion recorded", not "Not converted". A null
          // `converted_at` covers three different situations — nobody has
          // asked the product yet, the check failed, and the product
          // answered no — and only the last of them is "not converted".
          // `handoff-view.tsx`'s SIGNAL_COPY goes to deliberate trouble to
          // keep `unknown` and `none` worded apart for exactly this reason;
          // stating the absence of a record, rather than a negative fact
          // about the merchant, is what makes this page agree with it.
          value: organisation.convertedAt
            ? `${organisation.convertedLabel ?? organisation.convertedProduct ?? "Yes"} · ${new Date(organisation.convertedAt).toLocaleDateString()}`
            : "No conversion recorded",
        },
        { label: "Added", value: new Date(organisation.createdAt).toLocaleString() },
      ]}
      tabs={[
        {
          id: "activity",
          label: "Activity",
          content: (
            <ActivityTab
              organisationId={organisation.id}
              activities={activities}
              opportunities={opportunities}
              contacts={contacts}
              templates={templates}
            />
          ),
        },
        {
          id: "contacts",
          label: "Contacts",
          content: (
            <ContactsTab
              organisationId={organisation.id}
              organisationName={organisation.name}
              contacts={contacts}
              canHardDelete={canHardDelete}
            />
          ),
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
