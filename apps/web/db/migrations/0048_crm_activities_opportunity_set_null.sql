-- 0048_crm_activities_opportunity_set_null.sql
--
-- `crm_activities.opportunity_id` becomes `ON DELETE SET NULL`, so the
-- constraint agrees with what the table's own header says it holds
-- (tesserix-home#251).
--
-- ══ SET NULL IS WHAT THE SCHEMA ALREADY SAYS ══
--
-- 0019's header over this table (0019:143-146) reads: the event log is
-- "always attached to the organisation, optionally scoped to a deal or a
-- person: 'everything we have ever said to this business' survives across
-- deals". Under CASCADE that last clause was false the moment a deal went
-- away — the deal's whole trail would go with it.
--
-- Everything else about the column already agrees with the header and only
-- the referential action did not. It is nullable and always has been; a null
-- `opportunity_id` is the routine shape rather than an edge case
-- (`crm-outreach.ts` writes one for every DM, because a DM goes to the
-- business rather than to a deal, and `crm-writes.ts` writes one for every
-- change to the organisation's own fields); `organisationTimeline` in
-- `crm-repo.ts` already types the column `string | null` on the way out; and
-- `contact_id` beside it (0019:152) was already `ON DELETE SET NULL` for the
-- same reason. CASCADE was the outlier, contradicting the sentence directly
-- above it.
--
-- ══ THE ACTION IS DORMANT, AND THAT IS WHY IT IS CHEAP TO FIX NOW ══
--
-- No code in this tree deletes a single opportunity, and #251 settled on a
-- VOID — a `voided_at` column, 0049 — rather than a delete, so nothing is
-- about to. The one path that removes opportunity rows at all is
-- `deleteOrganisation`, which deletes them wholesale by `organisation_id` on
-- its way to deleting the organisation; there the activities are destroyed by
-- `crm_activities.organisation_id`'s own CASCADE regardless of what this
-- constraint says.
--
-- So this changes no observable behaviour today, and that is the argument for
-- doing it rather than against: the cost of correcting a referential action
-- is exactly zero while no delete exists, and it is a debate about live data
-- the first time one does. What it buys is that a future delete of a single
-- deal detaches its history instead of destroying it, without whoever writes
-- that delete having to notice the constraint first.
--
-- ══ NO DATA CHANGES ══
--
-- Re-pointing a foreign key's delete action rewrites no rows: every existing
-- activity keeps the `opportunity_id` it has.
--
-- One second-order effect, and it is the intended one: `crm_activities_opp_-
-- recent_idx` is partial on `WHERE opportunity_id IS NOT NULL`, so a detached
-- activity leaves that index. It should — it is no longer scoped to a deal.
-- `crm_activities_org_recent_idx` is unconditional and still carries it, which
-- is the index the organisation timeline reads.
--
-- Written as DROP-then-ADD so re-application is a no-op rather than an abort:
-- `scripts/db-migrate.mjs` stops at the first migration that throws and every
-- later migration then silently stops being applied (tesserix-home#509).

ALTER TABLE crm_activities
  DROP CONSTRAINT IF EXISTS crm_activities_opportunity_id_fkey;

ALTER TABLE crm_activities
  ADD CONSTRAINT crm_activities_opportunity_id_fkey
    FOREIGN KEY (opportunity_id) REFERENCES crm_opportunities(id) ON DELETE SET NULL;
