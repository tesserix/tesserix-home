// `server-only` for the same reason `./tesserix` and `plan-catalog-repo.ts`
// carry it: this module reaches `pg` through `tesserixTx`, and a client
// component that reaches it must fail the build with the import chain named
// rather than `Can't resolve 'net'` from inside the driver.
import "server-only";

import type { OperationKind } from "@/lib/billing/publish-plan";
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

/**
 * Set one (lookup_key, currency) cell's amount within a draft revision —
 * Task 3's write path (`setAmountAction`, `draft-editor.tsx`'s only caller),
 * the first function in this module that is not part of the draft lifecycle
 * or the publish log.
 *
 * # UPSERT, not UPDATE
 *
 * `createDraftFrom` copies every currency the ancestor published (0032's
 * `plan_catalog_amounts`), so editing an amount an operator can already see
 * hits the `DO UPDATE` branch. But that copy is not exhaustive forever — a
 * `ppp` row is single-currency by the catalog's own convention, and an
 * operator adding a currency that row does not carry yet is exactly the case
 * `add_currency_option` exists for in `publish-plan.ts`. A bare `UPDATE`
 * would silently affect zero rows for that case; `INSERT ... ON CONFLICT
 * (price_id, currency) DO UPDATE` (0032's own unique constraint on that pair)
 * handles both without the caller having to know which one it's in.
 *
 * # `tax_behavior` defaults to `unspecified` on INSERT only
 *
 * A cell that does not exist yet has no prior `tax_behavior` to preserve; a
 * cell that already exists keeps whatever it had — the `DO UPDATE` clause
 * below touches only `unit_amount_minor`. This function is the amount
 * editor, not a tax_behavior editor; that stays untouched here.
 *
 * # Scoped by (revision, source, lookup_key), not by `plan_catalog_prices.id`
 *
 * The caller knows `revisionId`, `lookupKey`, `currency` — the same
 * identifiers `readRevisionAmounts` reads by — not the internal price row
 * id, so this resolves the price itself rather than asking the caller to
 * look it up first. A `lookupKey` absent from this revision (a stale draft
 * reference, a typo) is refused loudly, before any write: an INSERT against
 * a price id that does not exist would otherwise violate the FK with a
 * message that does not say which key was wrong.
 */
export async function setDraftAmount(input: {
  revisionId: string;
  source: string;
  lookupKey: string;
  currency: string;
  unitAmountMinor: number;
}): Promise<void> {
  return tesserixTx(async (query) => {
    // CRITICAL, review 2026-08-28: without this check, `revisionId` reaching
    // here off a client-supplied action argument (`setAmountAction`) could
    // rewrite the amounts of a currently PUBLISHED revision — the rows the
    // parity comparator and every future plan diff read as the ANCESTOR.
    // That is silent corruption of the record of what was actually
    // published, not a mere UX gap. Same shape `discardDraft` above already
    // uses for the identical hazard: check first, refuse loudly, name which
    // mode it's published to — before any lookup or write, not caught after
    // the fact by a constraint that does not exist (0032 adds none).
    const publishedRows = await query<{ mode: string }>(
      `SELECT pub.mode
         FROM plan_catalog_publications pub
        WHERE pub.revision_id = $1 AND pub.superseded_at IS NULL`,
      [input.revisionId],
    );
    const published = publishedRows[0];
    if (published) {
      throw new Error(
        `setDraftAmount: revision ${input.revisionId} is published to ${published.mode} and cannot be edited`,
      );
    }

    const priceRows = await query<{ id: string }>(
      `SELECT id
         FROM plan_catalog_prices
        WHERE revision_id = $1 AND source = $2 AND lookup_key = $3`,
      [input.revisionId, input.source, input.lookupKey],
    );
    const price = priceRows[0];
    if (!price) {
      // Not "draft revision" — this function does not verify `revisionId`
      // IS the one open draft (see `currentDraft`'s own doc comment on why
      // "at most one draft" is enforced by discipline, not by the schema),
      // only that it is not published. Claiming "draft" here would be
      // claiming a check this function does not make.
      throw new Error(
        `setDraftAmount: "${input.lookupKey}" is not a price in revision ${input.revisionId}`,
      );
    }

    await query(
      `INSERT INTO plan_catalog_amounts (price_id, currency, unit_amount_minor, tax_behavior)
       VALUES ($1, $2, $3, 'unspecified')
       ON CONFLICT (price_id, currency)
       DO UPDATE SET unit_amount_minor = EXCLUDED.unit_amount_minor, updated_at = now()`,
      [price.id, input.currency, input.unitAmountMinor],
    );
  });
}

// ---------------------------------------------------------------------------
// Publish attempts and the operation log (Task 5, `0038_publish_operations.sql`)
//
// Everything below writes and reads `plan_catalog_publish_attempts` /
// `plan_catalog_publish_operations`. Task 6's executor is the only intended
// caller: it starts an attempt, writes an operation row BEFORE every Stripe
// call (write-ahead — see 0038's header), and completes that row once Stripe
// answers. Nothing here talks to Stripe or knows what a `PublishOperation`
// MEANS beyond its `kind` — this module stores the log, it does not execute
// the plan.
// ---------------------------------------------------------------------------

export type PublishAttemptOutcome = "succeeded" | "failed" | "aborted";

export interface PublishAttempt {
  readonly id: string;
  readonly revisionId: string;
  readonly mode: StripeMode;
  readonly fingerprint: string;
  readonly startedBy: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: PublishAttemptOutcome | null;
}

function mapAttemptRow(row: {
  id: string;
  revision_id: string;
  mode: string;
  fingerprint: string;
  started_by: string;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
}): PublishAttempt {
  return {
    id: row.id,
    revisionId: row.revision_id,
    mode: row.mode as StripeMode,
    fingerprint: row.fingerprint,
    startedBy: row.started_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome as PublishAttemptOutcome | null,
  };
}

/**
 * Open a new publish attempt. One row, written once — `finishPublishAttempt`
 * below is the only function that ever updates it again.
 *
 * `fingerprint` is the plan's own fingerprint (`PublishPlan.fingerprint`,
 * `publish-plan.ts`), recorded so the executor's re-observe-and-compare step
 * (Task 6) has something durable to compare against even if the process that
 * started the attempt is not the one that resumes it.
 *
 * # At most one OPEN attempt per mode — enforced by a lock, not by the schema
 *
 * F3 (whole-branch fix wave, 2026-08-28). Before this fix, nothing stopped
 * two concurrent attempts for the same mode: `UNIQUE (idempotency_key)`
 * (0038) protects one attempt's own Stripe calls, but keys fold in
 * `attemptId`, so a second attempt mints an entirely different key set. Both
 * attempts re-observe stale state and both can create — for a
 * `replace_price` that is two new Prices, the lookup key moving to whichever
 * lands second, and the LOSER's Price left `active: true` with no lookup
 * key, which the parity comparator structurally cannot see (spec §9.2).
 *
 * The same shape `createDraftFrom` already uses for the identically-shaped
 * "at most one X" problem: `pg_advisory_xact_lock`, taken BEFORE the
 * check-then-insert, so two concurrent callers cannot both observe "no open
 * attempt" and both insert one. Two differences from `createDraftFrom`'s
 * lock, both deliberate:
 *
 *   - SCOPED PER MODE, not global. A draft is a single shared working copy
 *     (see this module's top comment on why ITS lock is one fixed key for
 *     every mode) — an open publish attempt is not; `test` and `live`
 *     publish independently and an open `test` attempt has no business
 *     blocking a `live` one. The lock key folds in `hashtext(mode)` for
 *     exactly this reason.
 *   - A DIFFERENT first component (`1`, not `createDraftFrom`'s `0`) so the
 *     two invariants never collide in `pg_locks` despite both being
 *     `pg_advisory_xact_lock` calls against this same database.
 *
 * # A CEILING, never a floor — 0035's own words, restated here on purpose
 *
 * Exactly like 0035's `plan_catalog_publications_one_live_per_mode` note:
 * Postgres cannot express "at most one open row" for THIS shape either (a
 * partial unique index on `outcome IS NULL` would work for a boolean-ish
 * state, but nothing stops a second `INSERT` racing this function's own
 * check outside of the lock this function takes). This function SERIALISES
 * ITSELF — every call, for every mode, that goes through
 * `startPublishAttempt` — and enforces nothing beyond that. There is no
 * schema constraint backing the invariant (0038 has none), so a row inserted
 * by any path that does not go through this function is not caught by
 * anything here. That is a narrower guarantee than "the schema forbids two
 * open attempts", and claiming the wider one would be claiming more than is
 * enforced.
 */
export async function startPublishAttempt(params: {
  revisionId: string;
  mode: StripeMode;
  fingerprint: string;
  startedBy: string;
}): Promise<string> {
  return tesserixTx(async (query) => {
    // Serialises every `startPublishAttempt` call FOR THIS MODE against
    // every other one — see this function's doc comment on why the key
    // folds in `mode` rather than being fixed, unlike `createDraftFrom`'s.
    await query(`SELECT pg_advisory_xact_lock(1, hashtext($1))`, [params.mode]);

    const openRows = await query<{ id: string }>(
      `SELECT id
         FROM plan_catalog_publish_attempts
        WHERE mode = $1 AND outcome IS NULL
        ORDER BY started_at DESC
        LIMIT 1`,
      [params.mode],
    );
    const open = openRows[0];
    if (open) {
      throw new Error(
        `startPublishAttempt: an open publish attempt already exists for ${params.mode} ` +
          `(attempt ${open.id}) — finish or abort it before starting another`,
      );
    }

    const rows = await query<{ id: string }>(
      `INSERT INTO plan_catalog_publish_attempts (revision_id, mode, fingerprint, started_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [params.revisionId, params.mode, params.fingerprint, params.startedBy],
    );
    return rows[0].id;
  });
}

/**
 * Close an attempt with its terminal outcome.
 *
 * `outcome` and `finished_at` are set together, in the one UPDATE — 0038's
 * `plan_catalog_publish_attempts_status_is_coherent` CHECK is what makes a
 * partial version of this (outcome without finish time, or the reverse)
 * impossible to write, not just something this function is careful about.
 */
export async function finishPublishAttempt(
  attemptId: string,
  outcome: PublishAttemptOutcome,
): Promise<void> {
  await tesserixTx(async (query) => {
    await query(
      `UPDATE plan_catalog_publish_attempts
          SET outcome = $2, finished_at = now()
        WHERE id = $1`,
      [attemptId, outcome],
    );
  });
}

/** The one attempt this id names, or `null` if it does not (or no longer)
 *  exist. */
export async function publishAttemptById(attemptId: string): Promise<PublishAttempt | null> {
  return tesserixTx(async (query) => {
    const rows = await query<{
      id: string;
      revision_id: string;
      mode: string;
      fingerprint: string;
      started_by: string;
      started_at: string;
      finished_at: string | null;
      outcome: string | null;
    }>(
      `SELECT id, revision_id, mode, fingerprint, started_by, started_at, finished_at, outcome
         FROM plan_catalog_publish_attempts
        WHERE id = $1`,
      [attemptId],
    );
    const row = rows[0];
    return row ? mapAttemptRow(row) : null;
  });
}

export type StripeCall = "create" | "update" | "archive";
export type OperationStatus = "pending" | "succeeded" | "failed";

export interface PublishOperationRow {
  readonly id: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly kind: OperationKind;
  readonly stripeCall: StripeCall;
  readonly source: string;
  readonly lookupKey: string | null;
  readonly currency: string | null;
  readonly stripePriceId: string | null;
  readonly idempotencyKey: string;
  readonly status: OperationStatus;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

function mapOperationRow(row: {
  id: string;
  attempt_id: string;
  sequence: number;
  kind: string;
  stripe_call: string;
  source: string;
  lookup_key: string | null;
  currency: string | null;
  stripe_price_id: string | null;
  idempotency_key: string;
  status: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}): PublishOperationRow {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    sequence: row.sequence,
    kind: row.kind as OperationKind,
    stripeCall: row.stripe_call as StripeCall,
    source: row.source,
    lookupKey: row.lookup_key,
    currency: row.currency,
    stripePriceId: row.stripe_price_id,
    idempotencyKey: row.idempotency_key,
    status: row.status as OperationStatus,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Write-ahead: record an operation as `pending` BEFORE the executor makes
 * the matching Stripe call. This is the insert 0038's header calls the whole
 * reason the log exists — a crash between this returning and the Stripe call
 * happening leaves exactly this row, `pending`, telling a resumed publish
 * "this may have happened" instead of leaving no trace at all.
 *
 * `stripePriceId` here is the operation's KNOWN id at write-ahead time — its
 * meaning depends on `stripeCall`, same three cases as 0038's comment on the
 * column:
 *   - `archive` (a `replace_price`'s second call): the OLD id, captured
 *     before its create, per 0038's comment on the column.
 *   - `update` (`add_currency_option` / `update_tax_behavior`): the EXISTING
 *     id the call targets — already known, same as `archive`.
 *   - `create`: leave this `null`. The Stripe id does not exist yet and will
 *     only be known after the call returns (see `completeOperation`).
 */
export async function recordOperation(input: {
  attemptId: string;
  sequence: number;
  kind: OperationKind;
  stripeCall: StripeCall;
  source: string;
  lookupKey?: string | null;
  currency?: string | null;
  stripePriceId?: string | null;
  idempotencyKey: string;
}): Promise<string> {
  return tesserixTx(async (query) => {
    const rows = await query<{ id: string }>(
      `INSERT INTO plan_catalog_publish_operations
         (attempt_id, sequence, kind, stripe_call, source, lookup_key, currency, stripe_price_id, idempotency_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       RETURNING id`,
      [
        input.attemptId,
        input.sequence,
        input.kind,
        input.stripeCall,
        input.source,
        input.lookupKey ?? null,
        input.currency ?? null,
        input.stripePriceId ?? null,
        input.idempotencyKey,
      ],
    );
    return rows[0].id;
  });
}

/**
 * A completion the schema's coherence CHECK admits: `succeeded` may learn a
 * Stripe id it did not have at write-ahead time (a `create` call's newly
 * minted price), `failed` must carry the reason. There is no third variant —
 * an operation this function has not been called for stays `pending`, which
 * is the resumable state Task 6's executor reasons about.
 */
export type OperationCompletion =
  | { readonly status: "succeeded"; readonly stripePriceId?: string | null }
  | { readonly status: "failed"; readonly error: string };

export async function completeOperation(
  operationId: string,
  completion: OperationCompletion,
): Promise<void> {
  await tesserixTx(async (query) => {
    if (completion.status === "succeeded") {
      await query(
        `UPDATE plan_catalog_publish_operations
            SET status = 'succeeded',
                finished_at = now(),
                stripe_price_id = COALESCE($2, stripe_price_id)
          WHERE id = $1`,
        [operationId, completion.stripePriceId ?? null],
      );
    } else {
      await query(
        `UPDATE plan_catalog_publish_operations
            SET status = 'failed', finished_at = now(), error = $2
          WHERE id = $1`,
        [operationId, completion.error],
      );
    }
  });
}

/** Every operation this attempt has recorded, in execution order — the
 *  order `PublishPlan.operations` was built in (`create_product` first, then
 *  `lookup_key` order), reproduced here via `sequence` rather than insertion
 *  time, since a caller may retry composing a plan out of order. */
export async function operationsForAttempt(attemptId: string): Promise<PublishOperationRow[]> {
  return tesserixTx(async (query) => {
    const rows = await query<{
      id: string;
      attempt_id: string;
      sequence: number;
      kind: string;
      stripe_call: string;
      source: string;
      lookup_key: string | null;
      currency: string | null;
      stripe_price_id: string | null;
      idempotency_key: string;
      status: string;
      error: string | null;
      started_at: string;
      finished_at: string | null;
    }>(
      `SELECT id, attempt_id, sequence, kind, stripe_call, source, lookup_key, currency,
              stripe_price_id, idempotency_key, status, error, started_at, finished_at
         FROM plan_catalog_publish_operations
        WHERE attempt_id = $1
        ORDER BY sequence`,
      [attemptId],
    );
    return rows.map(mapOperationRow);
  });
}

// ---------------------------------------------------------------------------
// Promotion and orphan detection (Task 7, `0037`/`0038`'s remaining gap)
//
// `executePublish` (`publish-executor.ts`) never writes a
// `plan_catalog_publications` row — see that module's header, "A SUCCESSFUL
// PUBLISH IS NOT A PROMOTION" — so a green `executePublish` alone leaves the
// catalog agreeing with Stripe while `readCatalogAmounts` and the nightly
// parity check still read the OLD revision. `promotePublication` below is
// the write that closes that gap; `archivedStripePriceIds` is what lets
// `orphans.ts` find the half of a `replace_price` that never got its
// matching archive.
// ---------------------------------------------------------------------------

/**
 * Retire whatever is currently live for `mode` and promote `revisionId` in
 * its place — the write `executePublish` deliberately does not make, and
 * which its caller (not yet wired; a later task) MUST make in the same
 * transaction-shaped step immediately after a `"succeeded"` outcome.
 *
 * # One transaction, retire-then-insert, exactly 0035's own prescription
 *
 * 0035's `plan_catalog_publications_one_live_per_mode` partial unique index
 * comment says it plainly: "exactly one published" is a property of the
 * publish TRANSACTION (retire then promote, under an advisory lock on the
 * mode), not of the schema. This function IS that transaction — the index
 * is the ceiling that catches a bug here, not the mechanism that prevents
 * one.
 *
 * # The advisory lock: same shape as `createDraftFrom` and
 * `startPublishAttempt`, a THIRD namespace
 *
 * `pg_advisory_xact_lock(2, hashtext($1))` — transaction-scoped, released
 * automatically on COMMIT or ROLLBACK, no matching unlock to forget. Scoped
 * PER MODE (folds in `mode`), like `startPublishAttempt`'s lock and unlike
 * `createDraftFrom`'s single global one: `test` and `live` promote
 * independently, and a promotion racing another mode's promotion is not the
 * hazard this guards against.
 *
 * The first component is `2`, not `0` (`createDraftFrom`) or `1`
 * (`startPublishAttempt`) — a deliberate, distinct namespace so this
 * invariant's lock can never collide with either of the other two in
 * `pg_locks`, despite all three being `pg_advisory_xact_lock` calls against
 * the same database. Taken BEFORE the retire-then-insert below, for the
 * identical reason `createDraftFrom` takes its lock before its
 * check-then-insert: without it, two concurrent promotions to the same mode
 * can both read "whatever is live" under READ COMMITTED and the second
 * retires what the first just promoted a moment ago, silently discarding it.
 *
 * # A CEILING, never a floor — restated here on purpose, same as the other
 * two lock-guarded functions in this file
 *
 * This function serialises ITSELF, for every mode, against every other call
 * to it. It does not, and cannot, stop a `plan_catalog_publications` row
 * from being written by some OTHER path that skips this function — there is
 * no schema constraint backing that narrower claim, only this function's own
 * discipline (0038 has none for its own two lock-guarded functions either,
 * for the identical reason).
 *
 * # `revisionId` is trusted, not re-validated here
 *
 * Whether `revisionId` is the draft that was actually just published, still
 * unpublished, and belongs to `mode`'s catalog is the CALLER's
 * responsibility (the not-yet-wired step after `executePublish` succeeds) —
 * this function's only job is the retire-then-promote write, atomically. A
 * `revisionId` that does not exist fails the INSERT's FK, loudly, rather
 * than silently promoting nothing.
 */
export async function promotePublication(
  mode: StripeMode,
  revisionId: string,
  by: string,
): Promise<string> {
  return tesserixTx(async (query) => {
    await query(`SELECT pg_advisory_xact_lock(2, hashtext($1))`, [mode]);

    // Retire whatever is live for THIS mode. Scoped by `mode`, not a bare
    // `superseded_at IS NULL` — the identical scoping `readLivePublication`
    // (`plan-catalog-repo.ts`) uses, so the two can never disagree about
    // which row "live" names.
    await query(
      `UPDATE plan_catalog_publications
          SET superseded_at = now(), superseded_by = $2
        WHERE mode = $1 AND superseded_at IS NULL`,
      [mode, by],
    );

    const rows = await query<{ id: string }>(
      `INSERT INTO plan_catalog_publications (mode, revision_id, published_by)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [mode, revisionId, by],
    );
    return rows[0].id;
  });
}

/** One archived Stripe Price this catalog's publish log recorded, as
 *  `findOrphans` (`orphans.ts`) needs it — never more than the log actually
 *  knows, which is why `lookupKey` stays nullable: `archive_price`'s and
 *  `replace_price`'s write-ahead rows both carry the OLD id's lookup key at
 *  the time of archiving, but nothing in this table's schema (0038) demands
 *  one, and a future `stripe_call = 'archive'` row that omits it must not
 *  make this query throw. */
export interface ArchivedStripePrice {
  readonly stripePriceId: string;
  readonly lookupKey: string | null;
  readonly source: string;
}

/**
 * Every Stripe Price id this catalog's publish log has ever recorded an
 * archive call against, for `mode` — the read half of orphan detection.
 *
 * # Why this belongs here, not in `orphans.ts`
 *
 * This module already owns every read and write of
 * `plan_catalog_publish_operations` / `plan_catalog_publish_attempts` (see
 * this file's section header above `PublishAttemptOutcome`) — `orphans.ts`
 * asking Stripe whether an id is still active is the only part of orphan
 * detection that is NOT a query against this log, and keeping the query here
 * matches every other function in this file.
 *
 * # DISTINCT, and why a price id can legitimately appear more than once
 *
 * `stripe_call = 'archive'` rows come from two `OperationKind`s —
 * `archive_price` (the whole operation) and `replace_price` (the archive
 * half, see `plan_catalog_publish_operations`'s comment on the column) — and
 * a retried publish after a crash is a NEW attempt with its own operation
 * rows (see `startPublishAttempt`'s doc comment: recovery is a new attempt,
 * never a replay), so the same Stripe Price id can be the target of an
 * `archive` `stripe_call` in more than one attempt's log. `DISTINCT` on the
 * id, key and source is what keeps `findOrphans` from reporting the same
 * orphan twice for that reason alone.
 *
 * # NO `status` FILTER — every archive `stripe_call` row is a candidate
 *
 * A `pending` or `failed` archive attempt is exactly the case orphan
 * detection exists to catch — the id may still be `active` in Stripe
 * precisely BECAUSE the archive call never landed, or landed and this log
 * never learned the outcome. Filtering on `status = 'succeeded'` would make
 * `findOrphans` blind to the crash-mid-`replace_price` case that is this
 * whole feature's reason to exist (0038's header): the write-ahead row for
 * an `archive` `stripe_call` already carries the OLD id at INSERT time
 * (0038's comment on `stripe_price_id`, lines ~143-153), before Stripe is
 * ever called, so `pending` rows are exactly as usable as `succeeded` ones
 * for this query.
 *
 * This is safe to over-include: Stripe's own `active: true` filter in
 * `stripePriceReader.listPrices` (`stripe-read.ts`) is the AUTHORITATIVE
 * answer to "is this Price still active", and `findOrphans` only reports an
 * id that appears in BOTH this query's result and that active list.
 * `op.status` records whether OUR call landed, which is a different
 * question from whether the Price is active in Stripe — if the archive did
 * land (`status = 'succeeded'` or not), Stripe reports the Price inactive
 * and it is simply absent from the active list, costing nothing.
 *
 * `source` scopes to `SINGLE_SOURCE` — see `defaultOrphanDetectorDeps` in
 * `orphans.ts`, which is this function's only caller today — rather than
 * being hardcoded here, matching every other query in this codebase that
 * reads `plan_catalog_prices`-adjacent rows (`readCatalogAmounts`,
 * `createDraftFrom`'s copy).
 */
export async function archivedStripePriceIds(
  mode: StripeMode,
  source: string,
): Promise<ArchivedStripePrice[]> {
  return tesserixTx(async (query) => {
    const rows = await query<{
      stripe_price_id: string;
      lookup_key: string | null;
      source: string;
    }>(
      `SELECT DISTINCT op.stripe_price_id, op.lookup_key, op.source
         FROM plan_catalog_publish_operations op
         JOIN plan_catalog_publish_attempts att ON att.id = op.attempt_id
        WHERE att.mode = $1
          AND op.source = $2
          AND op.stripe_call = 'archive'
          AND op.stripe_price_id IS NOT NULL`,
      [mode, source],
    );
    return rows.map((row) => ({
      stripePriceId: row.stripe_price_id,
      lookupKey: row.lookup_key,
      source: row.source,
    }));
  });
}
