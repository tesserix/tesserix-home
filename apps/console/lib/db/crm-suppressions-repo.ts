/**
 * The CRM do-not-contact list.
 *
 * Split out of `crm-repo.ts` (#566); `crm-repo.ts` re-exports everything here,
 * so nothing importing `@/lib/db/crm-repo` had to change.
 */
import { tesserixQuery, type TxQuery } from "./tesserix";
import { normalizeContactEmail, normalizeInstagramHandle } from "./crm-identity";
import { toIsoRequired } from "./crm-row";

/**
 * The do-not-contact list (migration 0019's `crm_suppressions`).
 *
 * Ships before Task 8 (import): a suppression added after the first import
 * cannot retroactively protect anyone it should have. Matching is
 * case-insensitive on both keys — the table's two partial UNIQUE indexes are
 * on `lower(email)`/`lower(instagram_handle)`, so a lookup that compared the
 * raw value would miss a match that differs only in case, and then collide
 * on the very next insert.
 *
 * Ruling 18: Instagram handles also need to be format-insensitive, not just
 * case-insensitive. A handle is written with or without a leading `@`
 * depending on where it came from (the form's own placeholder is
 * `@bondibaker`; an imported row will plausibly carry `bondibaker`), and
 * `lower()` alone does not bridge that gap — a suppressed person keyed one
 * way would silently fail to match a lookup keyed the other, which is
 * exactly the failure this feature exists to prevent. `normalizeInstagramHandle`
 * strips a leading `@` and lowercases, and runs on both the write path
 * (`addSuppression`) and the read path (`isSuppressed`), so the stored and
 * the queried form can never disagree about which is canonical.
 *
 * Ruling 17: no `auditedOperation` in this module. It briefly lived on
 * `removeSuppression` directly, on the theory that removal — the
 * consequential direction, since it is what re-exposes someone who asked not
 * to be contacted — needed its own guarantee. It didn't: the capability gate
 * has to live at the action layer regardless (a repo function has no session
 * to check), so auditing here too would just put the same guarantee in two
 * places that could drift, which is what happened. `apps/console/lib/crm-write.ts`'s
 * `withCrmWrite` is the one place both CRM action surfaces audit through now.
 */

export interface SuppressionRow {
  id: string;
  email: string | null;
  instagramHandle: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
}

interface RawSuppressionRow {
  id: string;
  email: string | null;
  instagram_handle: string | null;
  reason: string;
  created_by: string;
  created_at: unknown;
}

function toSuppressionRow(row: RawSuppressionRow): SuppressionRow {
  return {
    id: row.id,
    email: row.email,
    instagramHandle: row.instagram_handle,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: toIsoRequired(row.created_at),
  };
}

/** Both normalisers now live in `crm-identity.ts` and are re-exported here so
 *  `crm-writes.ts` (#236) keeps its existing import path.
 *
 *  They moved for #226: `crm-erasure-hash.ts` has to derive its HMAC input
 *  with the SAME functions `findMatchingOrganisationId` matches with, and
 *  importing them from this module would have made this module and that one
 *  import each other. See `crm-identity.ts` for why one definition — not two
 *  that agree — is the thing that matters here. */
export { normalizeInstagramHandle };

export interface SuppressionCheck {
  email?: string;
  instagramHandle?: string;
}

/**
 * Whether either key is already on the list. `false` — not a thrown error —
 * when neither key is supplied: there is nothing to check, and the caller
 * (an import row with neither an email nor a handle) should not have to
 * special-case that itself.
 *
 * Ruling 23: `query` defaults to `tesserixQuery` (its own pooled connection)
 * for every existing caller, but `commitImport` passes its transaction's own
 * scoped query instead. That matters for two reasons, not one:
 *
 * (1) Correctness — a lookup on a separate connection cannot see the
 *     transaction's own uncommitted inserts. Two CSV rows sharing an email
 *     is ordinary content for a scraped leads sheet, not an edge case: row
 *     1's `crm_contacts` insert must be visible to row 2's dedup check, or
 *     row 2 attempts a second insert and trips `crm_contacts_email_lower_uq`
 *     — inside the transaction, rolling the *entire batch* back after a
 *     preview that promised N creations.
 * (2) Connections — `commitImport` already holds one pooled client for its
 *     transaction; acquiring a second one per row, twice, against a pool of
 *     `max: 2` (`tesserix.ts`), is how two operators committing at once
 *     deadlock each other out of the pool entirely.
 */
export async function isSuppressed(
  input: SuppressionCheck,
  query: TxQuery = tesserixQuery,
): Promise<boolean> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.email) {
    // Canonicalised to match the write path (`addSuppression`) and the
    // database trigger (migration 0022), both of which store
    // `trim(lower(email))`. Before Ruling 19 neither side trimmed, so an
    // untrimmed lookup still matched an untrimmed stored value; now that the
    // stored form is always canonical, a lookup that skips the trim can miss
    // a real match on nothing but leading/trailing whitespace — exactly the
    // input a CSV import (Task 8) carries as a matter of course.
    params.push(normalizeContactEmail(input.email));
    clauses.push(`lower(email) = lower($${params.length})`);
  }
  if (input.instagramHandle) {
    params.push(normalizeInstagramHandle(input.instagramHandle));
    clauses.push(`lower(instagram_handle) = lower($${params.length})`);
  }
  if (clauses.length === 0) return false;

  const rows = await query<{ id: string }>(
    `SELECT id FROM crm_suppressions WHERE ${clauses.join(" OR ")} LIMIT 1`,
    params,
  );
  return rows.length > 0;
}

export interface AddSuppressionInput {
  email?: string;
  instagramHandle?: string;
  reason: string;
  actor: string;
}

/**
 * Add someone to the do-not-contact list. Not audited — adding is the safe
 * direction (see the module comment), and every row already carries
 * `created_by`/`created_at`, which is its own record of who added it and
 * when.
 *
 * Validated here, before the database is touched, so a caller that forgot
 * both keys gets a clear error rather than tripping `crm_suppression_has_a_key`
 * as a raw constraint violation.
 */
export async function addSuppression(input: AddSuppressionInput): Promise<SuppressionRow> {
  if (!input.email && !input.instagramHandle) {
    throw new Error("addSuppression: requires an email or an instagram handle");
  }
  // Trimmed at the boundary, same as `normalizeInstagramHandle` does for the
  // handle — the database trigger (migration 0022, Ruling 19) is the
  // invariant, this is belt-and-braces so the common case never round-trips
  // through it to look normal.
  const email = input.email ? normalizeContactEmail(input.email) : null;
  const rows = await tesserixQuery<RawSuppressionRow>(
    `INSERT INTO crm_suppressions (email, instagram_handle, reason, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, instagram_handle, reason, created_by, created_at`,
    [
      email,
      input.instagramHandle ? normalizeInstagramHandle(input.instagramHandle) : null,
      input.reason,
      input.actor,
    ],
  );
  return toSuppressionRow(rows[0]);
}

/** Every suppression, newest first — the list is small enough that a plain
 *  unpaginated read is honest about what it's for: a short, human-reviewed
 *  do-not-contact register, not a growing operational table. */
export async function listSuppressions(): Promise<SuppressionRow[]> {
  const rows = await tesserixQuery<RawSuppressionRow>(
    `SELECT id, email, instagram_handle, reason, created_by, created_at
       FROM crm_suppressions
      ORDER BY created_at DESC`,
  );
  return rows.map(toSuppressionRow);
}

/** What `removeSuppression`'s DELETE reports back — enough for the caller's
 *  `describe` to name both the real outcome (Important 3: `rows.length`) and
 *  the accountable identifier (Ruling 20: the email/handle, not the uuid it
 *  was looked up by — see `suppressions/actions.ts`). */
export interface RemovedSuppression {
  id: string;
  email: string | null;
  instagramHandle: string | null;
}

/**
 * Take someone off the do-not-contact list.
 *
 * Plain data access (Ruling 17) — the action layer (`suppressions/actions.ts`,
 * via `withCrmWrite`) is what audits this, since accountability for a CRM
 * write lives at the layer that already has a session to check. `RETURNING`
 * is what lets the caller's `describe` report the real outcome —
 * `{ removed: rows.length }` — rather than assuming a match: `DELETE …
 * WHERE id = $1` on an id that no longer exists succeeds with zero rows,
 * and an audit row claiming `{ removed: 1 }` for that would be recording a
 * removal that never happened. `email`/`instagram_handle` are returned
 * alongside `id` for the same reason: the caller only has the uuid it
 * looked the row up by, and the identifier worth putting in the audit
 * trail (Ruling 20) is only knowable once the row is in hand.
 */
export async function removeSuppression(id: string): Promise<RemovedSuppression[]> {
  const rows = await tesserixQuery<{
    id: string;
    email: string | null;
    instagram_handle: string | null;
  }>(
    `DELETE FROM crm_suppressions WHERE id = $1 RETURNING id, email, instagram_handle`,
    [id],
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    instagramHandle: row.instagram_handle,
  }));
}
