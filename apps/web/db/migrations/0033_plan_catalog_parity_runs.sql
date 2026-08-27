-- The record of every plan-catalog parity check, so #326's observation window
-- is a QUERY and not somebody's recollection.
--
-- The window the issue asks for is "clean for 7 consecutive days", and it gates
-- #327 and, through it, mark8ly #303/#304/#305 — P2 revokes mark8ly's Stripe
-- write key on the strength of it. A claim that large has to be answerable from
-- stored rows by anyone, at any later date, without having watched the days go
-- by. That is the only reason this table exists; the check itself would run
-- perfectly well writing nothing.
--
-- What follows is therefore mostly constraints. They exist because the value of
-- the window is exactly the trustworthiness of these rows, and a row that can
-- lie is worse than no row: it produces a confident wrong answer instead of an
-- obvious gap.

CREATE TABLE IF NOT EXISTS plan_catalog_parity_runs (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- When the check RAN, defaulted rather than taken from the caller: the
    -- runner is a CronJob whose clock is not this database's, and the whole
    -- table is read by date arithmetic ("7 consecutive days"). One clock.
    ran_at           timestamptz NOT NULL DEFAULT now(),

    -- THREE STATES, DELIBERATELY NOT A BOOLEAN.
    --
    -- A run that could not reach Stripe is NOT clean. With a boolean, an
    -- outage either reads as a difference (noise that buries a real finding)
    -- or, far worse, reads as clean — a day the window counts towards its
    -- seven on the strength of a check that never happened. `failed` is what
    -- makes an unreachable Stripe visible as itself.
    outcome          text NOT NULL
                     CONSTRAINT plan_catalog_parity_runs_outcome_is_a_known_state
                     CHECK (outcome IN ('clean', 'differences', 'failed')),

    -- A materialised `jsonb_array_length(differences)`, kept as its own column
    -- because the window query filters and aggregates on it and should not
    -- unpack a jsonb document per row to do so. The CHECK further down is what
    -- stops the summary and the evidence ever telling different stories.
    difference_count integer NOT NULL DEFAULT 0
                     CONSTRAINT plan_catalog_parity_runs_difference_count_is_not_negative
                     CHECK (difference_count >= 0),

    -- The full report, verbatim, as `lib/billing/parity.ts` produced it.
    --
    -- Stored whole rather than summarised because a finding has to stay
    -- actionable a week after the run that produced it — `lookup_key`,
    -- currency and BOTH values, so nobody has to re-query Stripe to understand
    -- what a stored difference meant. It is also how the VND question
    -- (`zeroDecimalSuspect`) survives to be read by a human.
    differences      jsonb NOT NULL DEFAULT '[]'
                     CONSTRAINT plan_catalog_parity_runs_differences_is_an_array
                     CHECK (jsonb_typeof(differences) = 'array'),

    -- Why the run failed. `text`, not the driver's error object: it is read by
    -- an operator, and it must never carry a credential or a connection string.
    error            text,

    -- An incoherent row is unstorable, not merely discouraged.
    --
    -- `clean` implies no differences and `differences` implies at least one.
    -- Without this, a bug in the runner that wrote `clean` alongside a report
    -- would make the window read as satisfied while the evidence in the same
    -- row said otherwise — and the window is the thing a write-key revocation
    -- rests on.
    --
    -- `failed` is unconstrained here on purpose: a run that could not reach
    -- Stripe produced no report, and asserting anything about its count would
    -- be asserting something about a comparison that never ran.
    CONSTRAINT plan_catalog_parity_runs_outcome_matches_difference_count
    CHECK (
        (outcome = 'clean'       AND difference_count = 0) OR
        (outcome = 'differences' AND difference_count > 0) OR
         outcome = 'failed'
    ),

    -- The summary cannot drift from the evidence it summarises.
    --
    -- GUARDED ON `jsonb_typeof` FIRST, AND NOT FOR TIDINESS. Postgres does not
    -- promise an order in which CHECK constraints are evaluated, and
    -- `jsonb_array_length` RAISES on a non-array rather than returning null.
    -- Unguarded, a `differences` value of `{}` aborts the INSERT with
    -- `cannot get array length of a non-array` and NAMES NO CONSTRAINT, so the
    -- one message an operator gets tells them nothing about which rule they
    -- broke. With the guard, a non-array falls through to
    -- `plan_catalog_parity_runs_differences_is_an_array`, which says so.
    CONSTRAINT plan_catalog_parity_runs_count_matches_differences
    CHECK (
        jsonb_typeof(differences) <> 'array' OR
        difference_count = jsonb_array_length(differences)
    ),

    -- `error` is set exactly when `outcome = 'failed'`, in both directions.
    --
    -- A `failed` row with no reason is a gap in the window nobody can diagnose
    -- later, which is the same invisibility the three-state outcome exists to
    -- prevent. An `error` on a `clean` row is a contradiction that would make
    -- a reader distrust every other row in the table.
    CONSTRAINT plan_catalog_parity_runs_error_belongs_to_failed
    CHECK (
        (outcome  = 'failed' AND error IS NOT NULL) OR
        (outcome <> 'failed' AND error IS NULL)
    )
);

-- The window query reads the most recent days and nothing else. DESC because
-- every question asked of this table is about the recent past; the table grows
-- by one row a day and will never need more than this.
CREATE INDEX IF NOT EXISTS plan_catalog_parity_runs_ran_at
    ON plan_catalog_parity_runs (ran_at DESC);

-- No seed. An empty table is the honest state on the day this deploys: the
-- window has not started, and it starts when the first run writes a row — not
-- when the migration lands.
