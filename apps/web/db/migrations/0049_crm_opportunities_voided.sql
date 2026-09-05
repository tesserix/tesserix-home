-- 0049_crm_opportunities_voided.sql
--
-- A deal can be taken OUT of the funnel without being destroyed
-- (tesserix-home#251).
--
-- ══ WHY A COLUMN PAIR AND NOT A DELETE ══
--
-- The only disposal a mis-clicked duplicate deal has is marking it `lost`,
-- which requires inventing a `lost_reason` and then pollutes every close-rate
-- and loss-analysis number computed off the stage. A hard delete answers that,
-- but it costs the deal's history its meaning: `crm_activities.opportunity_id`
-- is `ON DELETE SET NULL` (0048), so a deleted deal's `stage_change` rows
-- survive carrying a NULL — and a NULL `opportunity_id` is already the routine
-- shape for an activity attached to the organisation rather than to a deal
-- (`crm-outreach.ts` writes one for every DM, `crm-writes.ts` for every change
-- to the organisation's own fields). The surviving rows would be
-- indistinguishable from that org-level traffic, so any measurement that
-- partitions BY `opportunity_id` silently loses them.
--
-- A void keeps the row, the foreign key and the parent. It is also
-- reversible, which a delete can never be.
--
-- ══ WHY NOT A `void` STAGE ══
--
-- `stage` is the enum type `crm_stage` (0019:12). Adding a member is an
-- `ALTER TYPE` on a closed enum that every stage predicate, label map and
-- Go-side parser would then have to learn. A void is orthogonal to where the
-- deal got to — the stage it reached stays true and stays readable — so it is
-- a second fact about the row, not a sixth value of the first one.
--
-- ══ NO INDEX HERE, AND THE TWO PARTIAL INDEXES ARE UNTOUCHED ON PURPOSE ══
--
-- `crm_opp_due_idx` and `crm_opp_drifting_idx` (0019:132-137) are partial on
-- `stage NOT IN ('won', 'lost')`. The queries that read them will gain
-- `AND voided_at IS NULL`, which NARROWS the rows they ask for: the new query
-- predicate still implies each index predicate, so both indexes stay eligible
-- exactly as they are. No `AND voided_at IS NULL` added to their WHERE
-- clauses, no rebuild, no REINDEX. Whoever reads this next and reaches for
-- `DROP INDEX … CREATE INDEX` should stop here: re-creating them buys nothing
-- and rewrites two indexes on a live table.
--
-- And no NEW index on `voided_at` either. `driftingOpportunities` and
-- `closedOpportunities` in `apps/console/lib/db/crm-repo.ts` both already
-- decline index work at this table's size; adding one for a column that will
-- be NULL on essentially every row would contradict them.
--
-- ══ THE 0021 CHECK APPLIES TO A VOID, AND WILL REFUSE ~155 ROWS ══
--
-- Recorded here because it is invisible from the column definitions below and
-- is otherwise rediscovered in production.
--
-- `crm_opp_product_required_when_qualified` — `stage IN ('new', 'contacted')
-- OR product IS NOT NULL` — was re-added `NOT VALID` (0021:119-122). `NOT
-- VALID` skips only the initial scan of existing rows; Postgres still
-- evaluates the CHECK against the new row of every INSERT and every UPDATE,
-- which 0021's own header spells out.
--
-- A void is an UPDATE. So voiding a deal at `qualified`/`won`/`lost` that
-- carries no product — the ~155 rows the lead migration grandfathered in
-- (0021:4-6) — raises a raw 23514 from this constraint, not from anything the
-- void wrote. Those are precisely the rows an operator most wants to void.
--
-- This migration deliberately does NOT backfill `product` to make them
-- voidable: inventing a product for 155 historical deals fabricates
-- attribution the funnel would then report as fact, which is the reason 0019
-- gives for leaving `product` nullable in the first place. The console-side
-- fix is a typed refusal read from the same `SELECT … FOR UPDATE` the void
-- already takes, so the operator sees "this deal needs a product" rather than
-- a database error.
--
-- ══ RE-RUNNABILITY ══
--
-- `ADD COLUMN IF NOT EXISTS`, and the constraint as DROP-then-ADD so a second
-- application is a no-op rather than an abort. `scripts/db-migrate.mjs` stops
-- at the first migration that throws, and every LATER migration then silently
-- stops being applied (tesserix-home#509).
--
-- ══ APPLY THIS BEFORE MERGING ══
--
-- Kargo deploys the console on merge; `db:migrate` does not ride along. Apply
-- 0049 to production BEFORE the PR carrying it merges, or the deployed console
-- queries columns that do not exist.

-- Both nullable, no default, no backfill: every existing row is live, and
-- NULL is what "live" means. `ADD COLUMN` with no default rewrites nothing.
ALTER TABLE crm_opportunities
  ADD COLUMN IF NOT EXISTS voided_at timestamptz;

-- Free text, and optional even on a voided deal. The stage a deal reached is
-- already recorded, and unlike `lost_reason` this is not an input to any
-- analysis — it is there for the next human to read.
ALTER TABLE crm_opportunities
  ADD COLUMN IF NOT EXISTS voided_reason text;

-- A reason cannot outlive the void it explains.
--
-- Restoring a deal clears `voided_at`; a restore that forgot to clear
-- `voided_reason` alongside it would leave a live deal carrying an
-- explanation for a void that is no longer in force — readable on the card,
-- and wrong. Stated as one implication rather than as a biconditional
-- deliberately: a void with no reason given is a legitimate state, so
-- `voided_at` without `voided_reason` must stay allowed.
ALTER TABLE crm_opportunities
  DROP CONSTRAINT IF EXISTS crm_opp_void_reason_requires_void;

ALTER TABLE crm_opportunities
  ADD CONSTRAINT crm_opp_void_reason_requires_void CHECK (
    voided_reason IS NULL OR voided_at IS NOT NULL
  );
