-- A `clean` parity run must name the catalog it was clean against.
--
-- 0035 added `plan_catalog_parity_runs.publication_id` — the column answering
-- *which* catalog a run checked — and left it unconstrained. This closes that.
--
-- # The invariant already holds, and that is the problem
--
-- It holds because two functions in `apps/console/lib/db/plan-catalog-repo.ts`
-- share a WHERE clause: `readCatalogAmounts` and `readLivePublication` both
-- filter `pub.mode = $1 AND pub.superseded_at IS NULL`. So a mode with no
-- publication yields an empty catalog and a null publication together, and
-- `clean` requires `stripePriceCount > 0`, which requires a non-empty catalog,
-- which requires a publication.
--
-- That is a real guarantee. It is also one refactor away from silently
-- ceasing to hold, in a table whose entire purpose is to be trustworthy after
-- the fact — and nothing would fail loudly when it stopped.
--
-- # It matches the standard this table set for itself
--
-- 0033 established belt-and-braces CHECKs for every field the observation
-- window depends on: `..._outcome_matches_difference_count`,
-- `..._error_belongs_to_failed`, `..._differences_is_an_array`, each commented
-- as protecting "the window a write-key revocation rests on".
-- `publication_id` is described in 0035 as evidence for that same gate and was
-- the one field left unenforced. See tesserix-home#382.
--
-- # Why now, specifically
--
-- Nothing reads `publication_id` as evidence yet; #327 is where that starts.
-- The constraint has to exist BEFORE that, because after it an unenforced
-- column is a row free to claim a catalog it never checked.
--
-- Applying this is free today and will not stay free: verified against prod on
-- 2026-08-27, `plan_catalog_parity_runs` holds ZERO rows, so there is nothing
-- to backfill and nothing that can violate the constraint on the way in. Once
-- the nightly CronJob (tesserix-k8s#653) starts recording, a `clean` row
-- written by an older console image with a null `publication_id` would make
-- this ALTER fail and need a backfill decision — and backfilling a run's
-- publication after the fact is precisely the false claim this prevents.
--
-- Dropped first so the migration survives being run twice: Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS, and this file is applied by hand.

ALTER TABLE plan_catalog_parity_runs
    DROP CONSTRAINT IF EXISTS plan_catalog_parity_runs_clean_names_its_publication;

ALTER TABLE plan_catalog_parity_runs
    ADD CONSTRAINT plan_catalog_parity_runs_clean_names_its_publication
    CHECK (outcome <> 'clean' OR publication_id IS NOT NULL);
