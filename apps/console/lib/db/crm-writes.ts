import { tesserixQuery, tesserixTx, type TxQuery } from "./tesserix";

/**
 * Manual create for the CRM: the only door into `crm_organisations` /
 * `crm_contacts` / `crm_opportunities` besides `commitImport` (crm-repo.ts).
 * A lead phoned in, or a lapsed organisation returning with a new deal
 * (the design's third motivating case — see `createOpportunity` below), has
 * no CSV row to import through; these three functions are that door.
 *
 * Kept in its own file rather than folded into crm-repo.ts, which is already
 * past 1,500 lines.
 */

export interface CreateOrganisationInput {
  name: string;
  location?: string;
  websiteUrl?: string;
  /** Optional first contact, created in the same transaction. */
  contact?: { name?: string; email?: string; instagramHandle?: string };
  /** Optional first opportunity. Omit to create a bare organisation. */
  opportunity?: { product?: string; owner?: string };
}

export interface CreateContactInput {
  organisationId: string;
  name?: string;
  email?: string;
  phone?: string;
  instagramHandle?: string;
  isPrimary?: boolean;
}

export interface CreateOpportunityInput {
  organisationId: string;
  product?: string;
  owner?: string;
}

/**
 * Create an organisation, and optionally its first contact and first
 * opportunity, in one transaction.
 *
 * All three inserts run inside `tesserixTx` so a contact that collides with
 * `crm_contacts_email_lower_uq` (case-insensitive) rolls the organisation
 * back too — otherwise a failed create would still leave behind an
 * organisation with no contact and no way to tell why.
 *
 * `name` is trimmed and rejected blank before touching the database: the
 * column is NOT NULL but accepts `""`, and an unnamed organisation is
 * unfindable in a surface whose only affordance is search.
 *
 * The contact created alongside a new organisation is marked
 * `is_primary = true` — `listOrganisations`' "primary first, created_at
 * second" ordering has nothing to prefer otherwise, and the detail view
 * would show no lead contact.
 *
 * No `crm_activities` row is written here. Creating an opportunity is not a
 * stage transition — `stage` is left at its `'new'` column default rather
 * than passed explicitly — and `stage_change` activities are the only
 * record of when a stage was entered, the input to funnel measurement.
 * Writing one here would fabricate a transition into `new` that never
 * happened.
 */
export async function createOrganisation(
  input: CreateOrganisationInput,
): Promise<{ organisationId: string }> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("createOrganisation: name is required");
  }

  return tesserixTx(async (query) => {
    const organisationId = await insertOrganisation(query, name, input);

    if (input.contact) {
      await insertContact(query, {
        organisationId,
        name: input.contact.name,
        email: input.contact.email,
        instagramHandle: input.contact.instagramHandle,
        isPrimary: true,
      });
    }

    if (input.opportunity) {
      await insertOpportunity(query, {
        organisationId,
        product: input.opportunity.product,
        owner: input.opportunity.owner,
      });
    }

    return { organisationId };
  });
}

async function insertOrganisation(
  query: TxQuery,
  name: string,
  input: CreateOrganisationInput,
): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO crm_organisations (name, location, website_url)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [name, input.location?.trim() || null, input.websiteUrl?.trim() || null],
  );
  return rows[0].id;
}

/**
 * Create a contact against an existing organisation, outside any
 * organisation-level transaction — a single INSERT needs no transaction of
 * its own, and `tesserixQuery`'s pooled connection is exactly what a lone
 * statement wants.
 */
export async function createContact(input: CreateContactInput): Promise<{ contactId: string }> {
  const contactId = await insertContact(tesserixQuery, input);
  return { contactId };
}

async function insertContact(
  query: TxQuery,
  input: CreateContactInput,
): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO crm_contacts (organisation_id, name, email, phone, instagram_handle, is_primary)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      input.organisationId,
      input.name?.trim() || null,
      input.email ? input.email.trim().toLowerCase() : null,
      input.phone?.trim() || null,
      input.instagramHandle?.trim() || null,
      input.isPrimary ?? false,
    ],
  );
  return rows[0].id;
}

/**
 * Create a new opportunity against an existing organisation.
 *
 * The design's third motivating case: a business lost in March that returns
 * in November is a NEW opportunity against the same organisation, not a
 * resurrection of the old row — this is what makes that possible. `stage`
 * is left at its `'new'` default, and `product` is passed through exactly
 * as given: never invented when the caller omits it. A null product at
 * stage `new` is legal under `crm_opp_product_required_when_qualified`, and
 * inventing one would fabricate attribution the funnel later reports as
 * fact.
 */
export async function createOpportunity(
  input: CreateOpportunityInput,
): Promise<{ opportunityId: string }> {
  const opportunityId = await insertOpportunity(tesserixQuery, input);
  return { opportunityId };
}

async function insertOpportunity(
  query: TxQuery,
  input: CreateOpportunityInput,
): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO crm_opportunities (organisation_id, product, owner)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [input.organisationId, input.product?.trim() || null, input.owner?.trim() || null],
  );
  return rows[0].id;
}
