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
-- MUST be applied after scripts/migrate-leads-to-crm.mjs --commit has run.
-- Applying it before that backfill defeats the point: an empty (or
-- not-yet-backfilled) table has no non-conforming rows for NOT VALID to
-- grandfather, so every subsequent qualified/won/lost insert with a null
-- product — including the migration script's own inserts — would be
-- rejected exactly as it was when 0020 first shipped this constraint
-- inline. See 0020's header for the failed dry run that proved this.

ALTER TABLE crm_opportunities
  ADD CONSTRAINT crm_opp_product_required_when_qualified CHECK (
    stage IN ('new', 'contacted') OR product IS NOT NULL
  ) NOT VALID;
