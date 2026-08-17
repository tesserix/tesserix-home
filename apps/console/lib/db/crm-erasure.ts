import { tesserixTx } from "./tesserix";

/**
 * The two data operations behind a DPDP request, per #213 / #154.
 *
 * These answer two distinct requests and must not be collapsed into one
 * "delete the business" action:
 *
 * - `eraseContact` answers "forget me". It overwrites the person's
 *   identifying data in place and KEEPS the row — the organisation, its
 *   opportunities and its activity log are untouched, because stage_change
 *   activities are the only record of when a stage was entered and deleting
 *   them would leave funnel measurement with holes it cannot explain.
 * - `deleteOrganisation` answers "this business should not exist here" (a
 *   bad import, the wrong company). It is a true cascade: the organisation,
 *   its contacts, its opportunities and its activities all go.
 *
 * Kept in its own file rather than crm-repo.ts (already past 1,500 lines) or
 * crm-writes.ts (the create path) — this is neither.
 */

export interface ErasedContact {
  contactId: string;
  organisationId: string;
  /** The name as it was, for the audit row only — never re-displayed. */
  previousName: string | null;
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
 * `source`, `sourced_at` and `lawful_basis` are left untouched: they record
 * *why we held the data*, are not identifying on their own, and are the
 * evidence that the erasure was owed. Erasing them would destroy the audit
 * trail of the erasure's own justification.
 *
 * Idempotent — erasing an already-erased contact re-overwrites the same
 * (already-null) columns and is not an error, but MUST NOT move
 * `erased_at` forward. The date an erasure was actually performed is the
 * compliance-relevant fact: it is what evidences the request was honoured
 * inside the statutory window, and a second call is exactly what would
 * destroy it if `erased_at` were reset unconditionally. `updated_at` is
 * left moving on every call — that column means something else (last
 * write, full stop).
 */
export async function eraseContact(contactId: string): Promise<ErasedContact | null> {
  return tesserixTx(async (query) => {
    // `old` is a plain CTE (its body is a SELECT, not itself a write) that
    // captures the pre-update row so the UPDATE's RETURNING can hand back
    // the name as it was, without a second round-trip. Plain
    // `UPDATE ... RETURNING` only ever sees the post-image.
    const rows = await query<{
      id: string;
      organisation_id: string;
      previous_name: string | null;
    }>(
      `WITH old AS (
         SELECT id, name FROM crm_contacts WHERE id = $1
       )
       UPDATE crm_contacts c
          SET name = '[erased]',
              email = NULL,
              phone = NULL,
              instagram_handle = NULL,
              biography = NULL,
              followers_count = NULL,
              posts_count = NULL,
              erased_at = COALESCE(c.erased_at, now()),
              updated_at = now()
         FROM old
        WHERE c.id = old.id
        RETURNING c.id, c.organisation_id, old.name AS previous_name`,
      [contactId],
    );

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      contactId: row.id,
      organisationId: row.organisation_id,
      previousName: row.previous_name,
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
