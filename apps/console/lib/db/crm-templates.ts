import { tesserixQuery } from "./tesserix";
import { parseMergeFields } from "../crm-merge-fields";

/**
 * Reads and writes for `crm_templates` (0043), plus the one per-lead read
 * that feeds the renderer its values.
 *
 * ITS OWN FILE, NOT `crm-repo.ts`. That file is past 2,600 lines and is
 * organised around two paths — the CRM's reads and the CRM's create/import
 * writes. This is neither: templates are a small, self-contained CRUD over a
 * table nothing else joins, and `templateContext` is a read that exists only
 * to be handed to `renderTemplate`. `crm-erasure.ts` already set the
 * precedent for "this is neither the read path nor the create path", for the
 * same reason. The alternative — a fourth section in `crm-repo.ts` — would
 * have cost nothing today and a little more of that file's readability
 * forever, and the biography decision below is one nobody should have to
 * find by scrolling.
 *
 * ══ THE BIOGRAPHY, AND WHY IT IS HERE AT ALL ══
 *
 * `templateContext` returns `crm_contacts.biography`. It is the ONLY place
 * in the console that does, and that is deliberate rather than incidental.
 *
 * `biography` is scrape-derived personal data about someone who never filled
 * in a form — 0019's own words for what this table holds. It is returned
 * here FOR RENDER ONLY: it goes into `renderTemplate`, into a textarea, and
 * into the operator's clipboard. It must never be PERSISTED, because
 * `eraseContact` (`crm-erasure.ts`) nulls the contact's columns and empties
 * its metadata bag but does not reach `crm_activities` — so anything derived
 * from this column and written there would outlive the erasure request that
 * was supposed to destroy it. Migration 0027's DPDP paragraph names that
 * exact situation "a compliance defect, not a feature".
 *
 * Nothing in THIS file writes it anywhere. The place that could is
 * `recordTemplatedDm`, and the proof that it does not is
 * `crm-outreach.integration.test.ts` — a separate file on purpose, so the
 * guarantee reads as one diff. If you are here because you want a rendered
 * message stored somewhere, read that test first; it is the argument, not
 * the paperwork.
 *
 * The narrowing that keeps this contained is `TemplateContactRow`, below: a
 * separate shape from `crm-repo.ts`'s `ContactRow`, so that `biography`
 * cannot arrive on a surface by being already present on the type every
 * other CRM screen renders.
 */

/** The channels 0043's `crm_template_channel` enum allows. Spelled here as
 *  well as in the migration because a caller passing `"sms"` should be a
 *  TypeScript error at the call site, not a 22P02 from Postgres at runtime. */
export type TemplateChannel = "dm" | "email";

export interface TemplateRow {
  id: string;
  name: string;
  channel: TemplateChannel;
  /** Null means ANY product, not "unknown" — see 0043's header. */
  product: string | null;
  /** Always null for `dm`, enforced by `crm_template_subject_is_email_only`. */
  subject: string | null;
  body: string;
  isArchived: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface TemplateDbRow {
  id: string;
  name: string;
  channel: TemplateChannel;
  product: string | null;
  subject: string | null;
  body: string;
  is_archived: boolean;
  created_by: string;
  created_at: unknown;
  updated_at: unknown;
}

/** Local rather than imported from `crm-repo.ts`, where the equivalent
 *  helpers are private. Duplicating six lines is cheaper than widening that
 *  file's exported surface for a converter, and this one is allowed to be
 *  strict: every timestamp on `crm_templates` is `NOT NULL`, so a null here
 *  means the query stopped selecting the column, which should be loud. */
function toIsoRequired(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("crm-templates: expected a NOT NULL timestamp");
}

function toTemplateRow(row: TemplateDbRow): TemplateRow {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    product: row.product,
    subject: row.subject,
    body: row.body,
    isArchived: row.is_archived,
    createdBy: row.created_by,
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
  };
}

/** Every column, in one place, so the four statements below cannot drift into
 *  returning different shapes for the same type. */
const TEMPLATE_COLUMNS = `id, name, channel, product, subject, body, is_archived, created_by, created_at, updated_at`;

export interface ListTemplatesOptions {
  channel?: TemplateChannel;
  includeArchived?: boolean;
}

/**
 * Live templates, newest first.
 *
 * ARCHIVED ARE EXCLUDED BY DEFAULT, and the flag is `includeArchived` rather
 * than a `status` filter, because every caller that renders a picker wants
 * live rows and exactly one caller (the admin surface's "show archived"
 * toggle) wants the rest. A default that showed everything would put retired
 * copy back in front of an operator mid-send, which is the failure archiving
 * exists to prevent.
 *
 * `id` in the ORDER BY is load-bearing, for the same reason
 * `primaryContactOrder` carries it in `crm-repo.ts`: `created_at` is not
 * unique, so without a total order two templates written in the same
 * statement swap places between renders.
 */
export async function listTemplates(options: ListTemplatesOptions = {}): Promise<TemplateRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!options.includeArchived) conditions.push(`NOT is_archived`);
  if (options.channel !== undefined) {
    params.push(options.channel);
    conditions.push(`channel = $${params.length}::crm_template_channel`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await tesserixQuery<TemplateDbRow>(
    `SELECT ${TEMPLATE_COLUMNS}
       FROM crm_templates
       ${where}
      ORDER BY created_at DESC, id DESC`,
    params,
  );
  return rows.map(toTemplateRow);
}

export interface CreateTemplateInput {
  name: string;
  channel: TemplateChannel;
  product?: string | null;
  subject?: string | null;
  body: string;
  actor: string;
}

/**
 * Author a template.
 *
 * VALIDATES THE MERGE FIELDS BEFORE THE INSERT, and that placement is the
 * decision worth recording. `parseMergeFields` THROWS `UnknownMergeFieldError`
 * on a token outside the six-field allowlist, and this function lets it
 * propagate — no row is written.
 *
 * The reason the check is here and not only in the authoring form: a template
 * carrying `{{contact.followers}}` renders nothing for EVERY lead, forever,
 * and a form-only check is one a script, a second surface, or a future caller
 * routes around without noticing. When it is discovered, it is discovered by
 * an operator mid-send, on someone else's screen, hours after the person who
 * could fix it stopped thinking about it. Rejecting at authoring time puts
 * the error in front of the author while they are still holding the text.
 *
 * SUBJECT IS NOT NORMALISED AWAY FOR A `dm`. A subject submitted against a
 * DM template is passed through and REJECTED by
 * `crm_template_subject_is_email_only`. Quietly nulling it here would be
 * exactly the silent drop 0043's header says the CHECK exists to prevent —
 * the operator's words would go nowhere and nothing would tell them.
 *
 * Emptiness and trimming are the ACTION's job (`templates/actions.ts`), not
 * this function's: they are presentation-boundary concerns with an
 * operator-facing message attached, and this layer stays plain data access
 * per the same rule `removeSuppression` follows.
 */
export async function createTemplate(input: CreateTemplateInput): Promise<TemplateRow> {
  const subject = input.subject ?? null;

  // Body and subject scanned TOGETHER: a bad token in a subject line is the
  // same authoring bug as one in the body, and `renderTemplate` already
  // fails the whole render for either.
  parseMergeFields(...(subject === null ? [input.body] : [input.body, subject]));

  const rows = await tesserixQuery<TemplateDbRow>(
    `INSERT INTO crm_templates (name, channel, product, subject, body, created_by)
     VALUES ($1, $2::crm_template_channel, $3, $4, $5, $6)
     RETURNING ${TEMPLATE_COLUMNS}`,
    [input.name, input.channel, input.product ?? null, subject, input.body, input.actor],
  );
  return toTemplateRow(rows[0]);
}

/**
 * Retire a template.
 *
 * ARCHIVE, NEVER DELETE. `crm_activities.metadata` carries `template_id`
 * forever, and a deleted template turns every one of those rows into a
 * dangling id nobody can resolve — the outreach log would still say a DM was
 * sent and would no longer be able to say what it said.
 *
 * Returns THE ROWS THE UPDATE ACTUALLY REPORTED, not a boolean and not an
 * assumed 1. `WHERE id = $1 AND NOT is_archived` matches nothing on a second
 * archive or an unknown id, so the caller's audit row says `{ archived: 0 }`
 * rather than recording an archival that did not happen. Same rule
 * `removeSuppression` already follows, and the same reason: an audit trail
 * that overstates what occurred is worse than one that omits it.
 *
 * `updated_at` is set in this statement rather than by a trigger, per 0043's
 * header — there are no triggers on the `crm_` tables and every writer here
 * maintains the column itself.
 */
export async function archiveTemplate(id: string): Promise<TemplateRow[]> {
  const rows = await tesserixQuery<TemplateDbRow>(
    `UPDATE crm_templates
        SET is_archived = true, updated_at = now()
      WHERE id = $1 AND NOT is_archived
      RETURNING ${TEMPLATE_COLUMNS}`,
    [id],
  );
  return rows.map(toTemplateRow);
}

export interface TemplateOrganisation {
  id: string;
  name: string;
  location: string | null;
  category: readonly string[];
}

/**
 * A contact as the RENDERER needs it.
 *
 * DELIBERATELY NOT `crm-repo.ts`'s `ContactRow`, and not an extension of it.
 * The difference is `biography` — scraped personal data — and reusing the
 * shared shape would put that field on the type every other CRM surface
 * already renders, where the next person to spread a contact into a prop bag
 * would carry it onto a screen nobody reviewed for it. A separate interface
 * means acquiring `biography` requires importing this module and asking, and
 * the ask is greppable.
 *
 * `phone` and `isPrimary` are absent for the same reason inverted: no merge
 * field reads them, so nothing here needs to carry them.
 */
export interface TemplateContactRow {
  id: string;
  name: string | null;
  email: string | null;
  instagramHandle: string | null;
  /**
   * Scrape-derived personal data. RENDER ONLY — never persist it, never log
   * it, never put it in an audit `target`. See this file's header, and
   * `crm-outreach.integration.test.ts` for the proof that the one write which
   * could store it does not.
   */
  biography: string | null;
}

export interface TemplateContext {
  organisation: TemplateOrganisation;
  contacts: readonly TemplateContactRow[];
}

/**
 * Everything one lead can supply to a template, in one read.
 *
 * `null` for "no such organisation" — the caller turns that into its own
 * not-found, the same contract `organisationDetail` uses. An empty context
 * would be indistinguishable from a real organisation whose contacts were
 * all erased, and those two want different messages.
 *
 * ══ ERASED CONTACTS ARE EXCLUDED, AND THIS IS THE POINT OF THE FILTER ══
 *
 * `eraseContact` does not delete the row. It writes the literal string
 * `'[erased]'` into `name` and nulls the rest. So an erased contact does NOT
 * present to a renderer as missing data — it presents as a NAME, sails
 * through `renderTemplate`'s missing-field check, and produces
 * "Hi [erased]" in a message an operator is about to paste into someone's
 * DMs. Every other guard in this feature is a null check, and a null check
 * is precisely what `'[erased]'` is designed to survive.
 *
 * `WHERE erased_at IS NULL` is therefore the only thing that makes an
 * erasure visible to this feature at all. Filtering in the composer instead
 * was rejected: the composer is one caller, and the next one would have to
 * remember. Filtering in `renderTemplate` was rejected too — that module is
 * pure and knows nothing about erasure semantics, and teaching it would give
 * the rendering rule a database concept to depend on.
 *
 * A contact that vanishes from this list between a page render and a preview
 * is what lets the preview say "erased" rather than render the tombstone.
 *
 * ORDERING mirrors `primaryContactOrder` in `crm-repo.ts` (`is_primary`, then
 * oldest, then `id`) so the contact this surface offers first is the same one
 * the detail page calls the primary. Spelled out rather than imported because
 * that helper is private to `crm-repo.ts`; if a third caller needs it, that is
 * the moment to export it rather than now.
 */
export async function templateContext(organisationId: string): Promise<TemplateContext | null> {
  const orgRows = await tesserixQuery<{
    id: string;
    name: string;
    location: string | null;
    category: string[];
  }>(
    `SELECT id, name, location, category
       FROM crm_organisations
      WHERE id = $1`,
    [organisationId],
  );
  const org = orgRows[0];
  if (!org) return null;

  const contactRows = await tesserixQuery<{
    id: string;
    name: string | null;
    email: string | null;
    instagram_handle: string | null;
    biography: string | null;
  }>(
    `SELECT id, name, email, instagram_handle, biography
       FROM crm_contacts
      WHERE organisation_id = $1
        AND erased_at IS NULL
      ORDER BY is_primary DESC, created_at ASC, id ASC`,
    [organisationId],
  );

  return {
    organisation: {
      id: org.id,
      name: org.name,
      location: org.location,
      category: org.category,
    },
    contacts: contactRows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      instagramHandle: row.instagram_handle,
      biography: row.biography,
    })),
  };
}
