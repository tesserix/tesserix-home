-- 0026_crm_attribute_instagram_leads_to_mark8ly.sql
--
-- Attribute the migrated Instagram outreach leads to Mark8ly.
--
-- WHY THIS IS NOT THE THING 0019 FORBIDS. `crm_opportunities.product` carries
-- the note "inventing one at import fabricates attribution the funnel later
-- reports as fact", and the leads migration honoured it: every one of the 259
-- rows landed with a null product because the old `leads` table recorded no
-- product and the script had nothing to derive one from. That guard is about a
-- *script inferring* attribution it cannot know. It is not a bar on the
-- operator stating it. These leads were scraped for Mark8ly; the fact was
-- always known, it simply lived outside the database.
--
-- SCOPED TO `source = 'instagram_outreach'` ON PURPOSE, not to "every null
-- product". All 259 rows carry that source today, so the two predicates select
-- the same set — but they stop meaning the same thing the moment a second
-- product's leads arrive. Writing the narrower one means this migration cannot
-- sweep up a future Kora or HMS lead that happens to be sitting unattributed,
-- which the broad form would do silently and irreversibly.
--
-- NO ACTIVITY ROWS. `advanceStage` writes a "Product set to X (was none)"
-- activity when a product moves under a live deal, and that is right: changing
-- attribution beneath someone's in-flight work should be visible. This is not
-- that. These are 259 never-worked leads at stage `new` receiving their first
-- attribution, and 259 synthetic activity rows would bury the outreach record
-- the activity log exists to hold. Same reasoning the leads migration used for
-- declining to write `stage_change`.
--
-- SAFE AGAINST THE CHECK. `crm_opp_product_required_when_qualified` is
-- `NOT VALID`, so it is enforced on every UPDATE. Setting a product only ever
-- satisfies it further — the constraint's failure mode is a null product at
-- `qualified`/`won`/`lost`, and this migration moves rows away from that, not
-- toward it.
--
-- Idempotent: re-running matches nothing once the rows carry a product.
UPDATE crm_opportunities
   SET product    = 'mark8ly',
       updated_at = now()
 WHERE product IS NULL
   AND source = 'instagram_outreach';
