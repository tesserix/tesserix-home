import { tesserixTx } from "./tesserix";
import {
  ErasureHashKeyMissingError,
  erasureHashes,
  isErasureHashKeyConfigured,
} from "./crm-erasure-hash";

/**
 * The two data operations behind a DPDP request, per #213 / #154.
 *
 * These answer two distinct requests and must not be collapsed into one
 * "delete the business" action:
 *
 * - `eraseContact` answers "forget me". It overwrites the person's
 *   identifying data in place and KEEPS the row — the organisation, its
 *   opportunities and its activity log are not destroyed, because stage_change
 *   activities are the only record of when a stage was entered and deleting
 *   them would leave funnel measurement with holes it cannot explain. It does
 *   ANNOTATE the handful of activity rows a human authored, flagging them for
 *   review; nothing in the log is deleted or rewritten. See "# The residual"
 *   on `eraseContact` for why annotating and destroying are different answers.
 * - `deleteOrganisation` answers "this business should not exist here" (a
 *   bad import, the wrong company). It is a true cascade: the organisation,
 *   its contacts, its opportunities and its activities all go.
 *
 * `deleteOpportunity` (#251) is a third operation and answers neither of
 * those. It is not a DPDP request at all: it removes a MIS-CLICKED DEAL from
 * a business we still hold and still intend to sell to. It lives here because
 * this is the file where deleting CRM records is done, and it deletes the
 * least of anything here — one opportunity row, with the organisation, its
 * contacts, its other deals and its whole activity log left standing.
 *
 * Kept in its own file rather than crm-repo.ts (already past 1,500 lines) or
 * crm-writes.ts (the create path) — this is neither.
 */

export interface ErasedContact {
  contactId: string;
  organisationId: string;
  /**
   * The name as it was, deliberately RETAINED in the `console_audit_log`
   * row the caller writes — and readable there by any operator who opens the
   * audit log viewer (`audit-repo.ts` selects `target` back).
   *
   * That retention is the point, not an oversight: the audit row is the DPDP
   * evidence that an erasure was performed, and evidence that cannot say
   * whose data was erased evidences nothing. What the caller must not do is
   * echo it back in the action's RETURN VALUE — that would put the name
   * straight back onto the record screen the erasure was just performed on.
   * Retained in the audit trail and kept out of the response are two
   * different things.
   */
  previousName: string | null;
  /**
   * The erasure timestamp as it stood BEFORE this call, not after —
   * `erased_at` is COALESCE'd (see below) so the post-image is the same
   * non-null value on every call once a contact has been erased once, which
   * would make it useless for telling a genuine erasure apart from a
   * repeat. `null` here means this call is the one that erased the contact;
   * a real timestamp means it was already erased and this call was a no-op.
   * The caller needs this distinction to keep `crm.contact.erase` audit rows
   * honest: a second click must not read as a second erasure.
   */
  erasedAt: string | null;
  /**
   * The `crm_activities` rows this erasure could NOT finish — outreach the
   * operator EDITED before sending, whose `body` therefore holds text a human
   * actually wrote and may still quote the biography this call just destroyed.
   *
   * NOT a diagnostic. This is the unfinished half of a legal obligation, and
   * the field exists so a caller cannot complete an erasure without being
   * handed the list of what is still outstanding. See `eraseContact`'s
   * "# The residual" section for why these rows are surfaced rather than
   * emptied, and why the same list is ALSO stamped onto the rows themselves
   * rather than only returned here.
   *
   * Ids only, never the text: this value flows out to an action's return and
   * on towards a screen, and the whole point of the rows is that they contain
   * something that should not be reproduced anywhere new.
   *
   * Reports the same set on a repeat erasure — it is "what is still pending",
   * not "what this call marked". A second click must not read as "nothing left
   * to do" (the mirror of `erasedAt`'s reason for being the pre-image).
   */
  activitiesPendingRedaction: string[];
}

/**
 * Overwrite a contact's personal columns in place and mark it erased.
 *
 * A single `UPDATE … RETURNING` inside `tesserixTx`: reading the previous
 * name in the same statement lets the audit row name who was erased without
 * a second round trip.
 *
 * `email` and `instagram_handle` are set to NULL, not a tombstone string.
 * `crm_contacts_email_lower_uq` is a partial unique index (WHERE email IS
 * NOT NULL) — nulling releases the address so a legitimate future contact at
 * the same business can use it; a tombstone string would squat the index and
 * block them.
 *
 * `metadata` — the raw-scrape bag added by migration 0027 — is emptied in
 * THIS statement, not by a follow-up write. It is the one column on the
 * table whose contents nobody has enumerated (that is what it is for), so it
 * is the one place personal data could survive an erasure request unnoticed:
 * a scrape's `full_name`, `profile_pic_url` or `business_email` are as
 * identifying as the columns above them. A second statement would be a
 * second thing that can fail, be skipped, or be dropped out of the
 * transaction by a future caller. Emptied rather than nulled, because the
 * column is `NOT NULL DEFAULT '{}'`: one spelling of "nothing retained", so
 * no reader has to distinguish two.
 *
 * `source`, `sourced_at` and `lawful_basis` are left untouched: they record
 * *why we held the data*, are not identifying on their own, and are the
 * evidence that the erasure was owed. Erasing them would destroy the audit
 * trail of the erasure's own justification.
 *
 * # The erasure register (#226)
 *
 * Before this, `eraseContact` was the whole of "forget me" and it did not
 * survive contact with the next CSV. Nulling `email` and `instagram_handle`
 * is exactly what makes `findMatchingOrganisationId` — which matches on those
 * two columns and nothing else — fail to recognise the person on re-import,
 * so `commitImport` created them again as a fresh organisation with a fresh
 * opportunity. The erasure was undone silently, by the ordinary operation of
 * the feature next door, and the new row said nothing about it. Migration
 * 0024's own header predicted this ("re-import would treat it as a fresh row
 * to enrich") and only the marker half ever shipped.
 *
 * So this transaction now also records a keyed HMAC of each identifier it is
 * about to destroy into `crm_erased_identifiers` (migration 0041), which
 * `previewImport`/`commitImport` check every row against. The pre-image comes
 * from the `old` CTE below — the values as they stood BEFORE this statement
 * nulled them — so the hash is of what was actually there, and the INSERT is
 * in the same transaction as the UPDATE, so either both land or neither does.
 * There is no window in which a contact is erased but unrecorded.
 *
 * `ON CONFLICT DO NOTHING`: erasing twice is idempotent for the same reason
 * `erased_at` is COALESCE'd, and in practice the second call has nothing to
 * insert anyway — the columns it would hash are already null.
 *
 * # It throws when CRM_ERASURE_HASH_KEY is unset, and that is the safe way
 *
 * `erasureHashes` raises `ErasureHashKeyMissingError` with no key, and this
 * function does not catch it: the transaction rolls back and the erasure
 * FAILS. An erasure that succeeded without recording its hashes would report
 * "forgotten" to an operator while quietly losing the ability to enforce
 * itself against the next import — the worst of the three outcomes, because
 * nobody would ever look at it again. A refused erasure is visible, and the
 * operator retries it once the variable is provisioned.
 *
 * The two halves cannot disagree about this. With no key, this throws, so no
 * hash is ever recorded, so `crm_erased_identifiers` is empty, so import has
 * nothing it could have missed — which is precisely the condition
 * `assertErasureCheckable` in `crm-repo.ts` tests before letting an import
 * run without a key. Key present: both halves work. Key absent: neither half
 * runs. There is no third state in which one half is enforcing and the other
 * is not.
 *
 * Idempotent — erasing an already-erased contact re-overwrites the same
 * (already-null) columns and is not an error, but MUST NOT move
 * `erased_at` forward. The date an erasure was actually performed is the
 * compliance-relevant fact: it is what evidences the request was honoured
 * inside the statutory window, and a second call is exactly what would
 * destroy it if `erased_at` were reset unconditionally. `updated_at` is
 * left moving on every call — that column means something else (last
 * write, full stop).
 *
 * # The residual this cannot destroy, and why it is surfaced rather than
 * # deleted (#507)
 *
 * The statement above reaches `crm_contacts` and nothing else. `crm_activities`
 * is deliberately out of its scope — see this module's header: `stage_change`
 * rows are the only record of when a stage was entered, and deleting them puts
 * holes in funnel measurement that nobody can later explain.
 *
 * That was harmless while every activity body was console-authored. It stopped
 * being harmless with the lead-template composer (#503): an operator who edits
 * one character of a rendered DM keeps the rest of it — `{{contact.biography}}`
 * included — and `crm-outreach.ts` stores that text in `body`, correctly,
 * because a log that refused to record what a human actually wrote would be
 * fiction. So a "forget me" request can complete while scraped biography text
 * sits in a table this function does not touch. Migration 0027's DPDP paragraph
 * names that situation "a compliance defect, not a feature".
 *
 * THE CHOICE MADE HERE IS TO SURFACE, NOT TO DESTROY, and the alternative was
 * weighed rather than dismissed:
 *
 * - AUTO-REDACTING the body would finish the job in one transaction and need
 *   nobody to remember anything. It was rejected on what it costs. The stored
 *   string is ONE string: the operator's own sentence and the quoted biography
 *   are interleaved in it, and nothing in the row says where one ends. Nulling
 *   `body` therefore does not redact the biography — it deletes the record of
 *   what a human said, to get at the part of it that was ours, and it does so
 *   irreversibly and without review. That record is itself evidence (of what
 *   outreach was actually performed, to whom, in whose words), so the automated
 *   version trades one compliance problem for a second one. A machine that
 *   cannot tell the two halves apart must not be the thing that decides.
 * - DOCUMENTING IT ONLY was rejected for the opposite reason. An erasure
 *   request is a legal obligation with a deadline. A control whose entire
 *   mechanism is "an operator remembers to run a query from a document" fails
 *   silently, leaves no trace of having failed, and is indistinguishable — from
 *   the outside, and from the database — from one that was honoured.
 *
 * So the residual is made STATE, not advice. In this same transaction each
 * outstanding row is stamped with `metadata.erasure_pending_review`, and the
 * ids come back in `activitiesPendingRedaction` for the caller to put in front
 * of a human. The stamp is what turns "someone must remember" into something
 * the database itself remembers: `WHERE metadata ? 'erasure_pending_review'`
 * answers "is any erasure unfinished, and since when" at any time, for anyone,
 * without having to know which erasures ever happened. A returned count alone
 * would have lived exactly as long as one HTTP response — an operator whose tab
 * crashed after the commit would be left with a completed erasure, an audit row
 * saying so, and no record anywhere that a step remained.
 *
 * Stamped, not moved to a queue table: the flag belongs ON the row a human has
 * to read and edit, so the work and the marker cannot drift apart, and so
 * redacting the row is what clears it rather than a second bookkeeping write
 * someone could forget in exactly the way this section exists to prevent.
 *
 * COALESCE'd for the same reason as `erased_at`: a repeat erasure keeps the
 * ORIGINAL review timestamp, because how long an obligation has been
 * outstanding is the compliance-relevant fact and a second click is precisely
 * what would reset it.
 *
 * SCOPE, STATED SO IT IS NOT MISREAD. This covers rows this console can
 * attribute to the erased contact: `contact_id = $1` AND `metadata.edited`.
 * Plain notes written through `logActivity` carry no `contact_id` at all (they
 * are organisation-scoped), so free text an operator typed about a person into
 * the ordinary activity log is NOT reachable from here and is not claimed to
 * be. That is a separate gap with a separate fix; pretending this statement
 * closed it would be worse than leaving it named. The runbook's erasure section
 * carries the manual step.
 */
export async function eraseContact(contactId: string): Promise<ErasedContact | null> {
  // Checked here as well as inside `erasureHashes` below, and the duplication
  // is deliberate. The one below is the guarantee — it is on the path that
  // actually produces the hashes, so it cannot be routed around. This one is
  // only so that a deployment missing the variable issues no statement at
  // all, rather than running the UPDATE and rolling it back: the outcome is
  // identical, but a write that never happens is easier to reason about than
  // one that happened and was undone, and it keeps a pointless round trip off
  // a `max: 2` pool.
  if (!isErasureHashKeyConfigured()) throw new ErasureHashKeyMissingError();

  return tesserixTx(async (query) => {
    // `old` is a plain CTE (its body is a SELECT, not itself a write) that
    // captures the pre-update row so the UPDATE's RETURNING can hand back
    // the name as it was, without a second round-trip. Plain
    // `UPDATE ... RETURNING` only ever sees the post-image.
    const rows = await query<{
      id: string;
      organisation_id: string;
      previous_name: string | null;
      previous_email: string | null;
      previous_instagram_handle: string | null;
      previous_erased_at: string | null;
    }>(
      `WITH old AS (
         SELECT id, name, email, instagram_handle, erased_at
           FROM crm_contacts WHERE id = $1
       )
       UPDATE crm_contacts c
          SET name = '[erased]',
              email = NULL,
              phone = NULL,
              instagram_handle = NULL,
              biography = NULL,
              followers_count = NULL,
              posts_count = NULL,
              metadata = '{}'::jsonb,
              erased_at = COALESCE(c.erased_at, now()),
              updated_at = now()
         FROM old
        WHERE c.id = old.id
        RETURNING c.id, c.organisation_id, old.name AS previous_name,
                  old.email AS previous_email,
                  old.instagram_handle AS previous_instagram_handle,
                  old.erased_at AS previous_erased_at`,
      [contactId],
    );

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];

    // The identifiers as they were a statement ago. Hashed and recorded here,
    // inside the same transaction, so the erasure and the thing that enforces
    // it are one atomic fact. Throws — and so aborts the erasure — when
    // CRM_ERASURE_HASH_KEY is unset; see the doc comment for why that is the
    // safe direction.
    const hashes = erasureHashes({
      email: row.previous_email,
      instagramHandle: row.previous_instagram_handle,
    });
    for (const identifierHash of hashes) {
      await query(
        `INSERT INTO crm_erased_identifiers (identifier_hash)
         VALUES ($1)
         ON CONFLICT (identifier_hash) DO NOTHING`,
        [identifierHash],
      );
    }

    // The residual (#507). Same transaction as the erasure for the same reason
    // the hashes are: an erasure and the record of what it left behind are one
    // fact, and a follow-up statement is a second thing that can fail, be
    // skipped, or be dropped out of the transaction by a future caller.
    //
    // `body IS NOT NULL` as well as `edited`, though `crm-outreach.ts` only
    // ever sets one with the other: this statement's output is a work list
    // handed to a human, and a row with nothing in `body` is nothing to redact.
    // Listing it would spend the one thing this control depends on — an
    // operator taking the list seriously — on an empty row.
    //
    // No `metadata ? 'erasure_pending_review'` filter. Returning only rows
    // this CALL marked would make the second click report an empty list, which
    // reads as "finished" at exactly the moment it is least true.
    const pending = await query<{ id: string }>(
      `UPDATE crm_activities
          SET metadata = metadata || jsonb_build_object(
                'erasure_pending_review',
                COALESCE(metadata->'erasure_pending_review', to_jsonb(now())))
        WHERE contact_id = $1
          AND metadata->>'edited' = 'true'
          AND body IS NOT NULL
        RETURNING id`,
      [contactId],
    );

    return {
      contactId: row.id,
      organisationId: row.organisation_id,
      previousName: row.previous_name,
      erasedAt: row.previous_erased_at,
      activitiesPendingRedaction: pending.map((activity) => activity.id),
    };
  });
}

export interface DeletedOrganisation {
  organisationId: string;
  name: string;
  contactsDeleted: number;
  opportunitiesDeleted: number;
}

/**
 * Delete an organisation and everything under it.
 *
 * Contacts and opportunities are deleted explicitly (not left to
 * `ON DELETE CASCADE` from the organisation delete), and the audit counts
 * are the number of rows each `DELETE ... RETURNING` actually returned —
 * not a `SELECT count(*)` taken beforehand. A count-then-delete would open a
 * window between the two statements: a contact committed by another session
 * in that window would still be removed by the cascade but never counted,
 * silently understating what was destroyed. These counts feed the audit row
 * for an irreversible action, and an audit row that *understates* the
 * damage is worse than no count at all — so what's counted must be exactly
 * what's deleted, in the same statement. `ON DELETE CASCADE` on
 * `crm_activities.organisation_id` still does its job for the activity log,
 * which isn't counted.
 */
export async function deleteOrganisation(
  organisationId: string,
): Promise<DeletedOrganisation | null> {
  return tesserixTx(async (query) => {
    const orgRows = await query<{ id: string; name: string }>(
      `SELECT id, name FROM crm_organisations WHERE id = $1`,
      [organisationId],
    );
    if (orgRows.length === 0) {
      return null;
    }

    const deletedContacts = await query<{ id: string }>(
      `DELETE FROM crm_contacts WHERE organisation_id = $1 RETURNING id`,
      [organisationId],
    );
    const deletedOpportunities = await query<{ id: string }>(
      `DELETE FROM crm_opportunities WHERE organisation_id = $1 RETURNING id`,
      [organisationId],
    );

    // Everything under the organisation is already gone; this delete's own
    // cascade only has crm_activities left to remove.
    await query(`DELETE FROM crm_organisations WHERE id = $1`, [organisationId]);

    return {
      organisationId: orgRows[0].id,
      name: orgRows[0].name,
      contactsDeleted: deletedContacts.length,
      opportunitiesDeleted: deletedOpportunities.length,
    };
  });
}

export interface DeletedOpportunity {
  opportunityId: string;
  organisationId: string;
  /**
   * The organisation's name and the deal's product, read BEFORE the delete
   * and returned so the caller's audit row can name what was destroyed.
   *
   * `crm_opportunities` has no name of its own — a deal is identified by
   * whose it was and what it was for — so an audit row carrying only the
   * opportunity id names a row that, by the time anyone reads the row, no
   * longer exists to be joined back to. `product` is genuinely nullable
   * (null until `qualified`, and null is exactly the shape of the
   * mis-clicked duplicate this delete exists to remove), so the caller must
   * render the absence rather than assume a value.
   */
  organisationName: string;
  product: string | null;
  /**
   * How many `crm_activities` rows stopped being scoped to this deal.
   *
   * DETACHED, not deleted: migration 0048 made
   * `crm_activities.opportunity_id` `ON DELETE SET NULL`, so every one of
   * these rows survives on the organisation timeline with a null
   * `opportunity_id`. The count exists so the audit row can say how much
   * history the delete moved, which is the fact an operator asking "what did
   * that button do to my DMs?" needs.
   */
  activitiesDetached: number;
}

/**
 * Delete one opportunity, keeping everything else.
 *
 * The disposal a mis-clicked duplicate deal has never had (#251). Marking it
 * `lost` was the only alternative, and that requires inventing a
 * `lost_reason` and then pollutes every close-rate and loss-analysis number
 * computed off the stage — a mis-click becomes indistinguishable from a real
 * loss, permanently.
 *
 * Deliberately NOT a cascade, unlike `deleteOrganisation` above: the
 * organisation, its contacts, its other opportunities and its activity log
 * are all untouched. The activities that WERE scoped to this deal are
 * detached rather than deleted, and that is left entirely to 0048's
 * `ON DELETE SET NULL` — no `UPDATE crm_activities` here. Doing it by hand
 * would work, but it would also mean the shipped code no longer depends on
 * the constraint, so a future revert of 0048 would silently start destroying
 * history again with every test still green.
 *
 * Two statements rather than one `DELETE ... RETURNING`: the organisation
 * name, the product and the activity count all have to be read while the row
 * and its children still exist.
 */
export async function deleteOpportunity(
  opportunityId: string,
): Promise<DeletedOpportunity | null> {
  return tesserixTx(async (query) => {
    const rows = await query<{
      id: string;
      organisation_id: string;
      product: string | null;
      organisation_name: string;
    }>(
      // `FOR UPDATE OF o` — the opportunity row only, not the organisation
      // row the join brings in, which this call has no business locking.
      //
      // It is what makes the count below exact. Inserting a
      // `crm_activities` row that references this opportunity makes Postgres
      // take a FOR KEY SHARE lock on the referenced row, and FOR KEY SHARE
      // conflicts with FOR UPDATE — so between the count and the delete, no
      // other session can add an activity to this deal. Without it the FK
      // would still detach such a row (nothing is lost either way), but it
      // would go uncounted, and an audit row for an irreversible action that
      // UNDERSTATES what it moved is worse than one with no count at all —
      // the same reasoning `deleteOrganisation` gives for counting from
      // `RETURNING` rather than from a separate SELECT.
      `SELECT o.id, o.organisation_id, o.product, org.name AS organisation_name
         FROM crm_opportunities o
         JOIN crm_organisations org ON org.id = o.organisation_id
        WHERE o.id = $1
        FOR UPDATE OF o`,
      [opportunityId],
    );
    if (rows.length === 0) {
      return null;
    }

    const [detached] = await query<{ count: number }>(
      // `::int` because pg returns bigint as a string, and this count is
      // handed to `AuditSummary`, which rejects anything that is not a
      // number rather than coercing it.
      `SELECT count(*)::int AS count FROM crm_activities WHERE opportunity_id = $1`,
      [opportunityId],
    );

    await query(`DELETE FROM crm_opportunities WHERE id = $1`, [opportunityId]);

    return {
      opportunityId: rows[0].id,
      organisationId: rows[0].organisation_id,
      organisationName: rows[0].organisation_name,
      product: rows[0].product,
      activitiesDetached: detached.count,
    };
  });
}
