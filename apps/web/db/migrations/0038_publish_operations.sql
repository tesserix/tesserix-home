-- The publish-attempt and operation log: what makes a publish RESUMABLE and
-- AUDITABLE.
--
-- Task 6's executor writes each operation to `plan_catalog_publish_operations`
-- BEFORE calling Stripe — write-ahead — so a crash between the write and the
-- call leaves a `pending` row saying an operation MAY have happened. Without
-- that row, a resumed publish cannot tell "never attempted" from "attempted,
-- outcome unknown", and the only safe action left would be to do nothing.
--
-- This log is also the only thing that can detect an ORPHAN: a Price created
-- and then abandoned carries no `lookup_key` (`transfer_lookup_key` moved it
-- to the replacement), so the parity comparator structurally cannot see it
-- (spec §9.2). `plan_catalog_publish_operations_archived` below is what makes
-- "was this price id ever archived" a query instead of a Dashboard search.
--
-- WHY TWO TABLES. An attempt is "someone tried to publish revision X to mode
-- Y at fingerprint Z" — one row, written once, closed once. An operation is
-- "one Stripe API call" — many rows per attempt, and per the next paragraph,
-- sometimes more than one row per PLANNED operation. Folding them together
-- would mean re-asserting the attempt's fingerprint and mode on every
-- operation row, and would give a `plan_catalog_publish_attempts`-shaped
-- question (`was this fingerprint ever executed?`) no table of its own to
-- answer cleanly.
--
-- WHY `stripe_call`, NOT JUST `kind`. `replace_price` (see
-- `apps/console/lib/billing/publish-plan.ts`'s `OperationKind`) is TWO Stripe
-- calls: create the replacement, then archive the old id. One planned
-- operation, two API calls, two chances to fail independently, two rows —
-- `kind` says what was PLANNED, `stripe_call` says which half of it this row
-- IS. Folding them into one row per planned operation would make "the create
-- succeeded but the archive didn't" unrepresentable, which is exactly the
-- half-done state a crash mid-`replace_price` produces.
--
-- Following 0033's and 0036's discipline: belt-and-braces CHECKs for every
-- field an argument depends on, each commented with what silently goes wrong
-- without it. And following 0035's: `CREATE TABLE IF NOT EXISTS` plus
-- drop-then-add for constraints (Postgres has no `ADD CONSTRAINT IF NOT
-- EXISTS`), since this file, like every migration here, is applied by hand
-- and must survive being run twice.

CREATE TABLE IF NOT EXISTS plan_catalog_publish_attempts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- ON DELETE RESTRICT, not CASCADE: an attempt is evidence about a
    -- revision, and a revision that has been attempted is not the "copied
    -- into a draft, discarded, never published" shape `discardDraft` expects
    -- to delete freely (`publish-repo.ts`). Deleting the revision out from
    -- under its own attempt history would silently destroy the audit trail
    -- an operator relies on to answer "what did we try, and when".
    revision_id uuid NOT NULL REFERENCES plan_catalog_revisions (id) ON DELETE RESTRICT,

    mode        text NOT NULL
                CONSTRAINT plan_catalog_publish_attempts_mode_is_known
                CHECK (mode IN ('test', 'live')),

    -- The observation this plan was built against. Re-observed at execution;
    -- a change ABORTS. Without it the operator confirms a plan computed at T
    -- and something else executes at T+n — see `PublishPlan.fingerprint`'s
    -- doc comment in `publish-plan.ts` for what it covers and why.
    fingerprint text NOT NULL,

    started_by  text NOT NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,

    -- Same three-state shape 0033 chose for parity runs, for the same
    -- reason: a publish that never reached a verdict (still running, or the
    -- process died) is neither `succeeded` nor `failed`, and `aborted` is
    -- what a fingerprint mismatch (see above) records — refused before any
    -- Stripe call, not a failure of one.
    outcome     text
                CONSTRAINT plan_catalog_publish_attempts_outcome_is_known
                CHECK (outcome IN ('succeeded', 'failed', 'aborted')),

    -- An attempt is either still running (`outcome` and `finished_at` both
    -- unset) or done (both set). Without this, a row could claim `succeeded`
    -- while still reading as in-progress to anything polling `finished_at`,
    -- or vice versa — the exact "summary disagrees with itself" failure mode
    -- 0033 wrote the identical guard against for parity runs.
    CONSTRAINT plan_catalog_publish_attempts_status_is_coherent
    CHECK (
        (outcome IS NULL     AND finished_at IS NULL) OR
        (outcome IS NOT NULL AND finished_at IS NOT NULL)
    )
);

-- "What was in flight, or what recently happened" — the 2am question for
-- attempts, mirroring `plan_catalog_parity_runs_ran_at`.
CREATE INDEX IF NOT EXISTS plan_catalog_publish_attempts_started_at
    ON plan_catalog_publish_attempts (started_at DESC);

CREATE TABLE IF NOT EXISTS plan_catalog_publish_operations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- CASCADE, unlike the attempt's own FK to its revision above: an
    -- operation has no meaning independent of the attempt that produced it,
    -- so deleting the attempt (which this schema otherwise never does — see
    -- RESTRICT above) taking its operations with it is the right shape, not
    -- a hazard to guard against. This is also that requirement, verbatim:
    -- "an operation row cannot exist without its attempt" is NOT NULL + this
    -- FK, not a convention.
    attempt_id  uuid NOT NULL REFERENCES plan_catalog_publish_attempts (id) ON DELETE CASCADE,

    -- Execution order within the attempt. `create_product` operations sort
    -- first in the plan (see `PublishPlan.operations`'s doc comment); this is
    -- what lets the log reproduce that order later without re-deriving it.
    sequence    integer NOT NULL,

    -- What was PLANNED — must admit every `OperationKind` from
    -- `publish-plan.ts`, because that union is this column's only producer.
    -- A kind this CHECK doesn't know about is a kind the executor emits that
    -- this table silently can't record; better to fail the INSERT loudly at
    -- the boundary than to lose it.
    kind        text NOT NULL
                CONSTRAINT plan_catalog_publish_operations_kind_is_known
                CHECK (kind IN (
                    'create_product', 'create_price', 'replace_price',
                    'add_currency_option', 'update_tax_behavior', 'archive_price'
                )),

    -- ONE ROW PER STRIPE CALL, not per plan entry. A `replace_price` is a
    -- create AND an archive, and orphan detection needs the archived id
    -- specifically — see this file's header.
    stripe_call text NOT NULL
                CONSTRAINT plan_catalog_publish_operations_stripe_call_is_known
                CHECK (stripe_call IN ('create', 'update', 'archive')),

    -- Which product this row belongs to. Not assumed as today's one source
    -- (`SINGLE_SOURCE`, `source-policy.ts`) — see 0035's identical reasoning
    -- for `plan_catalog_prices.source`: cheap now, expensive to retrofit once
    -- a second product exists and this table's rows need auditing per-source.
    source      text NOT NULL,

    -- Null for a `create_product` call — a Product has no lookup key, only
    -- its Prices do (`CreateProductOperation.plan` names the product
    -- instead). Every other `stripe_call` sets it.
    lookup_key  text,
    currency    text,

    -- The Stripe Price id this row concerns — meaning depends on
    -- `stripe_call`, not fixed across the column:
    --   - `archive`: the OLD id, captured BEFORE the create for a
    --     replacement. Once the new price claims the lookup key, the old one
    --     is addressable only by id, and resolving by key at archive time
    --     would archive the price this operation just minted
    --     (`ReplacePriceOperation.oldPriceId`'s doc comment in
    --     `publish-plan.ts` makes the identical point). Known and set at
    --     write-ahead time, same as `create`'s row below is NOT.
    --   - `create`: the NEW id — unknown when the write-ahead row is
    --     inserted (Stripe hasn't been called yet) and populated only once
    --     the call returns, via `completeOperation`'s `COALESCE` in
    --     `publish-repo.ts`.
    --   - `update`: the EXISTING id an `add_currency_option` or
    --     `update_tax_behavior` call targets — already known at write-ahead
    --     time, same as `archive`, but naming a price that is neither being
    --     replaced nor newly created.
    stripe_price_id text,

    -- One idempotency key per Stripe call, unique across every attempt this
    -- table has ever recorded. Stripe replays cached FAILURES and expires
    -- keys after 24h — mark8ly deadlocked on this and bumped its key scheme
    -- v1 -> v3 (see Task 6's brief). The UNIQUE constraint is what turns "the
    -- executor must fold the attempt into the key" from a convention the
    -- next change to `publish-executor.ts` could quietly drop into something
    -- the database refuses to let happen: two rows claiming the same key
    -- would mean two attempts (or two operations within one) sharing a key,
    -- which is exactly the stuck-on-a-cached-failure bug mark8ly hit.
    idempotency_key text NOT NULL,

    status      text NOT NULL
                CONSTRAINT plan_catalog_publish_operations_status_is_known
                CHECK (status IN ('pending', 'succeeded', 'failed')),
    error       text,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,

    -- Sequence numbers are per-attempt, not global — an attempt replays its
    -- own operations 1..N; two attempts both having a "1" is expected, not a
    -- collision.
    CONSTRAINT plan_catalog_publish_operations_one_per_sequence
    UNIQUE (attempt_id, sequence),

    CONSTRAINT plan_catalog_publish_operations_idempotency_key_unique
    UNIQUE (idempotency_key),

    -- `pending` is the write-ahead state: the row exists, Stripe has not
    -- necessarily been called yet (or the call is in flight), so neither a
    -- finish time nor an outcome can be known. `succeeded` and `failed` are
    -- terminal and must both close out `finished_at`; `failed` must also say
    -- why, `succeeded` must not claim an error. Without this, a `pending` row
    -- with a `finished_at` set would look terminal to a resuming executor
    -- that trusts `finished_at IS NOT NULL` as "done", and a `failed` row
    -- with no `error` would leave an operator no way to learn what Stripe
    -- said.
    CONSTRAINT plan_catalog_publish_operations_status_is_coherent
    CHECK (
        (status = 'pending'   AND finished_at IS NULL     AND error IS NULL) OR
        (status = 'succeeded' AND finished_at IS NOT NULL AND error IS NULL) OR
        (status = 'failed'    AND finished_at IS NOT NULL AND error IS NOT NULL)
    )
);

-- The 2am question is "what happened to THIS price".
CREATE INDEX IF NOT EXISTS plan_catalog_publish_operations_lookup_key
    ON plan_catalog_publish_operations (lookup_key);

-- Orphan detection scans archived ids: a Price created and then abandoned
-- (crash between the create succeeding and the matching archive) carries no
-- `lookup_key` the comparator would ever look for (spec §9.2), so this index
-- is what makes "was this Stripe price id ever the target of an archive"
-- answerable without a full table scan.
CREATE INDEX IF NOT EXISTS plan_catalog_publish_operations_archived
    ON plan_catalog_publish_operations (stripe_price_id)
    WHERE stripe_call = 'archive';

-- Attempt-scoped operation listing — the executor's own resume/report path
-- ("what happened in attempt X, in order") and the audit trail an operator
-- reads after the fact both filter on `attempt_id` and want `sequence` order.
CREATE INDEX IF NOT EXISTS plan_catalog_publish_operations_attempt_sequence
    ON plan_catalog_publish_operations (attempt_id, sequence);
