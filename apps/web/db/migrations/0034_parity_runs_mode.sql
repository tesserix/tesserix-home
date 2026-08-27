-- The parity check covers BOTH Stripe modes, so a run has to say which one it
-- was.
--
-- 0033 was written when there was one key and one account, and a row that does
-- not name its mode is unreadable the moment there are two: `clean` means
-- nothing if you cannot tell which account it was clean against.
--
-- # What this changes about the gate
--
-- #327's gate becomes "7 consecutive days where BOTH modes are clean", and it
-- falls out of this schema without special-casing. `not_bootstrapped` is not
-- `clean`, so "both modes clean" already requires live to have a real catalog
-- — which, as of 2026-08-27, it does not: the live account holds ZERO
-- `mark8ly_*` prices, zero products and zero subscriptions. The catalog exists
-- only in test mode. That is a deliberate parking of #327 behind a live
-- bootstrap, made visible by the data rather than asserted in a comment.
--
-- # The state that must not be collapsed
--
-- A mode with ZERO namespace prices is `not_bootstrapped`, NOT 42
-- `price_missing_in_stripe` differences.
--
-- Reporting 42 differences nightly for a mode nobody has launched is noise
-- that trains people to ignore the report — and the report is the only
-- evidence the window is made of. `not_bootstrapped` says "nothing here yet";
-- `differences` says "something here is wrong". They are different facts and
-- the table must be able to hold them apart.
--
-- ONLY ZERO COUNTS. A partial bootstrap — say 20 of 42 — is genuinely
-- `differences` and is stored as such. That is the case where someone ran the
-- tool and it half-worked, which is considerably more dangerous than not
-- having run it at all, and it must not hide behind "nothing here yet".

-- Added WITH a default and then stripped of it, in that order and for two
-- different reasons.
--
-- The default is what lets the ALTER succeed on a table that already has rows.
-- `test` is the honest backfill: every run recorded before this migration was
-- made against the only credential that existed, and that credential was
-- `sk_test_`. Prod is at v33 with zero rows so nothing is actually backfilled
-- there, but dev databases have rows and a migration that cannot be rehearsed
-- is a migration applied blind.
ALTER TABLE plan_catalog_parity_runs
    ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'test';

-- And then the default GOES, which is the part that matters going forward.
-- With it in place a writer that forgot the mode would file a live run as a
-- test run, and "both modes clean" would be satisfiable by one mode answering
-- twice — the exact failure this whole column exists to prevent. Every future
-- writer states its mode.
ALTER TABLE plan_catalog_parity_runs
    ALTER COLUMN mode DROP DEFAULT;

-- Stripe has exactly two modes. A third value stored here would be a mode the
-- window query never counts, which is indistinguishable from a mode that is
-- never clean.
ALTER TABLE plan_catalog_parity_runs
    DROP CONSTRAINT IF EXISTS plan_catalog_parity_runs_mode_is_a_known_mode;
ALTER TABLE plan_catalog_parity_runs
    ADD CONSTRAINT plan_catalog_parity_runs_mode_is_a_known_mode
    CHECK (mode IN ('test', 'live'));

-- FOUR STATES NOW. `not_bootstrapped` joins 0033's three.
--
-- Dropped and re-added rather than edited, because Postgres has no "alter
-- CHECK". 0033's three values are all still here; see the mode suite in
-- `plan-catalog-parity-runs-mode.integration.test.ts`, which re-proves each of
-- 0033's rejections against the recreated constraint so a clause lost in this
-- rewrite cannot pass unnoticed.
ALTER TABLE plan_catalog_parity_runs
    DROP CONSTRAINT IF EXISTS plan_catalog_parity_runs_outcome_is_a_known_state;
ALTER TABLE plan_catalog_parity_runs
    ADD CONSTRAINT plan_catalog_parity_runs_outcome_is_a_known_state
    CHECK (outcome IN ('clean', 'differences', 'failed', 'not_bootstrapped'));

-- An incoherent row stays unstorable, and `not_bootstrapped` joins the rule
-- rather than being excused from it.
--
-- It carries a zero count for exactly the reason `clean` does: there was
-- nothing to differ from. A row claiming both "nothing here yet" and "42
-- findings" is the incoherence that would make the window's answer worthless a
-- week later, and it is precisely the row a runner would write if it decided
-- `not_bootstrapped` but forgot to discard the comparator's report.
--
-- `failed` remains unconstrained here: a run that could not reach Stripe
-- produced no comparison, and asserting anything about its count would be
-- asserting something about a comparison that never ran.
ALTER TABLE plan_catalog_parity_runs
    DROP CONSTRAINT IF EXISTS plan_catalog_parity_runs_outcome_matches_difference_count;
ALTER TABLE plan_catalog_parity_runs
    ADD CONSTRAINT plan_catalog_parity_runs_outcome_matches_difference_count
    CHECK (
        (outcome = 'clean'            AND difference_count = 0) OR
        (outcome = 'not_bootstrapped' AND difference_count = 0) OR
        (outcome = 'differences'      AND difference_count > 0) OR
         outcome = 'failed'
    );

-- 0033's `error` rule is deliberately NOT touched, and that is a decision
-- rather than an omission: it reads "error IS NOT NULL exactly when outcome =
-- 'failed'", so it already refuses an error on a `not_bootstrapped` row. That
-- is the right answer. `not_bootstrapped` is an ANSWER — the check ran, it
-- read the account, and the account was empty. Nothing failed, so there is no
-- reason to record.

-- The window query is PER MODE — "is this mode clean for 7 consecutive days"
-- is asked twice, never once across both. Leading on `mode` so each of those
-- two questions is one index range rather than a scan filtered afterwards.
-- 0033's `(ran_at DESC)` index stays for the un-moded "what happened lately"
-- read.
CREATE INDEX IF NOT EXISTS plan_catalog_parity_runs_mode_ran_at
    ON plan_catalog_parity_runs (mode, ran_at DESC);

-- No backfill beyond the column default, and no seed. Live has never run, so
-- live has no rows — and inventing one would be inventing evidence for the
-- window this table exists to make honest.
