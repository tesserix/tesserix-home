-- 0024_crm_contacts_erased_at.sql
--
-- Erasure for crm_contacts, per #213 and the DPDP reasoning in #154.
--
-- WHY REDACT RATHER THAN DELETE. crm_contacts rows carry `source`,
-- `sourced_at` and `lawful_basis` precisely so an erasure request can be
-- honoured. Deleting the row honours it too, but takes the organisation's
-- deal history with it via ON DELETE CASCADE on crm_opportunities — and
-- stage_change activities are the only record of when a stage was entered,
-- so a delete leaves funnel measurement with holes it cannot explain.
-- Overwriting the personal data in place honours the request (nothing
-- identifying survives) while the opportunity and its activity log stay
-- whole. A genuinely junk row is removed by deleting its ORGANISATION,
-- which is a separate, deliberately blunter action.
--
-- Erasure of the personal columns is done by the application
-- (lib/db/crm-erasure.ts) so it is one audited operation; this migration
-- only adds the marker that says it happened. The marker matters
-- independently: without it an erased contact is indistinguishable from a
-- contact that simply never had an email, and re-import would treat it as
-- a fresh row to enrich.
ALTER TABLE crm_contacts
  ADD COLUMN IF NOT EXISTS erased_at timestamptz;

-- Partial: erased contacts are the rare case, and the only query that
-- filters on this asks for them specifically.
CREATE INDEX IF NOT EXISTS crm_contacts_erased_idx
  ON crm_contacts (erased_at)
  WHERE erased_at IS NOT NULL;
