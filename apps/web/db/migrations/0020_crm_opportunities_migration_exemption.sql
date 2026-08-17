-- 0020_crm_opportunities_migration_exemption.sql
--
-- Task 2 (migrate leads → crm) surfaced a real conflict in 0019's
-- crm_opp_product_required_when_qualified CHECK: a migrated lead that was
-- already qualified/won/lost under the old `leads` vocabulary was never
-- matched to a product, and 0019 deliberately keeps `product` null for
-- migrated rows rather than fabricate attribution the funnel would later
-- report as fact (see 0019's comment on crm_opportunities.product).
--
-- Weakening the CHECK to `product IS NOT NULL OR true` for every row would
-- make it meaningless going forward. Instead: tag every migrated
-- opportunity with the lead it came from, and exempt only rows carrying
-- that tag. New opportunities created by the console (no migrated lead
-- behind them) still can't reach qualified/won/lost without a product.

ALTER TABLE crm_opportunities
  ADD COLUMN IF NOT EXISTS migrated_from_lead_id uuid REFERENCES leads(id);

CREATE INDEX IF NOT EXISTS crm_opp_migrated_from_lead_idx
  ON crm_opportunities (migrated_from_lead_id)
  WHERE migrated_from_lead_id IS NOT NULL;

ALTER TABLE crm_opportunities
  DROP CONSTRAINT crm_opp_product_required_when_qualified;

ALTER TABLE crm_opportunities
  ADD CONSTRAINT crm_opp_product_required_when_qualified CHECK (
    stage IN ('new', 'contacted')
    OR product IS NOT NULL
    OR migrated_from_lead_id IS NOT NULL
  );
