-- The Mark8ly plan catalog, mirrored from `mark8ly` service
-- `internal/billing/pricing/catalog.go`, so #326's drift check has a local
-- expected side to compare Stripe against. Read-only mirror: nothing in this
-- estate writes to Stripe, ever.
--
-- Two tables rather than one, because the one-table shape is precisely what
-- makes a naive comparator wrong. A `developed` descriptor is ONE Stripe Price
-- whose `currency_options` carry six further currencies; a flat 78-row table
-- loses the fact that seven of those rows are a single Price, and the
-- comparator then tries to match 78 catalog rows against 42 Stripe Prices and
-- reports 36 phantom "missing" Prices on its first run. The join below is the
-- fan-out, modelled once here rather than reconstructed by every reader.
--
-- Counts, measured from the catalog rather than taken from the issue (whose
-- phased-plan comment says 81, and is wrong):
--   42 prices  = 6 developed descriptors (3 plans x 2 periods)
--              + 36 ppp descriptors      (6 descriptors x 6 ppp currencies)
--   78 amounts = 42 developed (6 x 7 currencies) + 36 ppp (36 x 1)

CREATE TABLE IF NOT EXISTS plan_catalog_prices (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The join key to Stripe. `lookup_key` is what the catalog and Stripe
    -- genuinely share; a Stripe price id (`price_...`) differs per mode and
    -- per account, so keying on one would make this table unusable against
    -- test mode and unportable if the account is ever rebuilt.
    lookup_key text NOT NULL UNIQUE,

    -- No CHECK on `plan`, deliberately, unlike `period` and `tier` below. The
    -- plan names are an open vocabulary — a fourth plan is a product decision
    -- that should not also be a schema migration. `period` and `tier` are
    -- closed: a third billing period or a third pricing tier would change the
    -- comparator's arithmetic, so it should have to be declared here first.
    plan       text NOT NULL,

    period     text NOT NULL
               CONSTRAINT plan_catalog_prices_period_is_a_billing_period
               CHECK (period IN ('monthly', 'annual')),

    tier       text NOT NULL
               CONSTRAINT plan_catalog_prices_tier_is_a_pricing_tier
               CHECK (tier IN ('developed', 'ppp')),

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_catalog_amounts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    price_id          uuid NOT NULL REFERENCES plan_catalog_prices (id) ON DELETE CASCADE,

    -- Stripe's currency codes are lowercase, always. Without this CHECK a
    -- `USD` row and a `usd` row can coexist, which does not fail anything
    -- loudly — it silently double-counts in every aggregate the comparator
    -- computes, and reports the same price as both present and missing.
    currency          text NOT NULL
                      CONSTRAINT plan_catalog_amounts_currency_is_lowercase_iso_4217
                      CHECK (currency ~ '^[a-z]{3}$'),

    -- Minor units (paise, cents, rupiah). bigint because IDR annual is
    -- 1_198_800_000 minor units, which is comfortably inside int4 today but
    -- one currency devaluation away from not being.
    --
    -- `> 0`, not `>= 0`: there is no free plan in this catalog, so a zero can
    -- only mean "not set" — and "not set" silently rendered as "free" is the
    -- expensive direction of that mistake.
    unit_amount_minor bigint NOT NULL
                      CONSTRAINT plan_catalog_amounts_unit_amount_is_positive
                      CHECK (unit_amount_minor > 0),

    -- Normalised, NOT stored as the catalog spells it. `catalog.go:47` reads:
    --   "exclusive" for AU GST; "" elsewhere (Stripe default)
    -- but Stripe's default is the literal value `unspecified`, and that is
    -- what the API returns when the drift check reads a Price back. So `''`
    -- in the catalog and `unspecified` in Stripe are the SAME state.
    --
    -- If this column stored `''`, the comparator would report a difference on
    -- 72 of the 78 rows the first time it ran. A check that opens with 72
    -- false positives is ignored by day two, which makes the whole 7-day
    -- window theatre. The CHECK is what makes `''` unstorable rather than
    -- merely discouraged, so the normalisation cannot be lost by a later
    -- backfill that reads catalog.go directly.
    tax_behavior      text NOT NULL
                      CONSTRAINT plan_catalog_amounts_tax_behavior_is_a_stripe_value
                      CHECK (tax_behavior IN ('inclusive', 'exclusive', 'unspecified')),

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- One amount per currency per Price. This is what a Stripe Price can
    -- actually express: `currency_options` is a map keyed by currency.
    UNIQUE (price_id, currency)
);

CREATE INDEX IF NOT EXISTS plan_catalog_amounts_currency
    ON plan_catalog_amounts (currency);

-- The seed is today's catalog, generated from the reviewed `pricing-v1.csv`
-- rather than by a build step that parses catalog.go — a second parser of that
-- file is the duplication #326 exists to remove. Inline VALUES so every amount
-- is visible to a reviewer in the diff.

INSERT INTO plan_catalog_prices (lookup_key, plan, period, tier) VALUES
    ('mark8ly_pro_annual_developed_v1',       'pro',      'annual',   'developed'),
    ('mark8ly_pro_annual_ppp_idr_v1',         'pro',      'annual',   'ppp'),
    ('mark8ly_pro_annual_ppp_inr_v1',         'pro',      'annual',   'ppp'),
    ('mark8ly_pro_annual_ppp_myr_v1',         'pro',      'annual',   'ppp'),
    ('mark8ly_pro_annual_ppp_php_v1',         'pro',      'annual',   'ppp'),
    ('mark8ly_pro_annual_ppp_thb_v1',         'pro',      'annual',   'ppp'),
    ('mark8ly_pro_annual_ppp_vnd_v1',         'pro',      'annual',   'ppp'),
    ('mark8ly_pro_monthly_developed_v1',      'pro',      'monthly',  'developed'),
    ('mark8ly_pro_monthly_ppp_idr_v1',        'pro',      'monthly',  'ppp'),
    ('mark8ly_pro_monthly_ppp_inr_v1',        'pro',      'monthly',  'ppp'),
    ('mark8ly_pro_monthly_ppp_myr_v1',        'pro',      'monthly',  'ppp'),
    ('mark8ly_pro_monthly_ppp_php_v1',        'pro',      'monthly',  'ppp'),
    ('mark8ly_pro_monthly_ppp_thb_v1',        'pro',      'monthly',  'ppp'),
    ('mark8ly_pro_monthly_ppp_vnd_v1',        'pro',      'monthly',  'ppp'),
    ('mark8ly_starter_annual_developed_v1',   'starter',  'annual',   'developed'),
    ('mark8ly_starter_annual_ppp_idr_v1',     'starter',  'annual',   'ppp'),
    ('mark8ly_starter_annual_ppp_inr_v1',     'starter',  'annual',   'ppp'),
    ('mark8ly_starter_annual_ppp_myr_v1',     'starter',  'annual',   'ppp'),
    ('mark8ly_starter_annual_ppp_php_v1',     'starter',  'annual',   'ppp'),
    ('mark8ly_starter_annual_ppp_thb_v1',     'starter',  'annual',   'ppp'),
    ('mark8ly_starter_annual_ppp_vnd_v1',     'starter',  'annual',   'ppp'),
    ('mark8ly_starter_monthly_developed_v1',  'starter',  'monthly',  'developed'),
    ('mark8ly_starter_monthly_ppp_idr_v1',    'starter',  'monthly',  'ppp'),
    ('mark8ly_starter_monthly_ppp_inr_v1',    'starter',  'monthly',  'ppp'),
    ('mark8ly_starter_monthly_ppp_myr_v1',    'starter',  'monthly',  'ppp'),
    ('mark8ly_starter_monthly_ppp_php_v1',    'starter',  'monthly',  'ppp'),
    ('mark8ly_starter_monthly_ppp_thb_v1',    'starter',  'monthly',  'ppp'),
    ('mark8ly_starter_monthly_ppp_vnd_v1',    'starter',  'monthly',  'ppp'),
    ('mark8ly_studio_annual_developed_v1',    'studio',   'annual',   'developed'),
    ('mark8ly_studio_annual_ppp_idr_v1',      'studio',   'annual',   'ppp'),
    ('mark8ly_studio_annual_ppp_inr_v1',      'studio',   'annual',   'ppp'),
    ('mark8ly_studio_annual_ppp_myr_v1',      'studio',   'annual',   'ppp'),
    ('mark8ly_studio_annual_ppp_php_v1',      'studio',   'annual',   'ppp'),
    ('mark8ly_studio_annual_ppp_thb_v1',      'studio',   'annual',   'ppp'),
    ('mark8ly_studio_annual_ppp_vnd_v1',      'studio',   'annual',   'ppp'),
    ('mark8ly_studio_monthly_developed_v1',   'studio',   'monthly',  'developed'),
    ('mark8ly_studio_monthly_ppp_idr_v1',     'studio',   'monthly',  'ppp'),
    ('mark8ly_studio_monthly_ppp_inr_v1',     'studio',   'monthly',  'ppp'),
    ('mark8ly_studio_monthly_ppp_myr_v1',     'studio',   'monthly',  'ppp'),
    ('mark8ly_studio_monthly_ppp_php_v1',     'studio',   'monthly',  'ppp'),
    ('mark8ly_studio_monthly_ppp_thb_v1',     'studio',   'monthly',  'ppp'),
    ('mark8ly_studio_monthly_ppp_vnd_v1',     'studio',   'monthly',  'ppp')
ON CONFLICT (lookup_key) DO NOTHING;

-- Amounts join back by `lookup_key` rather than repeating a generated uuid, so
-- the two lists stay independently reviewable. An inner join means a typo'd key
-- silently inserts nothing rather than erroring — which is why the integration
-- test asserts the count is 78 and not merely "> 0".

INSERT INTO plan_catalog_amounts (price_id, currency, unit_amount_minor, tax_behavior)
SELECT p.id, v.currency, v.unit_amount_minor, v.tax_behavior
FROM (VALUES
    ('mark8ly_pro_annual_developed_v1',       'aud',   178800,       'exclusive'),
    ('mark8ly_pro_annual_developed_v1',       'cad',   161900,       'unspecified'),
    ('mark8ly_pro_annual_developed_v1',       'eur',   106800,       'unspecified'),
    ('mark8ly_pro_annual_developed_v1',       'gbp',   94800,        'unspecified'),
    ('mark8ly_pro_annual_developed_v1',       'nzd',   178800,       'unspecified'),
    ('mark8ly_pro_annual_developed_v1',       'sgd',   154800,       'unspecified'),
    ('mark8ly_pro_annual_developed_v1',       'usd',   118800,       'unspecified'),
    ('mark8ly_pro_annual_ppp_idr_v1',         'idr',   1198800000,   'unspecified'),
    ('mark8ly_pro_annual_ppp_inr_v1',         'inr',   6599900,      'unspecified'),
    ('mark8ly_pro_annual_ppp_myr_v1',         'myr',   358800,       'unspecified'),
    ('mark8ly_pro_annual_ppp_php_v1',         'php',   4558800,      'unspecified'),
    ('mark8ly_pro_annual_ppp_thb_v1',         'thb',   2878800,      'unspecified'),
    ('mark8ly_pro_annual_ppp_vnd_v1',         'vnd',   1978800000,   'unspecified'),
    ('mark8ly_pro_monthly_developed_v1',      'aud',   17900,        'exclusive'),
    ('mark8ly_pro_monthly_developed_v1',      'cad',   16200,        'unspecified'),
    ('mark8ly_pro_monthly_developed_v1',      'eur',   10700,        'unspecified'),
    ('mark8ly_pro_monthly_developed_v1',      'gbp',   9500,         'unspecified'),
    ('mark8ly_pro_monthly_developed_v1',      'nzd',   17900,        'unspecified'),
    ('mark8ly_pro_monthly_developed_v1',      'sgd',   15500,        'unspecified'),
    ('mark8ly_pro_monthly_developed_v1',      'usd',   11900,        'unspecified'),
    ('mark8ly_pro_monthly_ppp_idr_v1',        'idr',   119880000,    'unspecified'),
    ('mark8ly_pro_monthly_ppp_inr_v1',        'inr',   659900,       'unspecified'),
    ('mark8ly_pro_monthly_ppp_myr_v1',        'myr',   35900,        'unspecified'),
    ('mark8ly_pro_monthly_ppp_php_v1',        'php',   455900,       'unspecified'),
    ('mark8ly_pro_monthly_ppp_thb_v1',        'thb',   287900,       'unspecified'),
    ('mark8ly_pro_monthly_ppp_vnd_v1',        'vnd',   197880000,    'unspecified'),
    ('mark8ly_starter_annual_developed_v1',   'aud',   27800,        'exclusive'),
    ('mark8ly_starter_annual_developed_v1',   'cad',   23900,        'unspecified'),
    ('mark8ly_starter_annual_developed_v1',   'eur',   16300,        'unspecified'),
    ('mark8ly_starter_annual_developed_v1',   'gbp',   14400,        'unspecified'),
    ('mark8ly_starter_annual_developed_v1',   'nzd',   27800,        'unspecified'),
    ('mark8ly_starter_annual_developed_v1',   'sgd',   23900,        'unspecified'),
    ('mark8ly_starter_annual_developed_v1',   'usd',   18200,        'unspecified'),
    ('mark8ly_starter_annual_ppp_idr_v1',     'idr',   191900000,    'unspecified'),
    ('mark8ly_starter_annual_ppp_inr_v1',     'inr',   959900,       'unspecified'),
    ('mark8ly_starter_annual_ppp_myr_v1',     'myr',   56900,        'unspecified'),
    ('mark8ly_starter_annual_ppp_php_v1',     'php',   719900,       'unspecified'),
    ('mark8ly_starter_annual_ppp_thb_v1',     'thb',   479900,       'unspecified'),
    ('mark8ly_starter_annual_ppp_vnd_v1',     'vnd',   316900000,    'unspecified'),
    ('mark8ly_starter_monthly_developed_v1',  'aud',   2900,         'exclusive'),
    ('mark8ly_starter_monthly_developed_v1',  'cad',   2500,         'unspecified'),
    ('mark8ly_starter_monthly_developed_v1',  'eur',   1700,         'unspecified'),
    ('mark8ly_starter_monthly_developed_v1',  'gbp',   1500,         'unspecified'),
    ('mark8ly_starter_monthly_developed_v1',  'nzd',   2900,         'unspecified'),
    ('mark8ly_starter_monthly_developed_v1',  'sgd',   2500,         'unspecified'),
    ('mark8ly_starter_monthly_developed_v1',  'usd',   1900,         'unspecified'),
    ('mark8ly_starter_monthly_ppp_idr_v1',    'idr',   19900000,     'unspecified'),
    ('mark8ly_starter_monthly_ppp_inr_v1',    'inr',   99900,        'unspecified'),
    ('mark8ly_starter_monthly_ppp_myr_v1',    'myr',   5900,         'unspecified'),
    ('mark8ly_starter_monthly_ppp_php_v1',    'php',   74900,        'unspecified'),
    ('mark8ly_starter_monthly_ppp_thb_v1',    'thb',   49900,        'unspecified'),
    ('mark8ly_starter_monthly_ppp_vnd_v1',    'vnd',   32900000,     'unspecified'),
    ('mark8ly_studio_annual_developed_v1',    'aud',   71900,        'exclusive'),
    ('mark8ly_studio_annual_developed_v1',    'cad',   62500,        'unspecified'),
    ('mark8ly_studio_annual_developed_v1',    'eur',   43200,        'unspecified'),
    ('mark8ly_studio_annual_developed_v1',    'gbp',   37500,        'unspecified'),
    ('mark8ly_studio_annual_developed_v1',    'nzd',   71900,        'unspecified'),
    ('mark8ly_studio_annual_developed_v1',    'sgd',   62300,        'unspecified'),
    ('mark8ly_studio_annual_developed_v1',    'usd',   47000,        'unspecified'),
    ('mark8ly_studio_annual_ppp_idr_v1',      'idr',   479900000,    'unspecified'),
    ('mark8ly_studio_annual_ppp_inr_v1',      'inr',   2399900,      'unspecified'),
    ('mark8ly_studio_annual_ppp_myr_v1',      'myr',   142900,       'unspecified'),
    ('mark8ly_studio_annual_ppp_php_v1',      'php',   1823900,      'unspecified'),
    ('mark8ly_studio_annual_ppp_thb_v1',      'thb',   1151900,      'unspecified'),
    ('mark8ly_studio_annual_ppp_vnd_v1',      'vnd',   769900000,    'unspecified'),
    ('mark8ly_studio_monthly_developed_v1',   'aud',   7500,         'exclusive'),
    ('mark8ly_studio_monthly_developed_v1',   'cad',   6500,         'unspecified'),
    ('mark8ly_studio_monthly_developed_v1',   'eur',   4500,         'unspecified'),
    ('mark8ly_studio_monthly_developed_v1',   'gbp',   3900,         'unspecified'),
    ('mark8ly_studio_monthly_developed_v1',   'nzd',   7500,         'unspecified'),
    ('mark8ly_studio_monthly_developed_v1',   'sgd',   6500,         'unspecified'),
    ('mark8ly_studio_monthly_developed_v1',   'usd',   4900,         'unspecified'),
    ('mark8ly_studio_monthly_ppp_idr_v1',     'idr',   49900000,     'unspecified'),
    ('mark8ly_studio_monthly_ppp_inr_v1',     'inr',   249900,       'unspecified'),
    ('mark8ly_studio_monthly_ppp_myr_v1',     'myr',   14900,        'unspecified'),
    ('mark8ly_studio_monthly_ppp_php_v1',     'php',   189900,       'unspecified'),
    ('mark8ly_studio_monthly_ppp_thb_v1',     'thb',   119900,       'unspecified'),
    ('mark8ly_studio_monthly_ppp_vnd_v1',     'vnd',   79900000,     'unspecified')
) AS v (lookup_key, currency, unit_amount_minor, tax_behavior)
JOIN plan_catalog_prices p ON p.lookup_key = v.lookup_key
ON CONFLICT (price_id, currency) DO NOTHING;
