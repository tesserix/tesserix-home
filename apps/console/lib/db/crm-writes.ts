import { tesserixQuery, tesserixTx, type TxQuery } from "./tesserix";
import { isSafeWebsiteUrl } from "./crm-url";
import { isSuppressed, SuppressedContactError } from "./crm-repo";

/**
 * Manual create for the CRM: the only door into `crm_organisations` /
 * `crm_contacts` / `crm_opportunities` besides `commitImport` (crm-repo.ts).
 * A lead phoned in, or a lapsed organisation returning with a new deal
 * (the design's third motivating case — see `createOpportunity` below), has
 * no CSV row to import through; these three functions are that door.
 *
 * Kept in its own file rather than folded into crm-repo.ts, which is already
 * past 1,500 lines.
 *
 * Two guarantees live at THIS layer rather than in the actions above it,
 * because an exported function is reachable by any future caller and a
 * guarantee that depends on callers remembering is not a guarantee:
 *
 * - Website URLs are scheme-checked (`isSafeWebsiteUrl`). The action layer
 *   checks too, and should: it turns the refusal into a field-level message.
 * - The do-not-contact list is honoured (`isSuppressed`). `commitImport`
 *   already checks per row, but a person who asked not to be contacted could
 *   be re-added by hand through either function below. Suppression has to
 *   survive a manual add for the same reason design.md:224 requires it to
 *   survive the next import.
 */

/**
 * The suppression refusal for a manual create. Names the fact — this contact
 * is on the do-not-contact list — and the remedy, without echoing back which
 * key matched: the operator supplied both, and the list's contents are not
 * this message's to disclose.
 */
const SUPPRESSED_ON_CREATE_MESSAGE =
  "That contact is on the do-not-contact list. Remove the suppression before adding them.";

/**
 * Refuse the write if either identifying key is suppressed.
 *
 * Runs on the caller's own `query` — the transaction's scoped client, not a
 * second pooled connection — for Ruling 23's reason: the check and the insert
 * must not straddle a concurrent suppression being added, and the pool is
 * `max: 2`.
 */
async function assertNotSuppressed(
  query: TxQuery,
  keys: { email?: string; instagramHandle?: string },
): Promise<void> {
  if (await isSuppressed(keys, query)) {
    throw new SuppressedContactError(undefined, SUPPRESSED_ON_CREATE_MESSAGE);
  }
}

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

  // The scheme check belongs here, not only in the action that happens to
  // call this today: `crm_organisations.website_url` is rendered back as a
  // clickable `<a href target="_blank">`, and an exported writer that trusts
  // its caller to have checked is exactly how `javascript:` gets back in.
  // The action layer keeps its own check because it produces the field-level
  // message; this one is the one that cannot be skipped.
  const websiteUrl = input.websiteUrl?.trim();
  if (websiteUrl && !isSafeWebsiteUrl(websiteUrl)) {
    throw new Error("createOrganisation: websiteUrl must be an http(s) address");
  }

  return tesserixTx(async (query) => {
    if (input.contact) {
      await assertNotSuppressed(query, {
        email: input.contact.email,
        instagramHandle: input.contact.instagramHandle,
      });
    }

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
 * Create a contact against an existing organisation.
 *
 * Transactional despite being a single INSERT: the suppression check and the
 * insert have to see the same client, or a suppression added between them is
 * simply missed — the same reasoning `logActivity` applies to outreach.
 */
export async function createContact(input: CreateContactInput): Promise<{ contactId: string }> {
  return tesserixTx(async (query) => {
    await assertNotSuppressed(query, {
      email: input.email,
      instagramHandle: input.instagramHandle,
    });
    const contactId = await insertContact(query, input);
    return { contactId };
  });
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
