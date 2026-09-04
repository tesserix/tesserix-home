"use server";

import { revalidatePath } from "next/cache";
import { ESTATE } from "@tesserix/console-core";
import { createOrganisation, DuplicateContactError } from "@/lib/db/crm-writes";
// One definition, three comparers — see `crm-filters.ts`. A `"use server"`
// file may only export async functions, which is why this module imports the
// sentinel rather than owning it.
import { NO_PRODUCT_VALUE } from "@/lib/db/crm-filters";
import {
  LAWFUL_BASIS_REQUIRED_MESSAGE,
  isSelectableLawfulBasis,
  unknownLawfulBasisMessage,
} from "@/lib/crm-provenance";
import { isSafeWebsiteUrl, UNSAFE_WEBSITE_URL_MESSAGE } from "@/lib/db/crm-url";
import { SuppressedContactError } from "@/lib/db/crm-repo";
import { withCrmWrite, type CrmActionResult } from "@/lib/crm-write";


/**
 * The manual-create door into the CRM (#213): a lead phoned in has no CSV
 * row to import through. One action, `createOrganisationAction`, covers the
 * whole form — organisation plus an optional first contact and first
 * opportunity — because `createOrganisation` (crm-writes.ts) already does
 * all three in one transaction; splitting this into three actions would
 * just re-implement that rollback guarantee at the wrong layer.
 */

// Same reasoning as `[organisation]/actions.ts`'s ESTATE_CONTEXTS: `product`
// is a plain `text` column with no CHECK, so a typo written here is what the
// funnel later reports attribution by. Validated at this boundary, before
// `createOrganisation` ever runs.
const ESTATE_CONTEXTS: ReadonlySet<string> = new Set(ESTATE.map((p) => p.context));

function isEstateProduct(value: string): boolean {
  return ESTATE_CONTEXTS.has(value);
}

function unknownProductMessage(value: string): string {
  return `"${value}" is not a product in the estate.`;
}

function mapSuppressedContact(cause: unknown): { ok: false; message: string } | undefined {
  if (cause instanceof SuppressedContactError) {
    return { ok: false, message: cause.message };
  }
  return undefined;
}

/**
 * The second allowlisted exception on the manual-create path.
 *
 * A `23505` on `crm_contacts_email_lower_uq` or
 * `crm_contacts_instagram_lower_uq` is an operator-facing fact with a clear
 * next step — that contact is already in the CRM — not a caught database
 * error. `createContact`/`createOrganisation` raise it typed
 * (`DuplicateContactError`, crm-writes.ts) precisely so this mapper can pass
 * the message through without inspecting a database error string here. The
 * import path resolves the same condition informatively as `matchedExisting`
 * (crm-repo.ts); the manual door was where it degraded to the generic
 * "That change was not saved."
 */
function mapDuplicateContact(cause: unknown): { ok: false; message: string } | undefined {
  if (cause instanceof DuplicateContactError) {
    return { ok: false, message: cause.message };
  }
  return undefined;
}

/** Both refusals a hand-typed contact can produce, in one allowlist. */
function mapContactRefusal(cause: unknown): { ok: false; message: string } | undefined {
  return mapSuppressedContact(cause) ?? mapDuplicateContact(cause);
}

// Generic: strips whitespace and empty-string, nothing else. The
// `NO_PRODUCT_VALUE` sentinel is meaningful only to the product field, so it
// is stripped there (`productField` below), not here — folding it into this
// reader would silently reject a real organisation literally named
// "__none__" and silently drop a `location` typed the same way.
function optionalField(formData: FormData, key: string): string | undefined {
  const raw = formData.get(key);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function productField(formData: FormData): string | undefined {
  const value = optionalField(formData, "product");
  return value === NO_PRODUCT_VALUE ? undefined : value;
}

/**
 * Parses and validates the raw `FormData` before any session or database
 * work — an invalid form is not an audited event, so this returns an
 * operator-facing message directly rather than entering `withCrmWrite`.
 * `name` mirrors `createOrganisation`'s own rejection (empty-but-not-null is
 * a legal `text NOT NULL` value the database won't catch), checked here too
 * so the operator sees it before a round trip.
 */
export async function createOrganisationAction(formData: FormData): Promise<CrmActionResult> {
  const name = optionalField(formData, "name");
  if (!name) {
    return { ok: false, message: "Enter an organisation name." };
  }

  const location = optionalField(formData, "location");
  const websiteUrl = optionalField(formData, "websiteUrl");
  const contactName = optionalField(formData, "contactName");
  const contactEmail = optionalField(formData, "contactEmail");
  const contactInstagramHandle = optionalField(formData, "contactInstagramHandle");
  const product = productField(formData);
  const owner = optionalField(formData, "owner");

  if (product && !isEstateProduct(product)) {
    return { ok: false, message: unknownProductMessage(product) };
  }

  // `crm_organisations.website_url` is a plain `text` with no CHECK, and the
  // stored value is rendered back as a clickable `<a href target="_blank">`
  // on the organisation detail page — `type="url"` on the form input is a
  // browser-side hint only, and this server action is directly invocable.
  // Rejected before `withCrmWrite`, same as every other validation failure
  // here: an invalid form is not an audited event.
  if (websiteUrl && !isSafeWebsiteUrl(websiteUrl)) {
    return { ok: false, message: UNSAFE_WEBSITE_URL_MESSAGE };
  }

  const hasContact = Boolean(contactName || contactEmail || contactInstagramHandle);

  // #248. Required WHEN a contact is being created, and never defaulted: a
  // contact typed in by an operator has a different basis from a scraped
  // profile, and silently choosing one for them is precisely how these
  // columns became decorative. Checked before `withCrmWrite` like every
  // other validation here — an invalid form is not an audited event.
  const contactLawfulBasis = optionalField(formData, "contactLawfulBasis");
  if (hasContact) {
    if (!contactLawfulBasis) {
      return { ok: false, message: LAWFUL_BASIS_REQUIRED_MESSAGE };
    }
    if (!isSelectableLawfulBasis(contactLawfulBasis)) {
      return { ok: false, message: unknownLawfulBasisMessage(contactLawfulBasis) };
    }
  }

  const hasOpportunity = Boolean(product || owner);

  const result = await withCrmWrite(
    // Fallback target: the name is known before the write runs. `describe`
    // below overrides it with the id once one exists — same pattern as
    // `linkConversion` in `[organisation]/actions.ts`.
    name,
    { capability: "crm" },
    () =>
      createOrganisation({
        name,
        location,
        websiteUrl,
        contact:
          hasContact && isSelectableLawfulBasis(contactLawfulBasis)
            ? {
                name: contactName,
                email: contactEmail,
                instagramHandle: contactInstagramHandle,
                lawfulBasis: contactLawfulBasis,
              }
            : undefined,
        opportunity: hasOpportunity ? { product, owner } : undefined,
      }),
    (outcome) => ({
      action: "crm.organisation.create",
      summary: { organisations: 1 },
      // The id alongside the name, not the name alone (Ruling 20-style): a
      // display name is neither unique nor stable.
      target: `${name} (${outcome.organisationId})`,
    }),
    // `createOrganisation` refuses a suppressed first contact, and refuses
    // one whose email or handle is already taken, at the data layer
    // (crm-writes.ts). Both allowlisted here, same discipline as the
    // `[organisation]/actions.ts` mappers: they are operator-facing facts
    // with a clear next step, not caught database errors.
    mapContactRefusal);
  if (!result.ok) return result;
  revalidatePath("/platform/crm/organisations");
  return { ok: true };
}
