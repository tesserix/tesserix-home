-- 0020_crm_opportunities_migration_exemption.sql
--
-- Task 2 (migrate leads → crm) surfaced a real conflict in 0019's
-- crm_opp_product_required_when_qualified CHECK: a migrated lead that was
-- already qualified/won/lost under the old `leads` vocabulary was never
-- matched to a product, and 0019 deliberately keeps `product` null for
-- migrated rows rather than fabricate attribution the funnel would later
-- report as fact (see 0019's comment on crm_opportunities.product).
--
-- First pass at this migration put `migrated_from_lead_id IS NOT NULL` in
-- the CHECK itself and gave the column a foreign key to `leads`. Both were
-- wrong:
--   * A CHECK clause keyed on "does this row carry a migration tag" is
--     claimable by ANY row, forever — a brand-new opportunity could set
--     migrated_from_lead_id to skip the product requirement, and an old
--     migrated row could sit at `won` with no product indefinitely even
--     after being edited, which defeats the point of requiring a product
--     once a deal is real.
--   * The FK to `leads(id)` couples this table's constraint validity to a
--     table design.md (line 326) explicitly plans to retire. Dropping
--     `leads` later would either be blocked by this FK, or dropping the FK
--     first would null the column and instantly violate the CHECK on every
--     migrated row that's qualified/won/lost.
--
-- Correct mechanism: revert the CHECK to 0019's original expression (no
-- exemption clause), but the re-add has to happen as NOT VALID *after* the
-- historical leads have been loaded, not now. Postgres's NOT VALID only
-- skips validating rows that already exist in the table at ADD CONSTRAINT
-- time — it does NOT let subsequent inserts bypass the check. Re-adding
-- the constraint here, before the migration script has run, would simply
-- reject every qualified/won/lost migrated row exactly as before, only
-- with a different-looking error. (Confirmed by running the migration
-- script against this constraint before splitting the migration: all 155
-- of those rows failed on INSERT.)
--
-- So this migration only does the DROP and the provenance/idempotency
-- plumbing. The CHECK stays absent — deliberately, temporarily — until
-- 0021, which re-adds it as NOT VALID once the backfill exists. Required
-- deploy order:
--   1. apply migrations through 0020 (this file)
--   2. run scripts/migrate-leads-to-crm.mjs --commit
--   3. apply 0021 (re-adds the CHECK, NOT VALID, grandfathering the rows
--      scripts/migrate-leads-to-crm.mjs just inserted)
--
-- migrated_from_lead_id itself stays: it's needed as (a) provenance — which
-- lead produced this opportunity — and (b) the idempotency key the
-- migration script's re-run check relies on. It doesn't reference `leads`
-- (see reasoning above) and is no longer part of the CHECK expression.

ALTER TABLE crm_opportunities
  ADD COLUMN IF NOT EXISTS migrated_from_lead_id uuid;

-- Structural idempotency guarantee, not just the migration script's
-- in-memory dedup: two concurrent runs of the script can't both insert an
-- opportunity for the same lead — the second insert fails the unique
-- index and that lead's transaction rolls back instead of silently
-- duplicating the row.
CREATE UNIQUE INDEX IF NOT EXISTS crm_opp_migrated_from_lead_uq
  ON crm_opportunities (migrated_from_lead_id)
  WHERE migrated_from_lead_id IS NOT NULL;

-- Dropped, not replaced yet — see the file header for why the re-add has
-- to wait for 0021, run after the one-time leads backfill.
ALTER TABLE crm_opportunities
  DROP CONSTRAINT crm_opp_product_required_when_qualified;
