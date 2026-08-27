-- Publish the baseline catalog revision to `live` mode.
--
-- The catalog has only ever been published to `test` — 0035 inserted that row
-- and nothing has published since, because no code path creates a publication.
-- That is Plan 2's job; this is the one row the live bootstrap needs, written
-- the same way 0035 wrote test's.
--
-- # The same revision, deliberately
--
-- Live gets revision `00000000-...-0001`, the identical baseline test runs
-- against. Two modes publishing DIFFERENT revisions is a legitimate state the
-- schema is built for — "test is ahead of live" is the normal shape (0035) —
-- but it is not this state. The whole point of #385's bootstrap is that live
-- ends up holding what the catalog already says, and the cheapest way to make
-- that true is to point both modes at one revision. A second revision here
-- would be inventing a difference nobody asked for.
--
-- # Why this lands before the bootstrap, not with it
--
-- `runBootstrap` refuses a mode whose catalog read returns nothing
-- (`apps/console/lib/billing/bootstrap.ts`), so live cannot be bootstrapped
-- until this row exists. Landing it now takes a database migration off the
-- critical path of the day someone runs a Stripe write key against a live
-- account, which is a day that should contain exactly one new thing.
--
-- It is also inert until then. `performParityCheck` derives
-- `not_bootstrapped` from `stripePriceCount === 0`, NOT from an empty catalog,
-- so live keeps reporting `not_bootstrapped` — the honest "nothing here yet" —
-- exactly as it does today. What changes is that the row now names the
-- publication it checked, which is what 0036 requires of a `clean` row and
-- what #327 will read as evidence.
--
-- # What this does NOT do
--
-- It does not create anything in Stripe, and it does not make live's parity
-- run clean. Live holds zero `mark8ly_*` prices until the bootstrap runs with
-- a live write key (mark8ly#371). This row is the catalog side of that
-- agreement, published in advance and alone.
--
-- Guarded by NOT EXISTS on the same (mode, un-superseded) shape as the unique
-- index `plan_catalog_publications_one_live_per_mode`, so a second run is a
-- no-op rather than a constraint violation — this file is applied by hand.

INSERT INTO plan_catalog_publications (mode, revision_id, published_by)
SELECT 'live', '00000000-0000-0000-0000-000000000001', 'migration:0037'
WHERE NOT EXISTS (
    SELECT 1 FROM plan_catalog_publications WHERE mode = 'live' AND superseded_at IS NULL
);
