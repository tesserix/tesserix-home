-- 0021_crm_opportunities_product_check_reinstated.sql
--
-- Second half of the fix started in 0020. 0020 dropped
-- crm_opp_product_required_when_qualified so scripts/migrate-leads-to-crm.mjs
-- could backfill the ~155 historical qualified/won/lost opportunities that
-- carry no product. This migration re-adds the exact same constraint 0019
-- shipped — no exemption clause, no dependency on migrated_from_lead_id —
-- but as NOT VALID.
--
-- NOT VALID here means: Postgres does not scan/reject the rows already in
-- crm_opportunities when this ALTER runs (the migrated backfill, by then
-- already loaded), but it DOES enforce the check on every INSERT and every
-- UPDATE from this point on — including an UPDATE of one of those old
-- migrated `won` rows. That's a deliberate trade-off, not a cost: once
-- someone is actively editing a migrated deal again, it should carry a
-- real product like every other opportunity does.
--
-- CONSEQUENCE FOR TASK 6 (record, don't fix here): after this migration,
-- the ~155 grandfathered rows are effectively read-only from the CHECK's
-- point of view. ANY UPDATE to one of them — a bare `updated_at = now()`,
-- an owner reassignment, anything — re-evaluates the CHECK against the new
-- row and fails unless a product is supplied in the same UPDATE. The
-- console's opportunity detail view will need to force a product field
-- before it can save any change to a migrated qualified/won/lost row, or
-- it will surface a raw Postgres constraint-violation error to the user.
--
-- CONSEQUENCE FOR TASK 6 (record, don't fix here): between 0020 applying
-- and 0021 applying on the live database, there is a window with no
-- product-required CHECK on crm_opportunities at all — any row, migrated
-- or not, can reach qualified/won/lost with a null product during that
-- window. This is inherent to the two-step design (see the STRUCTURAL
-- GUARD section below for why it can't be collapsed into one step) and is
-- low-risk today only because no CRM surface writes to this table yet.
--
-- MUST be applied after scripts/migrate-leads-to-crm.mjs --commit has run.
-- Applying it before that backfill defeats the point: an empty (or
-- not-yet-backfilled) table has no non-conforming rows for NOT VALID to
-- grandfather, so every subsequent qualified/won/lost insert with a null
-- product — including the migration script's own inserts — would be
-- rejected exactly as it was when 0020 first shipped this constraint
-- inline. See 0020's header for the failed dry run that proved this.
--
-- STRUCTURAL GUARD (not just this comment): `pnpm db:migrate` /
-- db-migrate.mjs applies every pending migration in one run with no pause
-- point (db-migrate.mjs:115-136) — on a database where 0020 and 0021 are
-- both pending, both apply back-to-back in the same invocation, then the
-- backfill script hits an ALREADY-enforced CHECK. Worse,
-- migrate-leads-to-crm.mjs catches per-lead failures and main() returns
-- normally (exit 0), so a CI/runbook step that only checks the exit code
-- would report success while most of the 258 leads silently failed to
-- migrate, and by then 103 rows are already committed so a bare re-run
-- would skip them as "already migrated" instead of retrying — recovery
-- would need a manual ALTER on production. A header comment cannot stop
-- that; only the migration refusing to apply can. So: fail loud instead.
--
-- The predicate below is deliberately weak — "does at least one migrated
-- opportunity exist", not "was every nameable lead migrated". A strict
-- version would have to reimplement organisationName()'s fallback chain in
-- SQL, in a DO block, duplicating logic that already exists (and is already
-- tested) in the migration script. It isn't worth writing twice.
--
-- It is also no longer the load-bearing guard it once read as. This header
-- previously said a permanently-unnameable lead was an expected steady
-- state, so a strict check "would deadlock forever". That is no longer true:
-- migrate-leads-to-crm.mjs now exits NON-ZERO while any lead is rejected,
-- not only when one fails at insert time, so there is no such thing as a
-- completed backfill that left an unnameable lead behind. The operator
-- resolves it at source — by supplying a real identity if one is known, or
-- by DELETING the lead, which is a legitimate resolution for a row with
-- nothing to migrate — and only then does step 2 exit 0 and step 3 become
-- safe to run.
--
-- So the strict condition is enforced, just not here: it is enforced by the
-- script's exit code, which is the runbook's actual gate. What is left below
-- is belt-and-braces — the cheapest possible catch for "step 2 was never run
-- at all" — and it should be read that way rather than as the thing keeping
-- a partial backfill out.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM leads)
     AND NOT EXISTS (SELECT 1 FROM crm_opportunities WHERE migrated_from_lead_id IS NOT NULL)
  THEN
    RAISE EXCEPTION '0021 requires scripts/migrate-leads-to-crm.mjs --commit to run first';
  END IF;
END $$;
-- Each migration file runs in its own transaction and a RAISE EXCEPTION
-- aborts it without recording the version in schema_migrations (see
-- db-migrate.mjs's try/catch around each file) — so 0020 stays applied,
-- 0021 is simply not marked applied, and the next `db:migrate` run after
-- the backfill retries it cleanly. A fresh database with no `leads` rows
-- at all (e.g. a from-scratch test DB) passes vacuously and proceeds.

-- CONVERGENCE — a machine that applied the very FIRST version of 0020
-- (before this branch's review fixes) has version 20 permanently recorded
-- in schema_migrations, so the rewritten 0020 above will never re-run
-- there: it's still carrying the FK to `leads`, the non-unique index named
-- crm_opp_migrated_from_lead_idx, and a CHECK named
-- crm_opp_product_required_when_qualified in the *exemption* form (with
-- `OR migrated_from_lead_id IS NOT NULL`) rather than absent. Renumbering
-- 0020 instead of converging here was considered and rejected: this is an
-- unmerged branch, so no production database has applied the old 0020 yet,
-- but the two forms of 0020 have coexisted across fix rounds on throwaway
-- test databases, and converging here is cheaper and safer than chasing
-- every place a stale 0020 might already be recorded. Every statement
-- below is a no-op on a database that already has the current 0020's
-- shape (IF EXISTS / IF NOT EXISTS throughout).
ALTER TABLE crm_opportunities
  DROP CONSTRAINT IF EXISTS crm_opp_product_required_when_qualified;

ALTER TABLE crm_opportunities
  DROP CONSTRAINT IF EXISTS crm_opportunities_migrated_from_lead_id_fkey;

DROP INDEX IF EXISTS crm_opp_migrated_from_lead_idx;

CREATE UNIQUE INDEX IF NOT EXISTS crm_opp_migrated_from_lead_uq
  ON crm_opportunities (migrated_from_lead_id)
  WHERE migrated_from_lead_id IS NOT NULL;

ALTER TABLE crm_opportunities
  ADD CONSTRAINT crm_opp_product_required_when_qualified CHECK (
    stage IN ('new', 'contacted') OR product IS NOT NULL
  ) NOT VALID;
