-- The parity check is per (mode, SOURCE), so a run has to say which catalog it
-- checked — not just which Stripe account.
--
-- 0034 added `mode` for the same reason one step over: a row that does not name
-- its mode is unreadable the moment there are two accounts. `source` is the
-- second axis. `plan_catalog_prices` has carried a `source` column since 0035
-- ("WHY `source` NOW. It costs nothing at 42 rows and is expensive once two
-- products share the table"), and this is the half of that argument 0035 did
-- not finish: the catalog rows are discriminated by source, the runs that check
-- them are not.
--
-- # What goes wrong without it — an OMISSION, not a wrong answer
--
-- Today there is exactly one source, `'mark8ly'`, so one run per mode covers
-- the whole catalog and mode-keying is accidentally sufficient. The day a
-- second source's rows land in `plan_catalog_prices`, a mode-keyed run can no
-- longer speak for both catalogs. The second source's drift would never be
-- compared against anything, and — this is the dangerous part — nothing would
-- look wrong, because the mark8ly rows still come back `clean` and the window
-- still reads as satisfied. That is the silent omission tesserix-home#392
-- fixes, and it is worth fixing before the second source exists rather than
-- after, because afterwards the fix is a backfill of live evidence.
--
-- # `plan_catalog_publications` is deliberately NOT given a source
--
-- 0036 constrains `outcome <> 'clean' OR publication_id IS NOT NULL`, and that
-- constraint needs NO change here. `plan_catalog_publications` (0035) is keyed
-- by mode alone: a publication is a fact about a (mode, revision) pair, and a
-- revision holds prices for every source. So one `publication_id` legitimately
-- serves both sources' runs within a mode, and a per-(mode, source) run naming
-- a per-mode publication is coherent rather than sloppy. Stated here explicitly
-- so a later reader does not "fix" 0036 to match this migration.

-- Added WITH a default, and the default STAYS in this file. That is the one
-- place this migration departs from 0034, and it departs for a deployment
-- reason rather than a schema one.
--
-- The default is first of all what lets the ALTER succeed on a table that
-- already has rows, and `'mark8ly'` is the honest backfill rather than an
-- assumed one: prod holds 20 parity rows spanning 2026-08-27..2026-09-03, and
-- every one of them was recorded against the only catalog source that has ever
-- existed.
--
-- IT ALSO HAS TO SURVIVE THE OLD IMAGE. Migrations in this estate are applied
-- to prod BEFORE the PR that carries them is merged, because Kargo deploys on
-- merge and the migration runner does not ride along. So there is always a
-- window where this column exists and the PREVIOUS console image is still
-- serving. That image's `recordParityRun` — console image `main-de64e13`, the
-- tag the console Deployment and the CronJob both ran when this was written,
-- deliberately cited by IMAGE rather than by line because the PR carrying this
-- migration moves that function and a line number here would rot on merge —
-- inserts
-- `(mode, outcome, difference_count, differences, error, publication_id)` and
-- names no source. With `NOT NULL` and no default that insert raises, the
-- nightly `console-parity-check` CronJob (02:15 UTC, running the same image as
-- the console Deployment) writes NO row for that day, and `readWindowStatus`
-- reads a day with no clean row as not clean — i.e. a broken 7-day streak. The
-- streak is the evidence #327 revokes a Stripe write key on, and the only input
-- to it that cannot be hurried is elapsed time. A deploy in progress must not
-- cost seven days.
--
-- The default goes in `0045_parity_runs_source_drop_default.sql`, applied only
-- once the source-aware image is live. Splitting it is the whole point.
ALTER TABLE plan_catalog_parity_runs
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'mark8ly';

-- One source exists. A value outside this list would be a source the per-pair
-- window query never counts, which is indistinguishable from a source that is
-- never clean — the same failure 0034's mode CHECK prevents one axis over.
-- Adding a second source therefore becomes a deliberate migration, which is the
-- point rather than a cost.
--
-- Dropped and re-added rather than assumed absent: Postgres has no
-- `ADD CONSTRAINT IF NOT EXISTS`, and these files are applied by hand and must
-- survive being run twice against the same database.
ALTER TABLE plan_catalog_parity_runs
    DROP CONSTRAINT IF EXISTS plan_catalog_parity_runs_source_is_a_known_source;
ALTER TABLE plan_catalog_parity_runs
    ADD CONSTRAINT plan_catalog_parity_runs_source_is_a_known_source
    CHECK (source IN ('mark8ly'));

-- The window query becomes "is this (mode, source) pair clean for 7 consecutive
-- days", asked once per pair. Leading on `(mode, source)` so each of those
-- questions is one index range rather than a scan filtered afterwards — the
-- same shape 0034 chose for `(mode, ran_at DESC)`.
CREATE INDEX IF NOT EXISTS plan_catalog_parity_runs_mode_source_ran_at
    ON plan_catalog_parity_runs (mode, source, ran_at DESC);

-- 0034's `plan_catalog_parity_runs_mode_ran_at` becomes REDUNDANT with this
-- change, and is dropped in `0045_parity_runs_source_drop_default.sql` rather
-- than here.
--
-- Redundant because after tesserix-home#392 both remaining readers of this
-- table are per-(mode, source) and neither can use a mode-only index. The
-- window query above is one range per pair, which is what
-- `(mode, source, ran_at DESC)` is for. `readLatestRuns`
-- (`apps/console/lib/db/plan-catalog-repo.ts:631`) is now
-- `SELECT DISTINCT ON (mode, source) ... ORDER BY mode, source, ran_at DESC`,
-- which the new index serves exactly — its columns are that ORDER BY, in that
-- order. The old index's remaining shape, `(mode, ran_at DESC)`, is what the
-- PREVIOUS per-mode `readLatestRuns` needed and nothing needs now.
--
-- The drop is in 0045 and not in this file for the same reason 0045's
-- `DROP DEFAULT` is: during the window between the two applies, the OLD image
-- is still running, and its `readLatestRuns` is still the per-mode
-- `SELECT DISTINCT ON (mode) ... ORDER BY mode, ran_at DESC`. Dropping the
-- index it orders on here would make that query sort on top for as long as the
-- rollout takes. 0045 is already "the things that are only safe once the new
-- image is live"; this is one of them.
--
-- (At 20 rows neither index is load-bearing yet, and the sort would cost
-- nothing measurable. The reasoning is recorded because the table grows by a
-- row per pair per day, and because the two files' contents must each be
-- justifiable on their own.)

-- The `outcome`, `difference_count`, `differences` and `error` CHECKs are NOT
-- touched, and none of them is dropped and re-added here. They constrain what a
-- run FOUND; `source` says what it looked at. The two are orthogonal, so unlike
-- 0034 this migration recreates no constraint and nothing of 0033's or 0034's
-- can be silently lost in it.
