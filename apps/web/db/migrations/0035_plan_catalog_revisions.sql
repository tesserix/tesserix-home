-- The catalog becomes versioned, per-mode, and per-product.
--
-- WHY A REVISION AT ALL. Editing must not touch what Stripe currently
-- reflects, and the parity check must have an unambiguous answer to "compare
-- against what?". One published revision per mode answers both, and the audit
-- trail falls out rather than being built.
--
-- WHY PUBLICATION IS A SEPARATE TABLE. A status column on the revision cannot
-- express "test is ahead of live", which is the NORMAL state here: live has
-- never been bootstrapped. Publication is a fact about a (mode, revision)
-- pair, not about a revision.

CREATE TABLE IF NOT EXISTS plan_catalog_revisions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    note       text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    -- The common ancestor. A plan is three-way — draft vs ancestor tells us
    -- what the operator INTENDED, draft vs Stripe tells us what DRIFTED, and
    -- without the distinction publishing silently reverts a Dashboard edit and
    -- nobody is told.
    based_on_revision_id uuid REFERENCES plan_catalog_revisions (id)
);

ALTER TABLE plan_catalog_prices
    ADD COLUMN IF NOT EXISTS revision_id uuid REFERENCES plan_catalog_revisions (id) ON DELETE CASCADE;

-- WHY `source` NOW. It costs nothing at 42 rows and is expensive once two
-- products share the table: retrofitting a discriminator means backfilling
-- live data and auditing every query that assumed one product, including the
-- parity check whose window gates a key revocation. Mirrors how entity rows
-- already carry their source (contract §8.9).
ALTER TABLE plan_catalog_prices
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'mark8ly';

INSERT INTO plan_catalog_revisions (id, note, created_by)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Baseline: the catalog as seeded by 0032, before authoring existed.',
    'migration:0035'
)
ON CONFLICT (id) DO NOTHING;

UPDATE plan_catalog_prices
   SET revision_id = '00000000-0000-0000-0000-000000000001'
 WHERE revision_id IS NULL;

ALTER TABLE plan_catalog_prices ALTER COLUMN revision_id SET NOT NULL;

-- The default existed only to make the ALTER succeed on a populated table.
-- Dropping it means a future writer must STATE the source rather than inherit
-- one — the same reasoning 0034 applied to `mode`.
ALTER TABLE plan_catalog_prices ALTER COLUMN source DROP DEFAULT;

-- NOT OPTIONAL, AND NOT A FOLLOW-UP. 0032 made `lookup_key` globally unique.
-- A draft and the published revision both hold
-- `mark8ly_pro_annual_developed_v1`, so draft creation fails on its FIRST
-- insert while the application looks buggy for a reason it cannot see.
ALTER TABLE plan_catalog_prices DROP CONSTRAINT IF EXISTS plan_catalog_prices_lookup_key_key;

-- Dropped and re-added rather than assumed present: Postgres has no
-- "ADD CONSTRAINT IF NOT EXISTS" for a UNIQUE constraint, and this migration
-- is applied by hand and must survive being run twice against the same
-- database without erroring on the second pass.
ALTER TABLE plan_catalog_prices
    DROP CONSTRAINT IF EXISTS plan_catalog_prices_lookup_key_unique_per_revision;
ALTER TABLE plan_catalog_prices
    ADD CONSTRAINT plan_catalog_prices_lookup_key_unique_per_revision
    UNIQUE (revision_id, source, lookup_key);

CREATE TABLE IF NOT EXISTS plan_catalog_publications (
    -- SURROGATE, not (mode, revision_id): re-publishing a previously
    -- superseded revision is a second row for the same pair.
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mode          text NOT NULL
                  CONSTRAINT plan_catalog_publications_mode_is_a_stripe_mode
                  CHECK (mode IN ('test', 'live')),
    -- RESTRICT, NOT CASCADE, and the difference matters. `prices.revision_id`
    -- cascades so discarding a draft is one delete. If this cascaded too, that
    -- same cleanup would silently erase who published what and when, out from
    -- under the parity runs that reference it.
    revision_id   uuid NOT NULL REFERENCES plan_catalog_revisions (id) ON DELETE RESTRICT,
    published_at  timestamptz NOT NULL DEFAULT now(),
    published_by  text NOT NULL,
    superseded_at timestamptz,
    superseded_by text,

    CONSTRAINT plan_catalog_publications_supersession_is_coherent
    CHECK ((superseded_at IS NULL) = (superseded_by IS NULL))
);

-- A CEILING, never a floor. Postgres cannot express "at least one", so
-- "exactly one published" is a property of the publish TRANSACTION (retire
-- then promote, under an advisory lock on the mode), not of this schema.
-- Claiming otherwise would be claiming more than is enforced.
CREATE UNIQUE INDEX IF NOT EXISTS plan_catalog_publications_one_live_per_mode
    ON plan_catalog_publications (mode) WHERE superseded_at IS NULL;

INSERT INTO plan_catalog_publications (mode, revision_id, published_by)
SELECT 'test', '00000000-0000-0000-0000-000000000001', 'migration:0035'
WHERE NOT EXISTS (
    SELECT 1 FROM plan_catalog_publications WHERE mode = 'test' AND superseded_at IS NULL
);

-- WHICH catalog was that run clean against? Once "published" is mutable, a
-- `clean` row from three days ago is ambiguous — and this table exists
-- precisely to be trustworthy after the fact. `publication_id` carries both
-- the mode and the revision, so it is a better answer than either alone.
ALTER TABLE plan_catalog_parity_runs
    ADD COLUMN IF NOT EXISTS publication_id uuid REFERENCES plan_catalog_publications (id);

CREATE INDEX IF NOT EXISTS plan_catalog_parity_runs_publication_id
    ON plan_catalog_parity_runs (publication_id);
