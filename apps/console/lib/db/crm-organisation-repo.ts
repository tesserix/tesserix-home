/**
 * The CRM organisation-detail read.
 *
 * Split out of `crm-repo.ts` (#566); `crm-repo.ts` re-exports everything here,
 * so nothing importing `@/lib/db/crm-repo` had to change.
 *
 * The contact list is ordered by `primaryContactOrder` from `crm-sql.ts`, and
 * must keep importing it rather than spelling it out: this page and
 * `listOrganisations` have to agree about which contact is "the primary", and
 * a second copy of that ordering is how they came apart before.
 */
import { tesserixQuery } from "./tesserix";
import { type CrmActivityKind, type CrmStage } from "../crm";
import { toIso, toIsoRequired } from "./crm-row";
import { primaryContactOrder } from "./crm-sql";

/**
 * The organisation-detail read: the business, its people, its deals across
 * every product, and its activity history. Four queries rather than one
 * giant join — the tables fan out (many contacts, many opportunities, many
 * activities per organisation) in ways a single join would either duplicate
 * rows for or force into nested JSON aggregation; four flat reads are
 * simpler to reason about at these row counts.
 */

export interface OrganisationRow {
  id: string;
  name: string;
  websiteUrl: string | null;
  location: string | null;
  /**
   * ISO 3166-1 alpha-2 code derived from `location` by `countryFromLocation`,
   * and `null` when there was nothing to derive: either no location at all,
   * or a location the mapper has no entry for. Those are different absences
   * and the surfaces must not render them the same way. No writer can attach
   * a country to a NULL location, so a null `location` here always carries a
   * null `country` — see `LocationCell` in `organisations-view.tsx` for the
   * per-writer argument.
   */
  country: string | null;
  category: readonly string[];
  tags: readonly string[];
  convertedProduct: string | null;
  convertedLabel: string | null;
  convertedAt: string | null;
  createdAt: string;
}

export interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  instagramHandle: string | null;
  isPrimary: boolean;
  /**
   * The scraped follower count (#252 §A) — the CRM's only quantitative
   * qualification signal, and what the organisations browse list bands and
   * sorts on.
   *
   * Nullable, and never coalesced to 0 on the way out: a null here means no
   * count was ever collected for this contact, which is a different claim
   * from a measured zero. `crm-filters.ts`'s `UNKNOWN_LABEL` carries the
   * argument in full; the short version is that an operator reading
   * "0 followers" would qualify a lead out on a number nobody recorded.
   */
  followersCount: number | null;
  /**
   * Provenance (#248) — what we hold, when we got it, and why we may.
   *
   * Read here rather than left to a database query because the detail page
   * is where a subject-access request is answered: before this, migration
   * 0019's three columns were written by one migration script and selected
   * by nothing, so the only way to answer "why do you have my details" was
   * psql. Nullable on all three: rows created between the cutover and #248
   * genuinely have none, and rendering a guess would be worse than
   * rendering "Not recorded".
   */
  source: string | null;
  sourcedAt: string | null;
  lawfulBasis: string | null;
}

export interface OpportunityRow {
  id: string;
  product: string | null;
  stage: CrmStage;
  owner: string | null;
  nextActionAt: string | null;
  nextActionNote: string | null;
  lastContactedAt: string | null;
  isStarred: boolean;
  closedAt: string | null;
  lostReason: string | null;
  createdAt: string;
  /**
   * When the deal was taken out of the funnel (#251), or null while it is
   * live.
   *
   * Carried on the row rather than left to the caller to infer, because
   * every consumer of this DTO needs the same answer and none of them can
   * derive it: a voided deal keeps its `stage`, so nothing else on this row
   * distinguishes it. `organisationDetail` is the one read that returns
   * voided deals at all — the queues, Closed and the handoff list exclude
   * them — which is what makes a Restore control possible.
   */
  voidedAt: string | null;
  /**
   * The operator's own words for why, or null.
   *
   * Null on a live deal (migration 0049's CHECK forbids a reason without a
   * `voided_at`), and null on a voided deal whose operator gave none — the
   * reason is optional, so its absence is not a defect to render around.
   */
  voidedReason: string | null;
}

export interface ActivityRow {
  id: string;
  opportunityId: string | null;
  kind: CrmActivityKind;
  actor: string;
  body: string | null;
  occurredAt: string;
}

export interface OrganisationDetail {
  organisation: OrganisationRow;
  contacts: readonly ContactRow[];
  opportunities: readonly OpportunityRow[];
  activities: readonly ActivityRow[];
  /**
   * There is activity older than `activities` that this read does not carry.
   *
   * Carried rather than left to the caller to infer from `activities.length
   * === ACTIVITY_LIMIT`, which is wrong exactly at the boundary: a timeline of
   * precisely the cap would claim there is more history when there is not.
   *
   * Discovered by asking for one row more than the cap and discarding it —
   * one query, not a second COUNT, the same trade `HandoffPage.hasMore`
   * makes (#246). The instance is a shared db-f1-micro, and the only decision
   * this informs — is what I am reading the whole record — is the same at 201
   * as at 2,001.
   */
  hasMoreActivities: boolean;
}

/** Most recent activities shown on a detail page — a full history is a job
 *  for export/search, not this view.
 *
 *  Exported so the test can assert the probe-row arithmetic against the
 *  constant itself rather than a copy of its value. */
export const ACTIVITY_LIMIT = 200;

/** `null` for "no such organisation" — the caller (the page) turns that into
 *  `notFound()`, the same contract `fetchTicketDetail` uses. */
export async function organisationDetail(organisationId: string): Promise<OrganisationDetail | null> {
  const orgRows = await tesserixQuery<{
    id: string;
    name: string;
    website_url: string | null;
    location: string | null;
    country: string | null;
    category: string[];
    tags: string[];
    converted_product: string | null;
    converted_label: string | null;
    converted_at: unknown;
    created_at: unknown;
  }>(
    `SELECT id, name, website_url, location, country, category, tags,
            converted_product, converted_label, converted_at, created_at
       FROM crm_organisations
      WHERE id = $1`,
    [organisationId],
  );
  const org = orgRows[0];
  if (!org) return null;

  const [contactRows, opportunityRows, activityRows] = await Promise.all([
    tesserixQuery<{
      id: string;
      name: string | null;
      email: string | null;
      phone: string | null;
      instagram_handle: string | null;
      is_primary: boolean;
      followers_count: number | null;
      source: string | null;
      sourced_at: unknown;
      lawful_basis: string | null;
    }>(
      // Erased contacts stay in this list, deliberately — see notErased().
      // This orders the WHOLE contact list rather than picking one contact to
      // stand for the organisation, and the detail page is the organisation's
      // file: a contact who exercised erasure is redacted there ('[erased]',
      // no identifiers), not hidden, or the record would silently lose a row
      // the activity trail still refers to.
      `SELECT id, name, email, phone, instagram_handle, is_primary,
              followers_count, source, sourced_at, lawful_basis
         FROM crm_contacts
        WHERE organisation_id = $1
        ORDER BY ${primaryContactOrder("")}`,
      [organisationId],
    ),
    tesserixQuery<{
      id: string;
      product: string | null;
      stage: CrmStage;
      owner: string | null;
      next_action_at: unknown;
      next_action_note: string | null;
      last_contacted_at: unknown;
      is_starred: boolean;
      closed_at: unknown;
      lost_reason: string | null;
      created_at: unknown;
      voided_at: unknown;
      voided_reason: string | null;
    }>(
      // Voided deals stay in this list, deliberately — the same reasoning
      // `notErased()` records for erased contacts just above (#251). This
      // page is the organisation's FILE, not a work queue: the queues,
      // Closed and the handoff list all exclude a voided deal, and if this
      // list excluded it too the deal would be unreachable and there would
      // be nothing for a Restore control to hang off. `advanceStageOnQuery`
      // and `setNextAction` refuse a voided row with
      // `VoidedOpportunityError` precisely because it is visible here.
      // `voided_reason` is selected here and nowhere else, and `voided_at`
      // is selected nowhere else that RENDERS one: this is the only read
      // that returns a voided deal, so it is the only one with anything to
      // say about it. The other three reads of `voided_at` — `advanceStage`
      // and `setNextAction` above, and `lockForVoidWrite` in crm-void.ts —
      // are locked reads inside a write, and they take the column to REFUSE
      // on it, never to show it.
      `SELECT id, product, stage, owner, next_action_at, next_action_note,
              last_contacted_at, is_starred, closed_at, lost_reason, created_at,
              voided_at, voided_reason
         FROM crm_opportunities
        WHERE organisation_id = $1
        ORDER BY created_at DESC`,
      [organisationId],
    ),
    tesserixQuery<{
      id: string;
      opportunity_id: string | null;
      kind: CrmActivityKind;
      actor: string;
      body: string | null;
      occurred_at: unknown;
    }>(
      // `id` last for the same reason the organisation keyset carries it:
      // `occurred_at` is a plain `timestamptz DEFAULT now()` with no
      // uniqueness guarantee, and rows can be written with an explicit value
      // (`scripts/seed-dev.mjs` does), so two rows can share it exactly.
      // Without a total order the LIMIT then breaks that tie arbitrarily —
      // and the cut now decides which row is DROPPED, not just where it sits,
      // so two loads of the same page could disagree about what the timeline
      // contains. No write path in the app produces such a tie today; this
      // costs nothing and removes the latent one.
      `SELECT id, opportunity_id, kind, actor, body, occurred_at
         FROM crm_activities
        WHERE organisation_id = $1
        ORDER BY occurred_at DESC, id DESC
        LIMIT $2`,
      // One more than the cap: the extra row is never returned, it only
      // answers "is there history past this".
      [organisationId, ACTIVITY_LIMIT + 1],
    ),
  ]);

  return {
    organisation: {
      id: org.id,
      name: org.name,
      websiteUrl: org.website_url,
      location: org.location,
      country: org.country,
      category: org.category,
      tags: org.tags,
      convertedProduct: org.converted_product,
      convertedLabel: org.converted_label,
      convertedAt: toIso(org.converted_at),
      createdAt: toIsoRequired(org.created_at),
    },
    contacts: contactRows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      instagramHandle: row.instagram_handle,
      isPrimary: row.is_primary,
      followersCount: row.followers_count,
      source: row.source,
      sourcedAt: toIso(row.sourced_at),
      lawfulBasis: row.lawful_basis,
    })),
    opportunities: opportunityRows.map((row) => ({
      id: row.id,
      product: row.product,
      stage: row.stage,
      owner: row.owner,
      nextActionAt: toIso(row.next_action_at),
      nextActionNote: row.next_action_note,
      lastContactedAt: toIso(row.last_contacted_at),
      isStarred: row.is_starred,
      closedAt: toIso(row.closed_at),
      lostReason: row.lost_reason,
      createdAt: toIsoRequired(row.created_at),
      voidedAt: toIso(row.voided_at),
      voidedReason: row.voided_reason,
    })),
    activities: activityRows.slice(0, ACTIVITY_LIMIT).map((row) => ({
      id: row.id,
      opportunityId: row.opportunity_id,
      kind: row.kind,
      actor: row.actor,
      body: row.body,
      occurredAt: toIsoRequired(row.occurred_at),
    })),
    hasMoreActivities: activityRows.length > ACTIVITY_LIMIT,
  };
}
