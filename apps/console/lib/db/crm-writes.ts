import { countryFromLocation } from "@tesserix/crm-country";
import {
  CONTACT_SOURCE,
  isSelectableLawfulBasis,
  type ContactSource,
  type LawfulBasis,
} from "../crm-provenance";
import { tesserixQuery, tesserixTx, type TxQuery } from "./tesserix";
import { isSafeWebsiteUrl } from "./crm-url";
import { isSuppressed, normalizeInstagramHandle, SuppressedContactError } from "./crm-repo";

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
 * second pooled connection. Of Ruling 23's two reasons for that, only the
 * second applies here: neither caller has written a suppression this
 * transaction could need to see, but both are holding a client already, and
 * a check on its own connection would take the other half of a `max: 2`
 * pool for the length of the write.
 *
 * What the shared client does NOT do is close the window between this check
 * and the INSERT that follows. Under READ COMMITTED a suppression committed
 * after this SELECT is invisible to the rest of the transaction, so a
 * suppression added mid-write is still missed. Closing it would take
 * SERIALIZABLE, a `FOR SHARE` lock on the matching suppression rows, or a
 * database constraint — and no unique index can be that constraint, because
 * the condition spans two tables (`crm_contacts` against
 * `crm_suppressions`) and an index only sees one. The window is left open
 * knowingly: it is narrow, and its outcome is a single contact row an
 * operator can erase, not a lost suppression.
 */
async function assertNotSuppressed(
  query: TxQuery,
  keys: { email?: string; instagramHandle?: string },
): Promise<void> {
  if (await isSuppressed(keys, query)) {
    throw new SuppressedContactError(undefined, SUPPRESSED_ON_CREATE_MESSAGE);
  }
}

/**
 * Which identifying key an operator has already used. Not free text: the
 * message an operator reads is chosen from this, and the action layer has no
 * business re-deriving it from a database error string.
 */
export type DuplicateContactKey = "email" | "instagramHandle";

/**
 * Thrown when one of the two contact-identity indexes refuses the insert.
 *
 * Same shape and same job as `SuppressedContactError` (crm-repo.ts): an
 * allowlisted, operator-facing exception rather than a generic failure.
 * Without it a `23505` reaches the operator as `withCrmWrite`'s "That change
 * was not saved.", which reads as a transport fault and invites a retry that
 * can never succeed. The import path already resolves the same condition
 * informatively — `findMatchingOrganisationId` feeding `matchedExisting`
 * (crm-repo.ts) — so the manual door was the one place this fact was lost.
 *
 * The message names the key and stops there. Which organisation holds the
 * existing contact is another business's record, and this refusal is not the
 * place to disclose it.
 */
const DUPLICATE_CONTACT_MESSAGES: Readonly<Record<DuplicateContactKey, string>> = {
  email:
    "A contact with that email address is already in the CRM. Search for it rather than adding a second one.",
  instagramHandle:
    "A contact with that Instagram handle is already in the CRM. Search for it rather than adding a second one.",
};

export class DuplicateContactError extends Error {
  constructor(readonly key: DuplicateContactKey) {
    super(DUPLICATE_CONTACT_MESSAGES[key]);
    this.name = "DuplicateContactError";
  }
}

/**
 * The only two constraints that mean "this contact already exists". Matched
 * on the Postgres error's `code` and `constraint` fields, never on its
 * message: the message is wording a server or driver may phrase differently,
 * while `23505` and the index name are contract. A `23505` on anything else
 * — a primary key, a constraint added later — is a different fact and must
 * not borrow this sentence.
 */
const UNIQUE_VIOLATION = "23505";

const CONTACT_KEY_CONSTRAINTS: ReadonlyMap<string, DuplicateContactKey> = new Map([
  ["crm_contacts_email_lower_uq", "email" as DuplicateContactKey],
  ["crm_contacts_instagram_lower_uq", "instagramHandle" as DuplicateContactKey],
]);

function duplicateContactKey(cause: unknown): DuplicateContactKey | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const { code, constraint } = cause as { code?: unknown; constraint?: unknown };
  if (code !== UNIQUE_VIOLATION || typeof constraint !== "string") return undefined;
  return CONTACT_KEY_CONSTRAINTS.get(constraint);
}

export interface CreateOrganisationInput {
  name: string;
  location?: string;
  websiteUrl?: string;
  /** Optional first contact, created in the same transaction. `lawfulBasis`
   *  is required WHEN a contact is supplied and has no default (#248): a
   *  contact typed by hand is not a scraped profile, and picking one for the
   *  operator is what made these columns decorative in the first place. */
  contact?: {
    name?: string;
    email?: string;
    instagramHandle?: string;
    lawfulBasis: LawfulBasis;
  };
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
  /**
   * Provenance (#248). Both are REQUIRED and neither is defaulted here.
   *
   * `source` is the write path (`crm-provenance.ts`'s `CONTACT_SOURCE`), not
   * the batch — `crm_organisations.import_id` already records that.
   * `lawfulBasis` is the reason we may hold this person's details at all,
   * and is re-checked below rather than trusted from the caller: an exported
   * writer is reachable by any future caller, and a guarantee that depends
   * on callers remembering is not a guarantee — the same argument that puts
   * `isSafeWebsiteUrl` and `isSuppressed` at this layer.
   *
   * `sourced_at` takes `now()` at the INSERT and is not an input: it is when
   * we obtained the row, which is a fact about this write, not a claim a
   * caller gets to make.
   */
  source: ContactSource;
  lawfulBasis: LawfulBasis;
  /**
   * The scrape fields (#235): the three typed columns 0019 shipped and the
   * raw bag 0027 added. All optional — `createOrganisation`'s inline contact
   * and the manual-add form supply none of them, and an absent bag lands as
   * the column's `'{}'` default rather than null.
   *
   * `metadata` is an object the CALLER has already parsed (import does so
   * via `parseMetadataCell`); there is no free-form JSON entry on any manual
   * form, deliberately — the bag holds scrape output, not typed-in text.
   */
  biography?: string;
  followersCount?: number;
  postsCount?: number;
  metadata?: Record<string, unknown>;
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
        // Hand-typed, whatever the organisation around it came from — an
        // organisation created by hand has no CSV batch behind it.
        source: CONTACT_SOURCE.manual,
        lawfulBasis: input.contact.lawfulBasis,
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
  // Same derivation `commitImport` uses (crm-repo.ts) — one mapper, so an
  // organisation created by hand agrees with one created by import about
  // what country the same raw location resolves to. Never overwrites: the
  // raw string is stored in `location` exactly as given, and `country` is
  // just a derived read of it.
  const location = input.location?.trim() || null;
  const rows = await query<{ id: string }>(
    `INSERT INTO crm_organisations (name, location, country, website_url)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [name, location, countryFromLocation(location), input.websiteUrl?.trim() || null],
  );
  return rows[0].id;
}

/**
 * Create a contact against an existing organisation.
 *
 * Transactional despite being a single INSERT, for Ruling 23's connection
 * argument rather than a race argument: the check and the insert share one
 * client, so this write costs one connection out of a `max: 2` pool instead
 * of two. It does not make the pair atomic against a suppression added
 * between them — see `assertNotSuppressed` above for why that window stays
 * open and what would actually close it.
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

/**
 * Largest value Postgres's `integer` holds — the declared type of both
 * `crm_contacts.followers_count` and `.posts_count`.
 */
const MAX_COUNT_VALUE = 2_147_483_647;

/**
 * A follower/post count on its way into an `integer` column, or null when
 * the caller supplied none.
 *
 * Throws on a value the column cannot hold. Unlike the CSV import — where a
 * bad cell is operator input, stored as NULL and counted so the sheet can be
 * corrected (`commitImport`) — a caller of this function has already been
 * typed as passing a `number`, so anything fractional, negative or
 * out-of-range is a programming error. Letting it reach the INSERT would
 * raise a Postgres error the caller cannot act on; silently clamping it
 * would store a count nobody scraped.
 */
function countValue(field: "followersCount" | "postsCount", value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > MAX_COUNT_VALUE) {
    throw new Error(`insertContact: ${field} must be a whole number between 0 and ${MAX_COUNT_VALUE}`);
  }
  return value;
}

// Both manual-create doors insert their contact here, so translating the
// collision at this one statement is what makes `createOrganisation` and
// `createContact` refuse identically. Anything that is not one of the two
// contact-identity constraints is re-thrown untouched.
async function insertContact(
  query: TxQuery,
  input: CreateContactInput,
): Promise<string> {
  // #248. Checked HERE and not only in the actions above, for the reason the
  // module comment gives about `isSafeWebsiteUrl` and `isSuppressed`: this is
  // an exported writer, and `lawful_basis` is a plain `text` column with no
  // CHECK, so nothing but this line stops a future caller writing free text —
  // or `not_recorded_pre_migration`, which is storable but never choosable —
  // into the field a subject-access request is answered from.
  if (!isSelectableLawfulBasis(input.lawfulBasis)) {
    throw new Error(`insertContact: ${String(input.lawfulBasis)} is not a selectable lawful basis`);
  }
  try {
    const rows = await query<{ id: string }>(
      `INSERT INTO crm_contacts
         (organisation_id, name, email, phone, instagram_handle, is_primary,
          biography, followers_count, posts_count, metadata,
          source, sourced_at, lawful_basis)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, now(), $12)
       RETURNING id`,
      [
        input.organisationId,
        input.name?.trim() || null,
        input.email ? input.email.trim().toLowerCase() : null,
        input.phone?.trim() || null,
        // #236: the same normalisation `isSuppressed` keyed its check on, so
        // the string checked against the do-not-contact list is the string
        // inserted. Migration 0023's `crm_contacts_normalize()` trigger also
        // normalises on write and stays as the storage-layer guarantee; this
        // is what stops that trigger being the only thing holding the two
        // layers together.
        input.instagramHandle ? normalizeInstagramHandle(input.instagramHandle) || null : null,
        input.isPrimary ?? false,
        input.biography?.trim() || null,
        countValue("followersCount", input.followersCount),
        countValue("postsCount", input.postsCount),
        // `'{}'` for an absent bag, matching the column's own default — the
        // column is NOT NULL, and one spelling of "nothing retained" is the
        // whole reason it is.
        JSON.stringify(input.metadata ?? {}),
        input.source,
        input.lawfulBasis,
      ],
    );
    return rows[0].id;
  } catch (cause) {
    const key = duplicateContactKey(cause);
    if (key) throw new DuplicateContactError(key);
    throw cause;
  }
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

/** A field of the organisation an operator may correct. `converted_*` is not
 *  among them: `crm_org_conversion_complete` requires `converted_ref` and
 *  `converted_product` travel together, and `linkConversion` (crm-repo.ts) is
 *  the deliberate single writer of that pair. */
export type OrganisationField = "name" | "location" | "websiteUrl" | "category" | "tags";

export interface ChangedField {
  field: OrganisationField;
  from: string | string[] | null;
  to: string | string[] | null;
}

export interface UpdateOrganisationInput {
  organisationId: string;
  /** Who is making the correction. Supplied by the caller — the action passes
   *  `withCrmWrite`'s actor — and never defaulted here: `crm_activities.actor`
   *  is the record of who did it, and a writer that invents a fallback would
   *  attribute a real edit to a name nobody signed in as. */
  actor: string;
  name: string;
  location?: string;
  websiteUrl?: string;
  category?: string[];
  tags?: string[];
}

/** Every editable field, after trimming. Omitted optional fields normalise to
 *  the empty value — this is a full replacement of the row's editable fields,
 *  not a patch, so an omitted `location` clears it. */
interface NormalisedOrganisation {
  name: string;
  location: string | null;
  websiteUrl: string | null;
  category: string[];
  tags: string[];
}

/**
 * Trim each entry, drop the blanks, keep the first occurrence of each.
 *
 * Returns a new array; the caller's is never touched. `category` and `tags`
 * are `text[] NOT NULL DEFAULT '{}'`, so the empty case is `[]`, never null.
 */
function normaliseList(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  return (values ?? []).reduce<string[]>((acc, raw) => {
    const value = raw.trim();
    if (!value || seen.has(value)) return acc;
    seen.add(value);
    return [...acc, value];
  }, []);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function diffOrganisation(
  current: NormalisedOrganisation,
  next: NormalisedOrganisation,
): ChangedField[] {
  const scalars: readonly OrganisationField[] = ["name", "location", "websiteUrl"];
  const lists: readonly OrganisationField[] = ["category", "tags"];
  return [
    ...scalars
      .filter((field) => current[field] !== next[field])
      .map((field) => ({ field, from: current[field], to: next[field] }) as ChangedField),
    ...lists
      .filter((field) => !sameList(current[field] as string[], next[field] as string[]))
      .map((field) => ({ field, from: current[field], to: next[field] }) as ChangedField),
  ];
}

/**
 * Correct an organisation's own fields.
 *
 * The only `UPDATE crm_organisations` besides `linkConversion`, and the only
 * way to fix a typed name or an import-dropped website without deleting the
 * row — which would cascade away its opportunities and its whole timeline.
 *
 * `name` is rejected blank and `websiteUrl` scheme-checked here, before the
 * transaction, for the reasons `createOrganisation` above states: the column
 * accepts `""` but an unnamed organisation is unfindable, and `website_url`
 * renders back as a clickable `<a href target="_blank">`.
 *
 * The row is locked (`FOR UPDATE`) and diffed inside the transaction, so the
 * diff recorded on the timeline is against the state this UPDATE actually
 * replaced, not one a concurrent edit had already moved on from.
 *
 * An edit that changes nothing writes nothing — no UPDATE, no activity row.
 * The timeline is read as the record of what happened to this business, and
 * opening the form and pressing save did not happen to it.
 *
 * The activity row is inlined here rather than delegated to `logActivity`
 * (crm-repo.ts), which bumps `last_contacted_at` and runs the suppression
 * check: a field correction is neither an outbound message nor contact.
 */
export async function updateOrganisation(
  input: UpdateOrganisationInput,
): Promise<{ changed: ChangedField[] }> {
  const next = normaliseInput(input);
  if (!next.name) {
    throw new Error("updateOrganisation: name is required");
  }
  if (next.websiteUrl && !isSafeWebsiteUrl(next.websiteUrl)) {
    throw new Error("updateOrganisation: websiteUrl must be an http(s) address");
  }

  return tesserixTx(async (query) => {
    const current = await selectForUpdate(query, input.organisationId);
    const changed = diffOrganisation(current, next);
    if (changed.length === 0) return { changed };

    await writeOrganisation(query, input.organisationId, next);
    await writeEditActivity(query, input.organisationId, input.actor, changed);
    return { changed };
  });
}

function normaliseInput(input: UpdateOrganisationInput): NormalisedOrganisation {
  return {
    name: input.name.trim(),
    location: input.location?.trim() || null,
    websiteUrl: input.websiteUrl?.trim() || null,
    category: normaliseList(input.category),
    tags: normaliseList(input.tags),
  };
}

async function selectForUpdate(
  query: TxQuery,
  organisationId: string,
): Promise<NormalisedOrganisation> {
  const rows = await query<{
    name: string;
    location: string | null;
    website_url: string | null;
    category: string[];
    tags: string[];
  }>(
    `SELECT name, location, website_url, category, tags
       FROM crm_organisations
      WHERE id = $1
        FOR UPDATE`,
    [organisationId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`updateOrganisation: organisation ${organisationId} not found`);
  }
  return {
    name: row.name,
    location: row.location,
    websiteUrl: row.website_url,
    category: row.category ?? [],
    tags: row.tags ?? [],
  };
}

async function writeOrganisation(
  query: TxQuery,
  organisationId: string,
  next: NormalisedOrganisation,
): Promise<void> {
  // `country` is re-derived from the new location with the same mapper
  // `createOrganisation` and `commitImport` use — it is a derived read of
  // `location`, so leaving it behind would mis-file the organisation in the
  // country-filtered follow-up queue (#232).
  //
  // `updated_at` is stamped by hand: there are no triggers on `crm_*`.
  await query(
    `UPDATE crm_organisations
        SET name = $2,
            location = $3,
            country = $4,
            website_url = $5,
            category = $6,
            tags = $7,
            updated_at = now()
      WHERE id = $1`,
    [
      organisationId,
      next.name,
      next.location,
      countryFromLocation(next.location),
      next.websiteUrl,
      next.category,
      next.tags,
    ],
  );
}

async function writeEditActivity(
  query: TxQuery,
  organisationId: string,
  actor: string,
  changed: readonly ChangedField[],
): Promise<void> {
  // Same transaction as the UPDATE (Ruling 31, as `linkConversion` does):
  // an edit that landed with no note on the timeline would be a name change
  // under a live deal that the next rep reading the record cannot see.
  //
  // No `opportunity_id` — a change to the business's own fields belongs to
  // the organisation, not to any one of its deals.
  const metadata = Object.fromEntries(
    changed.map(({ field, from, to }) => [field, { from, to }]),
  );
  await query(
    `INSERT INTO crm_activities (organisation_id, kind, actor, body, metadata)
     VALUES ($1, 'note', $2, $3, $4::jsonb)`,
    [
      organisationId,
      actor,
      `Edited ${changed.map((c) => c.field).join(", ")}`,
      JSON.stringify(metadata),
    ],
  );
}

// =========================================================================
// CONTACT CORRECTIONS (#247)
//
// Until this existed the only way to fix a contact was `eraseContact`, the
// DPDP erasure path — which pseudonymises the row, stamps `erased_at`, and
// therefore writes an erasure event that no data subject ever requested. Using
// the "forget me" log as an edit mechanism fills the evidence of honouring
// erasure requests with events that were not erasure requests, and loses
// `created_at` on the way through.
//
// It also blocks something concrete: the conversion signal (#246) matches on
// EMAIL, and 256 of the 259 leads in production carry only an Instagram
// handle. An email arrives when a lead replies, and before this there was
// nowhere to put it.
// =========================================================================

/** The contact fields an operator may correct. `is_primary` is deliberately
 *  not among them — it is not this contact's property alone, so it moves
 *  through `setPrimaryContact` where the siblings can be demoted with it. */
export type ContactField = "name" | "email" | "phone" | "instagramHandle" | "lawfulBasis";

export interface ChangedContactField {
  field: ContactField;
  from: string | null;
  to: string | null;
}

export interface UpdateContactInput {
  contactId: string;
  /** Who is making the correction — `crm_activities.actor`, never defaulted
   *  here, for the reason `UpdateOrganisationInput` states. */
  actor: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  instagramHandle?: string | null;
  /**
   * A corrected lawful basis (#248), or `undefined` to leave the recorded
   * one exactly as it stands.
   *
   * "Leave it alone" is a distinct third state from the null-vs-value the
   * four identifying fields use, and it is what makes the 259 migrated rows
   * editable at all: they hold `not_recorded_pre_migration`, which is
   * storable but not selectable, so an edit form that had to resubmit the
   * current value could never save. Omitting the field touches the column
   * not at all.
   *
   * `source` and `sourced_at` are NOT correctable through here on purpose.
   * They record how and when the row was obtained — facts about a past
   * event, not an operator's assessment — and a rewritable acquisition
   * record evidences nothing.
   */
  lawfulBasis?: LawfulBasis;
}

interface NormalisedContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  instagramHandle: string | null;
  /** `undefined` means "unchanged" — see `UpdateContactInput.lawfulBasis`.
   *  Never null: a basis can be corrected but not cleared, because a contact
   *  held under no basis is the defect #248 reports. */
  lawfulBasis: LawfulBasis | undefined;
}

/**
 * Correct a contact's own fields.
 *
 * The row is locked (`FOR UPDATE`) and diffed inside the transaction, so the
 * diff on the timeline is against the state this UPDATE actually replaced and
 * not one a concurrent edit had already moved past — same discipline as
 * `updateOrganisation`.
 *
 * An edit that changes nothing writes nothing.
 */
export async function updateContact(
  input: UpdateContactInput,
): Promise<{ changed: ChangedContactField[] }> {
  const next = normaliseContactInput(input);

  return tesserixTx(async (query) => {
    const current = await selectContactForUpdate(query, input.contactId);
    const changed = diffContact(current, next);
    if (changed.length === 0) return { changed };

    await writeContact(query, input.contactId, next);
    await writeContactEditActivity(query, current.organisationId, input.actor, changed);
    return { changed };
  });
}

/** The same normalisation `insertContact` applies, so a corrected value is
 *  stored in the form the indexes and `isSuppressed` expect (#236). */
function normaliseContactInput(input: UpdateContactInput): NormalisedContact {
  return {
    name: input.name?.trim() || null,
    email: input.email ? input.email.trim().toLowerCase() || null : null,
    phone: input.phone?.trim() || null,
    instagramHandle: input.instagramHandle
      ? normalizeInstagramHandle(input.instagramHandle) || null
      : null,
    // Same reasoning as `insertContact`'s check, at the other writer of this
    // column: an exported function must not depend on its callers having
    // validated. `undefined` passes through as "unchanged".
    lawfulBasis: assertCorrectableLawfulBasis(input.lawfulBasis),
  };
}

function assertCorrectableLawfulBasis(value: LawfulBasis | undefined): LawfulBasis | undefined {
  if (value === undefined) return undefined;
  if (!isSelectableLawfulBasis(value)) {
    throw new Error(`updateContact: ${String(value)} is not a selectable lawful basis`);
  }
  return value;
}

async function selectContactForUpdate(
  query: TxQuery,
  contactId: string,
): Promise<NormalisedContact & { organisationId: string }> {
  const rows = await query<{
    organisation_id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    instagram_handle: string | null;
    lawful_basis: string | null;
  }>(
    `SELECT organisation_id, name, email, phone, instagram_handle, lawful_basis
       FROM crm_contacts
      WHERE id = $1
        FOR UPDATE`,
    [contactId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`updateContact: contact ${contactId} not found`);
  }
  return {
    organisationId: row.organisation_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    instagramHandle: row.instagram_handle,
    // Widened, not validated: whatever the row holds is what the diff has to
    // compare against, `not_recorded_pre_migration` included. Only the
    // incoming value is gated.
    lawfulBasis: (row.lawful_basis ?? undefined) as LawfulBasis | undefined,
  };
}

function diffContact(
  current: NormalisedContact,
  next: NormalisedContact,
): ChangedContactField[] {
  const fields: readonly ContactField[] = ["name", "email", "phone", "instagramHandle"];
  const changed: ChangedContactField[] = fields
    .filter((field) => current[field] !== next[field])
    .map((field) => ({ field, from: current[field] as string | null, to: next[field] as string | null }));
  // Guarded on `undefined` rather than folded into the loop above: for the
  // four identifying fields an absent input MEANS null (clear it), and for
  // the basis it means "leave it", so the same comparison cannot serve both.
  if (next.lawfulBasis !== undefined && next.lawfulBasis !== current.lawfulBasis) {
    changed.push({
      field: "lawfulBasis",
      from: current.lawfulBasis ?? null,
      to: next.lawfulBasis,
    });
  }
  return changed;
}

async function writeContact(
  query: TxQuery,
  contactId: string,
  next: NormalisedContact,
): Promise<void> {
  // The collision is translated at the UPDATE the same way `insertContact`
  // translates it at the INSERT, and on the same evidence — `code` and
  // `constraint`, never the driver's message text. An operator editing an
  // address into one the CRM already holds gets #237's sentence, not a
  // generic failure.
  try {
    await query(
      // COALESCE, so an omitted basis leaves the recorded one — including
      // the legacy marker on the 259 migrated rows — exactly where it is.
      // `sourced_at` is untouched here for the same reason `source` is: it
      // is when the row was obtained, and a correction is not an
      // acquisition.
      `UPDATE crm_contacts
          SET name = $2,
              email = $3,
              phone = $4,
              instagram_handle = $5,
              lawful_basis = COALESCE($6, lawful_basis),
              updated_at = now()
        WHERE id = $1`,
      [contactId, next.name, next.email, next.phone, next.instagramHandle, next.lawfulBasis ?? null],
    );
  } catch (cause) {
    const key = duplicateContactKey(cause);
    if (key) throw new DuplicateContactError(key);
    throw cause;
  }
}

async function writeContactEditActivity(
  query: TxQuery,
  organisationId: string,
  actor: string,
  changed: readonly ChangedContactField[],
): Promise<void> {
  // Inlined rather than delegated to `logActivity`, for the reason
  // `writeEditActivity` gives: that helper bumps `last_contacted_at` and runs
  // the suppression check, and a field correction is neither an outbound
  // message nor contact. Fixing a typo must not reset the follow-up clock.
  const metadata = Object.fromEntries(
    changed.map(({ field, from, to }) => [field, { from, to }]),
  );
  await query(
    `INSERT INTO crm_activities (organisation_id, kind, actor, body, metadata)
     VALUES ($1, 'note', $2, $3, $4::jsonb)`,
    [
      organisationId,
      actor,
      `Edited ${changed.map((c) => c.field).join(", ")}`,
      JSON.stringify(metadata),
    ],
  );
}

export interface SetPrimaryContactInput {
  contactId: string;
  actor: string;
}

/**
 * Make one contact the organisation's primary, demoting the others.
 *
 * Promotion and demotion share a transaction because two primaries would make
 * `primaryContactOrder`'s `is_primary DESC` tiebreak arbitrary — and that
 * ordering is the tiebreak in SEVEN queries, including the follower-band
 * filter. The browse list and the filter could then disagree about who the
 * primary is, which is the class of bug `primaryContactOrder` exists to stop.
 *
 * Promoting the contact that is already primary writes nothing.
 */
export async function setPrimaryContact(
  input: SetPrimaryContactInput,
): Promise<{ changed: boolean }> {
  return tesserixTx(async (query) => {
    const rows = await query<{
      organisation_id: string;
      is_primary: boolean;
      name: string | null;
    }>(
      `SELECT organisation_id, is_primary, name
         FROM crm_contacts
        WHERE id = $1
          FOR UPDATE`,
      [input.contactId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`setPrimaryContact: contact ${input.contactId} not found`);
    }
    if (row.is_primary) return { changed: false };

    // Demote first, then promote. The other order would leave two primaries
    // visible to a concurrent reader mid-transaction on a weaker isolation
    // level; this order leaves none, which the ordering degrades to gracefully
    // (it falls through to `created_at ASC, id ASC`) where two would not.
    await query(
      `UPDATE crm_contacts
          SET is_primary = false, updated_at = now()
        WHERE organisation_id = $1 AND is_primary`,
      [row.organisation_id],
    );
    await query(
      `UPDATE crm_contacts
          SET is_primary = true, updated_at = now()
        WHERE id = $1`,
      [input.contactId],
    );
    await query(
      `INSERT INTO crm_activities (organisation_id, kind, actor, body, metadata)
       VALUES ($1, 'note', $2, $3, $4::jsonb)`,
      [
        row.organisation_id,
        input.actor,
        `Made ${row.name ?? "a contact"} the primary contact`,
        JSON.stringify({ isPrimary: { from: false, to: true } }),
      ],
    );
    return { changed: true };
  });
}
