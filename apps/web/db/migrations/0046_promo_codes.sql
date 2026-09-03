-- 0046_promo_codes.sql
--
-- Promo code DEFINITIONS, owned by the console (tesserix-home#521). A merchant
-- types a code during Mark8ly onboarding; it extends the 90-day trial by N
-- days, and/or applies a discount. This is the definition side only. The
-- REDEMPTION LEDGER is deliberately not here — see below.
--
-- Two tables, and the division is the same one `plan_catalog_prices` /
-- `plan_catalog_publications` already draw: what is true of the thing, and what
-- is true of the thing IN ONE STRIPE ACCOUNT.
--
-- ══ WHY THE STRIPE COUPON ID IS NOT A COLUMN ON `promo_codes` ══
--
-- tesserix-home#521's body says to "store the returned coupon id on the
-- definition". That is wrong, and it is wrong against a rule this schema
-- already wrote down. Treat the schema rule as authoritative over the issue
-- prose — this milestone has now found several false premises in its own issue
-- text, and this is one more.
--
-- `0032_plan_catalog.sql` states it for the analogous object:
--
--     -- The join key to Stripe. `lookup_key` is what the catalog and Stripe
--     -- genuinely share; a Stripe price id (`price_...`) differs per mode and
--     -- per account, so keying on one would make this table unusable against
--     -- test mode and unportable if the account is ever rebuilt.
--
-- A Stripe Coupon is the same kind of object as a Stripe Price in every way
-- that matters here: it is minted per account, it carries an account-scoped id
-- (`co_...`), and a `test` id is meaningless against the live account.
--
-- And the estate's PRACTICE already matches. The only place a Stripe id is
-- stored in this schema at all is
-- `plan_catalog_publish_operations.stripe_price_id` (0038), whose parent
-- `plan_catalog_publish_attempts` carries `mode text NOT NULL CHECK (mode IN
-- ('test', 'live'))`. Every Stripe id here is reachable from exactly one mode.
-- There is no row anywhere in this database that holds a Stripe id without a
-- mode attached, and a `stripe_coupon_id text` on `promo_codes` would have been
-- the first.
--
-- `plan_catalog_publications` supplies the SHAPE. 0035's own words: "Publication
-- is a fact about a (mode, revision) pair, not about a revision." Substitute:
-- a minted coupon is a fact about a (mode, promo code) pair, not about a promo
-- code. So it gets a child table keyed on that pair, exactly as publication did.
--
-- What the definition keeps is the discount TERMS — percent-off or amount-off,
-- duration, months, currency. Those are what an operator authored, they are
-- true regardless of which account they are later materialised into, and they
-- are the input to `createCoupon` rather than its output. A definition carrying
-- terms and materialised in NO mode yet is a legitimate, expected state; it is
-- the entire point of the split.
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
-- valid is NEITHER: a row with no trial extension and no discount terms is a
-- code that silently does nothing, accepted at the boundary and rewarding the
-- merchant with no discount and no error.
--
-- The rule reads against the TERMS, not against a coupon id, and that is the
-- direct consequence of the split above: "has a discount" is a property of what
-- was authored, and must be answerable before any account has been touched.
-- Reading it against a materialised coupon would make every freshly-authored
-- discount code briefly indistinguishable from a do-nothing one.
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
-- queries tables that do not exist.

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

    -- ── Effect 1: extend the trial ──
    --
    -- NULL means this code does not extend it — distinct from 0, which would be
    -- an extension that extends nothing. The same reasoning
    -- `plan_catalog_amounts_unit_amount_is_positive` applies to a zero price: a
    -- value that reads as "set" while behaving as "unset" is the expensive
    -- direction of the mistake.
    trial_extension_days integer
                         CONSTRAINT promo_codes_trial_extension_is_positive
                         CHECK (trial_extension_days IS NULL OR trial_extension_days > 0),

    -- ── Effect 2: the discount TERMS ──
    --
    -- Nullable AS A GROUP: a code may be trial-extension-only. `discount_duration`
    -- is the group's presence marker — it is the one field Stripe requires of
    -- every Coupon regardless of shape, so "terms exist" and "duration is set"
    -- are the same fact rather than two that can disagree.
    --
    -- These are `createCoupon`'s INPUT, not its output. They are mode- and
    -- account-independent, which is exactly why they belong here and the minted
    -- `co_...` does not. Semantics are Stripe's and are passed through, not
    -- reimplemented: percent-off vs amount-off, the three durations, months for
    -- `repeating`, and a currency for amount-off.
    --
    -- Stripe's own redemption cap (`max_redemptions` on the Coupon) is
    -- deliberately ABSENT from this group. This table's `max_redemptions` below
    -- is the cap mark8ly enforces on the CODE, which is a different object from
    -- the coupon and counts a different event; carrying both would be two
    -- numbers that must agree and no way to make them.

    -- Stripe's `percent_off` is a decimal with up to two places. `numeric(5,2)`
    -- holds 100.00 exactly and nothing wider, so an out-of-range value is a
    -- storage error before it is a CHECK violation.
    discount_percent_off numeric(5, 2)
                         CONSTRAINT promo_codes_discount_percent_off_is_in_range
                         CHECK (discount_percent_off IS NULL
                                OR (discount_percent_off > 0 AND discount_percent_off <= 100)),

    -- Minor units, `bigint` for the reason `plan_catalog_amounts` gives: IDR
    -- annual is 1_198_800_000 minor units, comfortably inside int4 today and
    -- one devaluation away from not being.
    discount_amount_off bigint
                        CONSTRAINT promo_codes_discount_amount_off_is_positive
                        CHECK (discount_amount_off IS NULL OR discount_amount_off > 0),

    -- Lowercase, always — the identical Stripe fact
    -- `plan_catalog_amounts_currency_is_lowercase_iso_4217` encodes, and the
    -- same failure if it is not: `USD` and `usd` coexisting is a silent
    -- double-count in every aggregate, and here a currency Stripe rejects at
    -- coupon-creation time for a reason the payload will not make obvious.
    discount_currency text
                      CONSTRAINT promo_codes_discount_currency_is_lowercase_iso_4217
                      CHECK (discount_currency IS NULL OR discount_currency ~ '^[a-z]{3}$'),

    discount_duration text
                      CONSTRAINT promo_codes_discount_duration_is_a_stripe_duration
                      CHECK (discount_duration IS NULL
                             OR discount_duration IN ('once', 'repeating', 'forever')),

    discount_duration_in_months integer
                                CONSTRAINT promo_codes_discount_months_is_positive
                                CHECK (discount_duration_in_months IS NULL
                                       OR discount_duration_in_months > 0),

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
    --
    -- Reads against `discount_duration` — the terms' presence marker — and NOT
    -- against a minted coupon id, which lives in the other table and is absent
    -- for every discount code between authoring and first publish.
    CONSTRAINT promo_codes_has_at_least_one_effect
    CHECK (trial_extension_days IS NOT NULL OR discount_duration IS NOT NULL),

    -- The terms are all-or-nothing, anchored on the presence marker. Without
    -- this, a `discount_percent_off` with no `discount_duration` is a discount
    -- that satisfies no effect rule, renders as a percentage on every surface,
    -- and is silently un-materialisable because Stripe will not create a Coupon
    -- without a duration.
    CONSTRAINT promo_codes_discount_terms_are_all_or_nothing
    CHECK (discount_duration IS NOT NULL
           OR (discount_percent_off IS NULL
               AND discount_amount_off IS NULL
               AND discount_currency IS NULL
               AND discount_duration_in_months IS NULL)),

    -- EXACTLY ONE of percent-off / amount-off, when terms exist. Stripe refuses
    -- both and refuses neither, so a row carrying both is a coupon that can
    -- never be created — discovered at publish time, against the live account,
    -- by whoever is publishing rather than by whoever authored it.
    --
    -- `<>` on two `IS NULL` booleans is the XOR; it is total here because both
    -- operands are `IS NULL` tests and therefore never null themselves.
    CONSTRAINT promo_codes_discount_is_percent_off_xor_amount_off
    CHECK (discount_duration IS NULL
           OR ((discount_percent_off IS NULL) <> (discount_amount_off IS NULL))),

    -- Amount-off needs its currency; percent-off must not carry one. ONE
    -- biconditional rather than two implications, because the two halves are
    -- the same rule and splitting them would let a future edit satisfy one and
    -- drop the other. A percent-off with a currency is not harmless: it reads
    -- as a currency-scoped discount on every surface that renders it, and is
    -- not one.
    CONSTRAINT promo_codes_discount_currency_accompanies_amount_off
    CHECK ((discount_amount_off IS NULL) = (discount_currency IS NULL)),

    -- `duration_in_months` IF AND ONLY IF `repeating`. Stripe requires it for
    -- `repeating` and rejects it for the other two.
    --
    -- `IS NOT DISTINCT FROM` and not `=`: with a plain `=`, a NULL
    -- `discount_duration` makes the right-hand side NULL, the whole comparison
    -- NULL, and the CHECK PASSES — so a months value on a code with no terms at
    -- all would slip through, leaning on the all-or-nothing constraint above to
    -- catch it. A constraint that is only correct because a different
    -- constraint exists is one that stops being correct when that one is
    -- relaxed. The null-safe form makes this rule total on its own.
    CONSTRAINT promo_codes_discount_months_iff_repeating
    CHECK ((discount_duration_in_months IS NOT NULL)
           = (discount_duration IS NOT DISTINCT FROM 'repeating')),

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
-- No further indexes on this table. The two reads that exist are
-- lookup-by-code, which this index serves exactly, and the console's full list,
-- which is a table of tens of rows. A partial index on `is_active` would be the
-- shape `crm_templates` needed because archived copy becomes the majority
-- there; promo codes are authored in tens and an index chosen before a query
-- exists is one nobody can justify later.
CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_code_unique
    ON promo_codes (code);

-- ══════════════════════════════════════════════════════════════════════════
-- What was actually minted, in which Stripe account.
--
-- The per-mode half of the split. One row per (definition, mode) — the same
-- shape and the same argument as `plan_catalog_publications`, one object over.
--
-- A definition with terms and NO row here is the normal state between authoring
-- and the first publish, and it is why the effect rule above reads against the
-- terms. A definition with a row in `test` and none in `live` is the normal
-- state of everything in this estate, which has never bootstrapped live.
--
-- WHAT THIS TABLE CANNOT ENFORCE, stated rather than implied: nothing here
-- refuses a coupon row against a definition that carries no discount terms.
-- Postgres cannot express a cross-table CHECK, so that rule is the WRITER's
-- (`recordStripeCoupon`, and #521's T2 above it), not this schema's. Claiming
-- otherwise would be claiming more than is enforced — the discipline 0035's
-- "A CEILING, never a floor" paragraph sets for exactly this situation.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS promo_code_stripe_coupons (
    -- CASCADE, and unlike `plan_catalog_publications`' RESTRICT. That table
    -- guards an audit trail — who published what, when — which a draft cleanup
    -- must not silently erase. This one holds no audit: it is a pointer into a
    -- Stripe account, meaningless without the definition it points from, which
    -- is 0038's reasoning for `operations -> attempt`. The question is close to
    -- moot in practice, because a definition is deactivated and never deleted.
    promo_code_id uuid NOT NULL REFERENCES promo_codes (id) ON DELETE CASCADE,

    mode text NOT NULL
         CONSTRAINT promo_code_stripe_coupons_mode_is_a_stripe_mode
         CHECK (mode IN ('test', 'live')),

    -- `co_...`. NOT NULL, unlike `plan_catalog_publish_operations.stripe_price_id`
    -- which is nullable because that table writes ahead of the Stripe call. This
    -- one is written only AFTER a coupon exists, so a row whose id is unknown is
    -- a row with nothing to say.
    --
    -- The blank CHECK is not decoration: `''` is NOT NULL, so without it an
    -- empty string records a materialisation that did not happen, in the one
    -- spelling `NOT NULL` cannot see.
    stripe_coupon_id text NOT NULL
                     CONSTRAINT promo_code_stripe_coupons_coupon_id_is_not_blank
                     CHECK (btrim(stripe_coupon_id) <> ''),

    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    -- ONE coupon per definition per mode, and the PK says so rather than a
    -- surrogate plus a unique index. Unlike `plan_catalog_publications`, which
    -- needs a surrogate because re-publishing a superseded revision is a second
    -- row for the same pair, there is no supersession here: a Stripe Coupon's
    -- discount is immutable after creation, so "change the discount" is a NEW
    -- definition, not a second coupon against this one.
    PRIMARY KEY (promo_code_id, mode)
);
