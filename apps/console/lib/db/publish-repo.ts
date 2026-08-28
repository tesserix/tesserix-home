// `server-only` for the same reason `./tesserix` and `plan-catalog-repo.ts`
// carry it: this module reaches `pg` through `tesserixTx`, and a client
// component that reaches it must fail the build with the import chain named
// rather than `Can't resolve 'net'` from inside the driver.
import "server-only";

import type { StripeMode } from "@/lib/billing/stripe-read";
import { tesserixTx } from "./tesserix";

/**
 * The draft lifecycle: create a working copy of a mode's published catalog,
 * discard it, or find the one currently in progress.
 *
 * This is Plan 2's Task 1 — the foundation the publish plan (Task 3) and the
 * publish transaction (Task 4) both sit on top of. Nothing here talks to
 * Stripe; every function is a `plan_catalog_revisions` / `plan_catalog_prices`
 * / `plan_catalog_amounts` write, scoped to `tesserixTx`.
 *
 * # Why a draft has no `mode` of its own
 *
 * A draft is a revision like any other — `plan_catalog_revisions` carries no
 * `mode` column, and neither does this module's notion of "the draft".
 * `createDraftFrom(mode, ...)` records what mode it was copied FROM via
 * `based_on_revision_id`, but which mode(s) it might later be published TO is
 * a decision Task 3/4 make, not one this module can see yet. `currentDraft`
 * therefore answers "is there a draft" globally, not "is there a draft for
 * live" — which is also why at most one may exist at a time (see below):
 * a second concurrent draft is not "a draft for a different mode", it is the
 * same ambiguity the design doc calls out for two operators sharing one
 * catalog.
 *
 * # At most one draft — enforced by a lock, not by the schema
 *
 * `plan_catalog_revisions` has no state column: `id`, `note`, `created_by`,
 * `created_at`, `based_on_revision_id`, nothing else. "Is this revision a
 * draft" is a cross-table condition — "no un-superseded row in
 * `plan_catalog_publications` names it" — and a partial unique index cannot
 * reference another table, so no index can express "at most one draft"
 * however this table is shaped. (An earlier version of this task's brief
 * claimed `0035` already had such an index; it does not, and the design
 * doc's §3.4 — "it is one partial index; spend it" — is wrong about the
 * mechanism, not just premature.)
 *
 * `0035` hit the identical wall for "exactly one published" and wrote down
 * the answer this module follows:
 *
 * > A CEILING, never a floor. Postgres cannot express "at least one", so
 * > "exactly one published" is a property of the publish TRANSACTION
 * > (retire then promote, under an advisory lock on the mode), not of this
 * > schema. Claiming otherwise would be claiming more than is enforced.
 *
 * `createDraftFrom` below takes `pg_advisory_xact_lock` on a fixed key before
 * checking for an existing draft, exactly the same shape. What that
 * guarantees, precisely: the check-then-insert is serialised, so two
 * concurrent `createDraftFrom` calls cannot both observe "no draft" and both
 * insert one — which is the design doc's own failure mode, "two operators,
 * two drafts, one silently lost." What it does NOT guarantee: nothing stops
 * a draft-shaped row from appearing by any path that does not go through
 * this function — there is no schema constraint backing the invariant, only
 * this function's discipline. `currentDraft` (below) is written accordingly:
 * it tolerates finding more than one unpublished revision rather than
 * throwing on data it can still legally encounter.
 */

/** A revision counts as "the draft" once it has never been published — not
 *  once, ever, to either mode. A revision that WAS live and was later
 *  superseded is history, not a draft; only `NOT EXISTS` against
 *  `plan_catalog_publications` at all (not `superseded_at IS NULL`) draws
 *  that line correctly. */
const UNPUBLISHED_REVISION = `
  NOT EXISTS (
    SELECT 1 FROM plan_catalog_publications pub WHERE pub.revision_id = r.id
  )
`;

/**
 * Start a draft for `mode`, copying its currently published revision.
 *
 * # One transaction, not three statements
 *
 * A revision row committed with no prices would diff as "archive
 * everything" the moment anything reads it — so the revision, its prices,
 * and their amounts are one `tesserixTx`, or none of them land. See the
 * "creates the revision and its rows in ONE transaction" test, which forces
 * a failure on the price copy and asserts the revision insert did not
 * survive it either.
 *
 * # The advisory lock, and why it is `_xact`
 *
 * `pg_advisory_xact_lock` (the transaction-scoped variant, not
 * `pg_advisory_lock`) is held for exactly this transaction's lifetime and
 * released automatically on COMMIT or ROLLBACK — there is no matching
 * `pg_advisory_unlock` call to forget, and a crash mid-transaction cannot
 * leak the lock past the connection's own cleanup. The key is a fixed
 * constant (`hashtext('plan_catalog_draft')`, folded into the two-int form
 * so the key is legible in `pg_locks` rather than an opaque bigint) — every
 * caller of `createDraftFrom`, for every mode, contends for the SAME lock,
 * because "at most one draft" is a global invariant, not a per-mode one (see
 * this module's top comment).
 *
 * Taken and checked BEFORE the "already has a draft" read below: the lock is
 * what makes that read-then-decide safe against a second concurrent caller
 * doing the identical thing a moment later on a different connection.
 *
 * # Reading the live publication INSIDE the transaction
 *
 * `readLivePublication` in `plan-catalog-repo.ts` answers the identical
 * question through `tesserixQuery`, which is deliberately not used here —
 * the pool is not the transaction's client, so a read through it would not
 * see this transaction's own writes and would not share its snapshot. The
 * query below is the same `WHERE` restated on the transaction's own
 * connection, not a second implementation of the join.
 *
 * # `source` travels with every row, never assumed
 *
 * The copy selects `source` off each existing row rather than writing a
 * literal into the INSERT — `UNIQUE (revision_id, source, lookup_key)`
 * (0035) means a hardcoded source would silently relabel a second product's
 * prices as the first one's the moment a second source exists. This module
 * therefore never writes `"mark8ly"` (or any source literal) at all — see
 * the test file for where `SINGLE_SOURCE` (`source-policy.ts`) is used
 * instead, in fixtures that need to name today's one source; #393 removed
 * the last four inline `"mark8ly"` strings and this must not add a fifth.
 *
 * # A never-published mode is refused, not silently emptied
 *
 * `live` reads as `not_bootstrapped` until it is first published (see
 * `plan-catalog-repo.ts`'s `readLivePublication` doc comment) — that is the
 * normal starting state, not an error. But a DRAFT of that state is
 * different: an empty draft published later would diff as "archive
 * everything" against a mode that, by the time someone gets around to
 * publishing, may already hold prices. Refusing here, loudly, is cheaper
 * than a plan that discovers the same problem after an operator has already
 * spent time editing.
 */
export async function createDraftFrom(mode: StripeMode, createdBy: string): Promise<string> {
  return tesserixTx(async (query) => {
    // Serialises every `createDraftFrom` call, across every mode, against
    // every other one — see this function's doc comment on why the key is
    // fixed and shared rather than derived from `mode`.
    await query(`SELECT pg_advisory_xact_lock(0, hashtext('plan_catalog_draft'))`);

    const existingDraftRows = await query<{ id: string }>(
      `SELECT r.id
         FROM plan_catalog_revisions r
        WHERE ${UNPUBLISHED_REVISION}
        ORDER BY r.created_at DESC
        LIMIT 1`,
    );
    const existingDraft = existingDraftRows[0];
    if (existingDraft) {
      throw new Error(
        `createDraftFrom: a draft already exists (revision ${existingDraft.id}) — discard it before starting another`,
      );
    }

    const liveRows = await query<{ revision_id: string }>(
      `SELECT pub.revision_id
         FROM plan_catalog_publications pub
        WHERE pub.mode = $1 AND pub.superseded_at IS NULL`,
      [mode],
    );
    const live = liveRows[0];
    if (!live) {
      throw new Error(
        `createDraftFrom: ${mode} has no published revision to base a draft on`,
      );
    }
    const basedOn = live.revision_id;

    const revisionRows = await query<{ id: string }>(
      `INSERT INTO plan_catalog_revisions (created_by, based_on_revision_id)
       VALUES ($1, $2)
       RETURNING id`,
      [createdBy, basedOn],
    );
    const draftId = revisionRows[0].id;

    await query(
      `INSERT INTO plan_catalog_prices (revision_id, source, lookup_key, plan, period, tier)
       SELECT $1, source, lookup_key, plan, period, tier
         FROM plan_catalog_prices
        WHERE revision_id = $2`,
      [draftId, basedOn],
    );

    // Joined back by `(source, lookup_key)` rather than by the old price id
    // directly: the new rows have new ids (0035's `revision_id` is part of
    // their uniqueness, not a copy of the ancestor's), so this is how a copied
    // amount finds the copied price it belongs to within the SAME statement.
    await query(
      `INSERT INTO plan_catalog_amounts (price_id, currency, unit_amount_minor, tax_behavior)
       SELECT np.id, a.currency, a.unit_amount_minor, a.tax_behavior
         FROM plan_catalog_amounts a
         JOIN plan_catalog_prices op ON op.id = a.price_id
         JOIN plan_catalog_prices np
           ON np.revision_id = $1 AND np.source = op.source AND np.lookup_key = op.lookup_key
        WHERE op.revision_id = $2`,
      [draftId, basedOn],
    );

    return draftId;
  });
}

/**
 * Discard a draft, and everything copied into it.
 *
 * # Deleting the revision is enough
 *
 * `plan_catalog_prices.revision_id` cascades (0035), and
 * `plan_catalog_amounts.price_id` cascades (0032) — so one `DELETE` on
 * `plan_catalog_revisions` removes the draft's prices and their amounts with
 * it. No separate cleanup statement to keep in sync with the schema.
 *
 * # Refusing a published revision BEFORE the DELETE, not after
 *
 * `plan_catalog_publications.revision_id` is `ON DELETE RESTRICT`
 * (0035) precisely so a published revision cannot be deleted out from under
 * the publication that names it — but letting that constraint be the only
 * guard means the caller sees whatever wording Postgres happens to raise for
 * a RESTRICT violation. This checks first and raises a message that says
 * WHICH mode the revision is published to, which is the answer an operator
 * actually needs before they can do anything about it.
 *
 * `superseded_at IS NULL` — a revision that WAS published and has since been
 * superseded is not what this guards against; the FK no longer references it
 * either, and 0035 draws that same line for `readLivePublication`.
 */
export async function discardDraft(revisionId: string): Promise<void> {
  return tesserixTx(async (query) => {
    const publishedRows = await query<{ mode: string }>(
      `SELECT pub.mode
         FROM plan_catalog_publications pub
        WHERE pub.revision_id = $1 AND pub.superseded_at IS NULL`,
      [revisionId],
    );
    const published = publishedRows[0];
    if (published) {
      throw new Error(
        `discardDraft: revision ${revisionId} is published to ${published.mode} and cannot be discarded`,
      );
    }

    await query(`DELETE FROM plan_catalog_revisions WHERE id = $1`, [revisionId]);
  });
}

/**
 * The draft in progress, if any.
 *
 * # No `mode` parameter — see this module's top comment
 *
 * A draft is not scoped to the mode it was copied from; it is a single
 * shared working copy, matched against the design doc's "at most one draft"
 * reasoning (two operators, two drafts, one silently lost).
 *
 * # "Most recent" is a fallback, not the invariant
 *
 * `createDraftFrom`'s advisory lock serialises *creation*, so two operators
 * cannot both create a draft at once — but that lock is the only thing
 * enforcing "at most one," and it only guards the one function that takes
 * it. Nothing in the schema backs the invariant (see the top-of-file
 * comment), so this read does not assume it holds: ordering by
 * `created_at DESC LIMIT 1` means that if a second unpublished revision is
 * ever found — created by a path this module doesn't control, or by a bug —
 * this answers with the newer one rather than throwing on an ambiguity nothing
 * here actually forbids. A read that throws on data it can still legally
 * encounter would be worse than one that answers.
 */
export async function currentDraft(): Promise<{ id: string; basedOn: string | null } | null> {
  return tesserixTx(async (query) => {
    const rows = await query<{ id: string; based_on_revision_id: string | null }>(
      `SELECT r.id, r.based_on_revision_id
         FROM plan_catalog_revisions r
        WHERE ${UNPUBLISHED_REVISION}
        ORDER BY r.created_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, basedOn: row.based_on_revision_id };
  });
}
