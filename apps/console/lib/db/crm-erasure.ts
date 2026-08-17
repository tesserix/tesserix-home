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
 * Idempotent — erasing an already-erased contact just re-overwrites the same
 * (already-null) columns; it is not an error.
 */
export async function eraseContact(contactId: string): Promise<ErasedContact | null> {
  return tesserixTx(async (query) => {
    // A data-modifying CTE: `old` captures the pre-update row so the UPDATE's
    // RETURNING can hand back the name as it was, without a second
    // round-trip. Plain `UPDATE ... RETURNING` only ever sees the post-image.
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
              erased_at = now(),
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
 * Contacts and opportunities are counted before the delete, inside the same
 * transaction, so the audit row can report what was removed — a delete that
 * reports only "ok" gives the audit log nothing to show for an irreversible
 * action. `ON DELETE CASCADE` on `crm_contacts.organisation_id`,
 * `crm_opportunities.organisation_id` and `crm_activities.organisation_id`
 * does the actual removal of everything but the organisation row itself.
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

    const contactRows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM crm_contacts WHERE organisation_id = $1`,
      [organisationId],
    );
    const opportunityRows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM crm_opportunities WHERE organisation_id = $1`,
      [organisationId],
    );

    await query(`DELETE FROM crm_organisations WHERE id = $1`, [organisationId]);

    return {
      organisationId: orgRows[0].id,
      name: orgRows[0].name,
      contactsDeleted: contactRows[0].n,
      opportunitiesDeleted: opportunityRows[0].n,
    };
  });
}
