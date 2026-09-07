-- A parity run has to say WHAT it compared, not only which (mode, source) it
-- compared it for.
--
-- Until now `plan_catalog_parity_runs` held exactly one kind of evidence: the
-- catalog's prices against Stripe's Price objects. tesserix-home#146 adds a
-- second, structurally identical one — the console's `plan_catalog_entitlements`
-- against the plan-feature matrix mark8ly's `plangate` actually enforces — and
-- the two are read by DIFFERENT people to answer DIFFERENT questions. Storing
-- both under the same (mode, source) key with nothing to tell them apart is not
-- a tidiness problem; it silently changes what the existing readers report.
--
-- # What goes wrong without this column, concretely
--
-- All three readers of this table key on (mode, source) alone:
--
--   * `readWindowStatus` — #327's gate — calls a day clean when a `clean` row
--     exists for the pair AND no non-clean row does. An entitlement run
--     recorded on a day the PRICE check never ran would make that day read
--     clean, and #327 revokes mark8ly's Stripe write key on seven such days.
--     That is a FALSE GREEN on a credential revocation, produced by a check
--     that never looked at Stripe at all.
--   * `readLatestRuns` — the operator's "what did the last run find?" card.
--     It would show whichever kind ran last, and `summarizeDifferences`
--     (`catalog-views.tsx`) labels a finding by its `kind`, which an
--     entitlement difference does not carry. A price surface would render an
--     entitlement report with no labels.
--   * `readLastCleanRuns` — the `..._parity_last_clean_timestamp_seconds`
--     gauge, whose whole job is to alert when the price check goes SILENT. A
--     nightly entitlement run would keep that timestamp fresh forever with the
--     price check dead.
--
-- The design doc for #146 says entitlement runs record "the real mode they
-- compared — no sentinel meaning not applicable", and that is right; it simply
-- does not follow that the two kinds may share a row space undiscriminated.
-- This column is what makes the shared table honest, and every existing reader
-- gains `check_kind = 'price'` in the same commit, so what they report is
-- unchanged to the row.
--
-- # Why one table and not a second one
--
-- The two runs have the same shape (mode, source, outcome, differences, error,
-- publication_id), the same four outcomes, the same "a missing day is not
-- clean" reading, and the same operator. A second table would be a second copy
-- of 0033's, 0034's and 0036's CHECK reasoning to keep in agreement — the exact
-- duplication #326 exists to remove. A discriminator column is the cheaper half
-- of that trade, and it is the half that keeps a future "is EVERYTHING about
-- this catalog clean?" query a single scan.

-- Added WITH a default, and the default STAYS in this file, for 0044's
-- deployment reason verbatim: migrations here are applied to prod BEFORE the PR
-- carrying them merges, so there is always a window where this column exists
-- and the PREVIOUS console image is still serving. That image's
-- `recordParityRun` inserts (mode, source, outcome, difference_count,
-- differences, error, publication_id) and names no check kind. With NOT NULL
-- and no default that insert raises, the nightly `console-parity-check`
-- CronJob writes no row for the day, and `readWindowStatus` reads a day with no
-- clean row as not clean — a broken 7-day streak, and elapsed time is the one
-- input to #327's gate that cannot be hurried.
--
-- `'price'` is the honest backfill and not an assumed one: every row this table
-- has ever held was written by `performParityCheck`, which compares the catalog
-- against Stripe and nothing else.
--
-- Dropping the default belongs in a later migration applied once the
-- check-kind-aware image is live, exactly as 0045 does for `source`. It is not
-- urgent here for a reason 0044 did not have: both writers in the new image
-- state their kind explicitly, and the only writer that omits it is the old
-- image, which writes price runs and would be backfilled correctly anyway.
ALTER TABLE plan_catalog_parity_runs
    ADD COLUMN IF NOT EXISTS check_kind text NOT NULL DEFAULT 'price';

-- Two kinds exist. A third value stored here would be evidence no reader
-- counts, which is indistinguishable from evidence that is never clean — the
-- same failure 0034's mode CHECK and 0044's source CHECK prevent on the other
-- two axes. A third kind of parity therefore becomes a deliberate migration,
-- which is the point rather than a cost.
--
-- Dropped and re-added rather than assumed absent: Postgres has no
-- `ADD CONSTRAINT IF NOT EXISTS`, and these files are applied by hand and must
-- survive being run twice against the same database.
ALTER TABLE plan_catalog_parity_runs
    DROP CONSTRAINT IF EXISTS plan_catalog_parity_runs_check_kind_is_a_known_kind;
ALTER TABLE plan_catalog_parity_runs
    ADD CONSTRAINT plan_catalog_parity_runs_check_kind_is_a_known_kind
    CHECK (check_kind IN ('price', 'entitlement'));

-- Every read of this table is now "this KIND, for this (mode, source) pair,
-- most recently / per day", so the discriminator leads the index that 0044's
-- `(mode, source, ran_at DESC)` used to serve alone. Leading on `check_kind`
-- rather than appending it keeps each of those questions one index range
-- instead of a range filtered afterwards, which is 0034's and 0044's reasoning
-- one column further left.
--
-- 0044's index is NOT dropped here. It is still exactly the right shape for a
-- reader that wants a pair's runs of any kind, and dropping an index in the
-- same migration that adds its replacement is what 0044 declined to do for the
-- same reason: the previous image is still serving, and its queries carry no
-- `check_kind` predicate at all.
CREATE INDEX IF NOT EXISTS plan_catalog_parity_runs_kind_mode_source_ran_at
    ON plan_catalog_parity_runs (check_kind, mode, source, ran_at DESC);

-- 0033's, 0034's and 0036's CHECKs are NOT touched and none is dropped and
-- re-added here. They constrain what a run FOUND and which catalog it names;
-- `check_kind` says which of the two comparisons produced it. They are
-- orthogonal, so — as in 0044 — this migration recreates no constraint and
-- nothing of the earlier files' can be silently lost in it.
--
-- In particular 0036's `outcome <> 'clean' OR publication_id IS NOT NULL`
-- holds for entitlement runs unchanged and needs no exemption: entitlements
-- hang off `plan_catalog_revisions`, so an entitlement run reads the mode's
-- live publication to know WHICH revision's rows to compare, and a clean one
-- always has that publication's id to name.
