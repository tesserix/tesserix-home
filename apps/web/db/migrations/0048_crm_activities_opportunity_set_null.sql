-- 0048_crm_activities_opportunity_set_null.sql
--
-- Deleting an opportunity must not delete what we said to the business
-- (tesserix-home#251).
--
-- ══ WHY NOW ══
--
-- An opportunity has no delete of any kind today, so `ON DELETE CASCADE` on
-- `crm_activities.opportunity_id` has never actually fired: nothing in the
-- console issues a `DELETE FROM crm_opportunities`. #251 adds one, because the
-- only disposal a mis-clicked duplicate deal currently has is marking it
-- `lost`, which requires inventing a `lost_reason` and then pollutes every
-- close-rate and loss-analysis number computed off the stage. The moment that
-- delete exists, CASCADE stops being dormant and starts destroying history: a
-- deal worked for three DMs and then found to be a duplicate would take the
-- whole record of those DMs with it. That is unrecoverable, and it is the one
-- outcome the delete is not supposed to have.
--
-- ══ SET NULL IS WHAT THE SCHEMA ALREADY SAYS ══
--
-- 0019's own header over this table reads: the event log is "always attached
-- to the organisation, optionally scoped to a deal or a person: 'everything we
-- have ever said to this business' survives across deals". The column is
-- nullable and always has been, `contact_id` beside it is already
-- `ON DELETE SET NULL`, and a null `opportunity_id` is a routine shape rather
-- than an edge case — `crm-outreach.ts` writes one for every DM (a DM goes to
-- the business, not to a deal), `crm-writes.ts` writes one for every change to
-- the organisation's own fields, and `organisationTimeline` in `crm-repo.ts`
-- already types the column `string | null` on the way out.
--
-- So CASCADE was the outlier, contradicting the sentence directly above it.
-- This migration makes the constraint agree with the comment.
--
-- ══ NO DATA CHANGES ══
--
-- Re-pointing a foreign key's delete action rewrites no rows: every existing
-- activity keeps the `opportunity_id` it has. Only the behaviour of a FUTURE
-- `DELETE FROM crm_opportunities` differs, and there are no such deletes in
-- the tree yet (#251 Task 2 adds the first).
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
