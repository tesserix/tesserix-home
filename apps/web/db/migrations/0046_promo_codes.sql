-- 0046_promo_codes.sql
--
-- Promo code DEFINITIONS, owned by the console (tesserix-home#521). A merchant
-- types a code during Mark8ly onboarding; it extends the 90-day trial by N
-- days, and/or applies a Stripe coupon. This table is the definition side
-- only. The REDEMPTION LEDGER is deliberately not here — see below.
--
-- ══ WHAT THIS TABLE IS NOT ══
--
-- It is not a redemption log, and `max_redemptions` is the only trace of one.
-- Redemptions happen in mark8ly, at signup, inside the transaction that
-- creates the tenant, and the count has to be decided in that same
-- transaction or the cap is advisory. A counter column here would be a second
-- writer to the same number across a network boundary — i.e. a cap that
-- over-issues under concurrency and cannot be repaired after the fact.
--
-- MARK8LY IS DECLARED THE ONLY REDEEMER, and `max_redemptions` is EXACT only
-- because of that. It counts its own redemptions transactionally, which it can
-- do precisely because it is the sole consumer. THE MOMENT A SECOND CONSUMER
-- REDEEMS THESE CODES, THE CAP BECOMES DISTRIBUTED AND APPROXIMATE, and
-- nothing in this schema will say so — the column will keep looking like a
-- hard limit while quietly over-issuing. That is written here, and not only in
-- the issue, because the person who adds the second consumer will read this
-- file and will not read the issue.
--
-- ══ AN OPEN QUESTION THIS FILE DOES NOT DECIDE: STRIPE MODE ══
--
-- `stripe_coupon_id` names a Stripe Coupon, and a Coupon exists in exactly one
-- mode — a `test` coupon id is meaningless against the live account, the same
-- way a `price_...` is (0032's argument for keying the catalog on `lookup_key`
-- rather than on a Stripe id). `plan_catalog_publications` answers this for the
-- catalog by making publication a per-mode fact; nothing equivalent exists here
-- yet, so a definition carries ONE coupon id and does not say which account it
-- came from.
--
-- That is stated rather than solved because it is a shape decision for the
-- writer and the served contract (#521's T2/T3), not for this table alone, and
-- inventing a per-mode coupon table here would prejudge it. Today the console
-- has written no coupons at all, so no row is wrong yet. Whoever builds the
-- writer must resolve it before a live publish, not after.
--
-- ══ CANONICAL FORM: UPPER-CASE AND TRIMMED ══
--
-- The stored form is upper-case with no surrounding whitespace, enforced by
-- two CHECKs and made unique. Input is normalised the same way at every
-- boundary (`normalisePromoCode` in
-- `apps/console/lib/db/promo-codes-repo.ts`), so redemption is
-- case-insensitive BY CONSTRUCTION rather than by a `lower()` on every read.
--
-- The alternative — store as typed, compare case-insensitively — puts a
-- function on the left of every WHERE clause, which is both unindexable and a
-- rule each new reader has to remember. Worse, it makes `PROMO10` and
-- `promo10` two storable rows that are the same code: the unique index cannot
-- see the collision, so an operator authors a duplicate, both rows are live,
-- and which one a redeemer gets depends on row order. The CHECK is what makes
-- the un-normalised form UNSTORABLE rather than merely discouraged, so the
-- normalisation cannot be lost by a script, a second surface, or a psql
-- session.
--
-- TWO CONSTRAINTS, AND NOT THE OBVIOUS `code = upper(btrim(code))`. That
-- one-liner was written first and is WRONG in a way only a database would
-- reveal: Postgres `btrim(text)` strips SPACES ONLY, while JavaScript's
-- `String.prototype.trim()` strips every whitespace character. So
-- `E'\tLAUNCH50\n'` satisfies `code = upper(btrim(code))` and is stored, while
-- the TypeScript that is supposed to produce the identical canonical form
-- yields `LAUNCH50` — two rows, one code, and the unique index blind to the
-- collision it exists to prevent. The integration test found this by asserting
-- the TypeScript against POSTGRES rather than against a second hand-written
-- expectation.
--
-- Chasing that down by matching JS's exact trim set (`btrim(code, E' \t\n…')`,
-- plus NBSP, plus the Unicode separators `trim()` also removes) would make the
-- rule a transcription of one language's whitespace table into another's, which
-- is a thing to get wrong again later. Refusing whitespace ENTIRELY is both
-- stronger and independent of either definition: a promo code is a string a
-- human retypes from an email or a sticker, and one containing a space cannot
-- survive that trip anyway. Two constraints rather than one so each NAME states
-- exactly what it enforces, and a violation says which of the two rules broke.
--
-- ══ AT LEAST ONE EFFECT ══
--
-- Both effects stack, and either alone is valid (#521 decision 2) — the
-- merchant types one code and never learns which mechanism fired. What is not
-- valid is NEITHER: a row with no trial extension and no coupon is a code that
-- silently does nothing, accepted at the boundary and rewarding the merchant
-- with no discount and no error. `promo_codes_has_at_least_one_effect` is the
-- only place that rule survives the next caller.
--
-- ══ RE-RUNNABILITY ══
--
-- `IF NOT EXISTS` throughout, and every constraint is declared INSIDE the
-- CREATE TABLE rather than by a later ALTER, so a second application is a
-- no-op with no `DROP CONSTRAINT IF EXISTS` dance. Migrations here are applied
-- by hand and a runner that aborts on a re-applied file wedges every migration
-- after it — tesserix-home#509, and the reason
-- `migration-idempotency.integration.test.ts` exists.
--
-- ══ APPLY THIS BEFORE MERGING ══
--
-- Kargo deploys the console on merge; `db:migrate` does not ride along. Apply
-- 0046 to production BEFORE the PR carrying it merges, or the deployed console
-- queries a table that does not exist.

CREATE TABLE IF NOT EXISTS promo_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which product's onboarding this code is for. Same discriminator, same
    -- spelling and same closed vocabulary as `plan_catalog_prices.source`
    -- (0035) and `plan_catalog_parity_runs.source` (0044); a value outside the
    -- list would be a code no served catalog ever includes, which is
    -- indistinguishable from a code that simply does not work.
    source text NOT NULL
           CONSTRAINT promo_codes_source_is_a_known_source
           CHECK (source IN ('mark8ly')),

    -- The canonical stored form, enforced by the two constraints at the foot of
    -- this table. See the header for why it is two and not
    -- `code = upper(btrim(code))`.
    code text NOT NULL,

    -- Effect 1: extend the trial. NULL means this code does not extend it —
    -- distinct from 0, which would be an extension that extends nothing. The
    -- same reasoning `plan_catalog_amounts_unit_amount_is_positive` applies to
    -- a zero price: a value that reads as "set" while behaving as "unset" is
    -- the expensive direction of the mistake.
    trial_extension_days integer
                         CONSTRAINT promo_codes_trial_extension_is_positive
                         CHECK (trial_extension_days IS NULL OR trial_extension_days > 0),

    -- Effect 2: a Stripe Coupon id (`co_...`), written by the console's Stripe
    -- writer and stored here. NULL means this code carries no discount.
    --
    -- The blank-string CHECK is not decoration: `''` is NOT NULL, so without it
    -- an empty string satisfies `promo_codes_has_at_least_one_effect` below
    -- while naming no coupon at all — which is precisely the do-nothing code
    -- that constraint exists to refuse, re-admitted through the one spelling it
    -- cannot see.
    stripe_coupon_id text
                     CONSTRAINT promo_codes_stripe_coupon_id_is_not_blank
                     CHECK (stripe_coupon_id IS NULL OR btrim(stripe_coupon_id) <> ''),

    -- The validity window. `valid_until` NULL means "no expiry", not "unknown"
    -- — the same convention `crm_templates.product` uses for its null (0043),
    -- and the honest shape for an evergreen launch code.
    valid_from timestamptz NOT NULL DEFAULT now(),
    valid_until timestamptz,

    -- EXACT, and exact only while mark8ly is the sole redeemer. See the header.
    -- NULL is "uncapped". `> 0` because a cap of 0 is a code nobody may redeem,
    -- which is what `is_active = false` already says, and two spellings of one
    -- fact is two branches in every reader — 0043's standing argument.
    max_redemptions integer
                    CONSTRAINT promo_codes_max_redemptions_is_positive
                    CHECK (max_redemptions IS NULL OR max_redemptions > 0),

    -- Deactivated, never deleted. A redemption in mark8ly's ledger references
    -- the code that was redeemed; deleting the definition turns every one of
    -- those into a dangling reference nobody can resolve, exactly as
    -- `crm_templates` archives rather than deletes (0043).
    is_active boolean NOT NULL DEFAULT true,

    -- Authoring provenance, matching what this schema already keeps:
    -- `plan_catalog_revisions.created_by` (0035) and `crm_templates.created_by`
    -- (0043) are both a bare operator identity as `text`, with no FK — operator
    -- identity lives in Zitadel, not in this database, so there is nothing to
    -- point at. No `updated_by`: nothing in this estate records one, and a
    -- column only this table maintained would be a second convention for the
    -- next reader to discover.
    --
    -- NO `updated_at` TRIGGER, per 0043: there are no triggers on these tables,
    -- and every writer sets `updated_at = now()` in the same statement as the
    -- change it is recording.
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    -- Half one of the canonical form. `upper()` is a no-op on a string already
    -- upper-cased, so this admits exactly the strings that survive
    -- canonicalisation — digits, punctuation and non-cased characters included.
    CONSTRAINT promo_codes_code_is_upper_case
    CHECK (code = upper(code)),

    -- Half two, and the one that carries the emptiness rule with it: `^\S+$`
    -- requires at least one character and forbids whitespace anywhere, so a
    -- code that is empty, padded, or split by a space is all one refusal.
    -- Independent of any trim function's whitespace table — see the header.
    CONSTRAINT promo_codes_code_has_no_whitespace
    CHECK (code ~ '^\S+$'),

    -- The rule the header is about: a definition with no effect is a code that
    -- does nothing. Accepted at redemption, silently rewarding the merchant
    -- with neither a longer trial nor a discount and no error to explain it.
    CONSTRAINT promo_codes_has_at_least_one_effect
    CHECK (trial_extension_days IS NOT NULL OR stripe_coupon_id IS NOT NULL),

    -- A window that ends before it begins can never be redeemed, and reads as a
    -- live code on every surface that renders one. `>` and not `>=`: a
    -- zero-length window is the same unredeemable row with a subtler typo.
    CONSTRAINT promo_codes_validity_window_is_ordered
    CHECK (valid_until IS NULL OR valid_until > valid_from)
);

-- GLOBALLY unique, not unique per source, and that is the deliberate half.
--
-- A promo code arrives as a string a human typed into an onboarding form. At
-- that boundary there is no source in hand — the code IS the whole key. If two
-- sources could each own `LAUNCH50`, lookup-by-code would return two rows and
-- the redeemer would have to pick, which is a decision nothing at that boundary
-- is equipped to make. `source` therefore scopes what a code APPLIES to, not
-- what makes it unique.
--
-- Named as an index rather than a table constraint so this file stays free of
-- the `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` pair 0035 and 0044 need:
-- `CREATE UNIQUE INDEX IF NOT EXISTS` is idempotent on its own.
--
-- No further indexes. The two reads that exist are lookup-by-code, which this
-- index serves exactly, and the console's full list, which is a table of tens
-- of rows. A partial index on `is_active` would be the shape `crm_templates`
-- needed because archived copy becomes the majority there; promo codes are
-- authored in tens and an index chosen before a query exists is one nobody can
-- justify later.
CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_code_unique
    ON promo_codes (code);
