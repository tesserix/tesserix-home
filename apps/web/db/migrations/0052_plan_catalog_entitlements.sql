-- 0052_plan_catalog_entitlements.sql
--
-- WHAT A PLAN ENTITLES A TENANT TO, hung off the revision that already carries
-- what it COSTS (tesserix-home#146).
--
-- 0032 through 0035 gave the console the plan catalog's PRICES and nothing
-- else, so the platform can publish that Pro costs $75 and has no
-- representation at all of what Pro IS. The 26 features that answer that
-- question live only in mark8ly, compiled into the binary as
-- `services/marketplace-api/internal/plangate/matrix.go`'s
-- `map[Plan]map[Feature]int`, whose own comment says it "encodes spec §9
-- verbatim". This table is the console's copy of that fact, versioned by the
-- machinery a price change already uses.
--
-- (§ references are to mark8ly's
-- `docs/superpowers/specs/2026-04-17-subscription-model-design.md`, whose §9 is
-- the feature matrix. Named once because the convention is mark8ly's and
-- nothing in THIS repo would tell a reader where to look.)
--
-- Hanging off `revision_id` is the whole reason there is no new machinery here.
-- 0035 already answers "compare against what?" with one published revision per
-- mode, and 0035's publication table already makes that immutable. An
-- entitlement change is therefore drafted on a revision and published with it,
-- exactly as a price change is. There is no second publication concept, no
-- second notion of "live", and nothing here to keep in step with 0035 later.
--
-- ══ WHY ENTITLEMENT AND LIMIT ARE ONE VALUE AND NOT TWO COLUMNS ══
--
-- #146's prose says "entitlements, limits and price books", which reads as
-- three things and is two here: prices are 0032's, and the first two are ONE
-- COLUMN. That is not a shortcut. It is what the only enforcement point that
-- exists actually does.
--
-- `plangate` stores a single `int` per `(plan, feature)` and reads it two ways.
-- `IsAllowed()` asks whether it is non-zero (`matrix.go:286`, `return v !=
-- Disabled`); `Limit()` returns it (`matrix.go:291-297`). There is no boolean
-- anywhere in that package, and no cell that is enabled-with-no-limit or
-- limited-while-disabled, because those states cannot be spelled.
--
-- Modelling them as `enabled boolean` + `limit integer` would invent a
-- distinction the gate does not have, and would immediately create a state the
-- gate cannot represent: `enabled = false, limit = 25`. Something must then
-- decide what that means, and every writer, every reader, and the parity check
-- against mark8ly would each have to decide it the same way forever. One
-- column has no disagreement to keep.
--
-- The vocabulary, from `matrix.go:71-73`, carried unchanged:
--
--     0    Disabled    -- and the zero value; see below
--     -1   Unlimited
--     -2   Negotiated  -- the frontend renders "contact sales"
--     n>0  a cap
--
-- ══ WHY `0` IS BOTH DISABLED AND THE ZERO VALUE ══
--
-- This is an invariant being carried across a repository boundary, not a
-- coincidence that happens to hold on both sides.
--
-- In Go, an absent key in `map[Feature]int` yields `0`, and `Limit()` leans on
-- that deliberately: its doc comment says "Unknown (p, f) pairs return
-- Disabled (0)", and both of its early returns hand back `Disabled` rather than
-- an error. So in mark8ly an entitlement nobody wrote is an entitlement that is
-- OFF. Nothing has to remember to check.
--
-- The same property has to hold of a row set. A caller that fetches this
-- table's rows for a plan and finds a feature missing — a partially-loaded
-- read, a revision seeded before a feature was added, a query that errored
-- halfway — must land on Disabled, and it does, for the same reason: the
-- absent integer is `0`, and `0` is off.
--
-- WHAT THIS FORBIDS, because it is the mistake that would quietly undo it: no
-- reader may map absence to a permissive default, and no future column may make
-- "row present but meaningless" a state. #149 states the generalisation — a
-- billing state must never be able to disable a safety-critical function — and
-- a fail-closed zero is how that is ENFORCED rather than asserted. The
-- direction of the error matters more than its frequency: a wrongly-disabled
-- feature is a support ticket from a merchant who is paying for it, and a
-- wrongly-enabled one is a plan boundary that is not there and that nobody is
-- looking for.
--
-- Note that this is the reason the table cannot be made "safer" by adding
-- `NOT NULL DEFAULT` on some future nullable column and calling absence
-- explicit. Absence is already explicit. It means off.
--
-- ══ WHY THE FEATURE VOCABULARY IS CHECKED RATHER THAN FREE TEXT ══
--
-- The 26 strings below are `plangate`'s `Feature` constants
-- (`matrix.go:19-63`), in `allFeatures` order rather than sorted, so the two
-- lists can be read side by side.
--
-- The failure this prevents is a TYPO, and it is silent in the worst possible
-- direction. `sores` in a free-text column is accepted, is published with the
-- revision, renders on every console surface as a feature that HAS BEEN SET —
-- an operator looking at the screen sees a value and believes it applies — and
-- matches no key `plangate` ever looks up, so it gates nothing. An entitlement
-- that reads as configured and enforces nothing is worse than an absent one,
-- because the absent one is visibly absent. It is the same argument 0051 makes
-- for `prro` against `allowed_plans`, and 0046's for `source`.
--
-- The parity check (#146's later steps) would eventually surface it as drift,
-- which is an argument for the CHECK rather than against it: drift is reported
-- per feature, and a run that is red because of one typo'd row is a run that
-- has to be read carefully to find the entitlement that is genuinely wrong.
-- Refusing the row makes the typo a failure at the point of the mistake.
--
-- The cost is that adding a 27th feature in mark8ly is a migration here. That
-- is the point rather than the price: mark8ly's `allFeatures` is hand-
-- maintained with its own parity test asserting its length matches the const
-- block, so a feature added there and not here shows up as parity drift, which
-- is CORRECT and is stated here so it is not later read as a defect.
--
-- ══ WHY `trial` IS ONE OF THE PLANS, THOUGH IT IS PRICED NOWHERE ══
--
-- `trial`, `starter`, `studio`, `pro` — `plangate`'s four matrix keys
-- (`matrix.go:126,165,205,236`), not the three priced plans.
--
-- That is deliberately WIDER than `promo_codes.allowed_plans` (0051) and wider
-- than the `mark8ly_<plan>_<period>_…_v1` lookup keys, and the difference is the
-- point rather than an inconsistency to tidy away.
--
-- An earlier draft of this file admitted only the three priced plans, arguing
-- that this table "describes the plan CATALOG — what is priced, published to
-- Stripe, and parity-checked against it". That argument is sound for
-- `plan_catalog_prices` and wrong here, because it imports the PRICE table's
-- justification into a table that answers a different question.
--
-- STRIPE KNOWS NOTHING ABOUT ENTITLEMENTS. No entitlement is published to a
-- Stripe account and none is compared against one. This table's counterparty is
-- `plangate`'s compiled matrix — and that matrix HAS a `trial` row, so a trial
-- tenant is gated by it exactly as a `pro` tenant is.
--
-- So excluding `trial` costs nothing in the Stripe direction, because there is
-- no Stripe direction, and costs completeness in the only direction this table
-- is ever checked. The parity run would compare three of the four enforced
-- plans and report clean, while a quarter of what the platform actually gates
-- on went unexamined — a check that CANNOT be complete, presented as one that
-- is. tesserix-home#582 was closed on that exact distinction a day before this
-- file was written.
--
-- A plan with entitlements and no price is a coherent row, not an anomaly:
-- entitlements hang off a revision as a SET, and the revision publishes them
-- together. Nothing requires a matching price for a plan to be entitled to
-- something, and `trial` is the case that proves it — a tenant is on it, and is
-- gated while on it.
--
-- ══ WHY `marketplace` IS NOT ONE OF THEM ══
--
-- `subscription.PlanMarketplace` exists (`models.go:19`, "hidden from UI") and
-- is deliberately ABSENT from `featureMatrix`. `AllFeatureLimits` therefore
-- resolves it to all-Disabled through the fail-closed default rather than
-- through a row anybody wrote.
--
-- There is nothing to mirror. Storing 26 zeros for it would assert a policy no
-- one authored, and would then compare EQUAL against a matrix that never
-- described it — turning an absence of policy into an apparent agreement.
--
-- ══ WHY `value >= -2` ══
--
-- The floor forbids a THIRD negative sentinel arriving silently, and that is a
-- different and worse failure from an out-of-range number.
--
-- Every consumer of this column — the console's rendering, the parity
-- comparator, and mark8ly's own `Limit()` — reads a negative integer by
-- matching it against a known list and treats anything else as a NUMBER. So a
-- `-3` that meant something new in a future mark8ly release would not fail
-- anywhere. It would be read as a cap of minus three: rendered as a limit,
-- compared as a limit, and silently more restrictive than Disabled in any
-- arithmetic that reaches it. Nothing would say the value was not understood.
--
-- The CHECK converts that into a refusal at the moment of the write, which is
-- also the moment somebody is in a position to decide what the new sentinel
-- means here. The cost is a migration when a fourth sentinel legitimately
-- arrives — the same trade the closed vocabularies above make, and the
-- design's one explicitly-open constraint question, settled this way.
--
-- There is deliberately no ceiling. A cap is a real quantity (5_000 campaign
-- emails, 90 days of audit retention) with no natural upper bound, and a bound
-- invented here would be a number nobody could justify later.
--
-- ══ CASCADE, NOT RESTRICT ══
--
-- 0035 gave `plan_catalog_publications` an `ON DELETE RESTRICT` onto the
-- revision, and 0038 gave `plan_catalog_publish_attempts` the same. Both guard
-- an AUDIT TRAIL: who published what and when, what was attempted and when. A
-- draft cleanup must not silently erase that.
--
-- This table holds no audit. An entitlement is a fact ABOUT a revision and is
-- meaningless without it — there is no question a stranded entitlement row
-- could answer after its revision is gone. So it cascades, which is 0038's
-- reasoning for `operations -> attempt` ("an operation has no meaning
-- independent of the attempt that produced it") and 0046's for
-- `promo_code_stripe_coupons -> promo_codes`. It is also what makes
-- `discardDraft` remain one delete: 0035's `plan_catalog_prices.revision_id`
-- already cascades, and an entitlement that did not would turn discarding a
-- draft into an error nobody expects, on a code path that has nothing to do
-- with entitlements.
--
-- ══ NO INDEX BEYOND THE PRIMARY KEY ══
--
-- 78 rows per revision (26 features × 3 plans — the same count as
-- `plan_catalog_amounts`, which is a coincidence and a convenient sanity
-- check). Every read this table has is "the entitlements for one revision",
-- which the PK's leading `revision_id` serves exactly. 0046's rule stands: an
-- index chosen before a query exists is one nobody can justify later.
--
-- ══ RE-RUNNABILITY ══
--
-- `IF NOT EXISTS`, and every constraint is declared INSIDE the `CREATE TABLE`
-- rather than by a later ALTER, so a second application is a no-op with no
-- `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` pair — 0046's shape, not
-- 0051's, because this file creates a table rather than altering one.
-- Migrations here are applied by hand and a runner that aborts on a re-applied
-- file wedges every migration after it — tesserix-home#509, and the reason
-- `migration-idempotency.integration.test.ts` exists.
--
-- As in 0046, re-runnability is not convergence: `CREATE TABLE IF NOT EXISTS`
-- skips on the table NAME alone, so a second application would no-op over a
-- pre-existing table of a different shape without complaining. This file claims
-- only the first.
--
-- ══ APPLY THIS BEFORE MERGING ══
--
-- Kargo deploys the console on merge; `db:migrate` does not ride along. Apply
-- 0052 to production BEFORE the PR carrying it merges. Since tesserix-home#613
-- the console's preflight refuses to start against a ledger that is behind, so
-- a missed apply stalls the rollout rather than breaking a surface — a better
-- failure, and still a failure. Apply it with `node
-- apps/web/scripts/db-migrate.mjs`, never by piping this file through `psql`:
-- that writes the DDL without recording it in `schema_migrations`, which is
-- exactly the state #509 came from.

CREATE TABLE IF NOT EXISTS plan_catalog_entitlements (
    -- CASCADE, unlike `plan_catalog_publications`' and
    -- `plan_catalog_publish_attempts`' RESTRICT onto the same table. See the
    -- header: those guard an audit trail and this holds none.
    revision_id uuid NOT NULL REFERENCES plan_catalog_revisions (id) ON DELETE CASCADE,

    -- Which product's plans these are. Same discriminator, same spelling and
    -- same closed vocabulary as `plan_catalog_prices.source` (0035),
    -- `plan_catalog_parity_runs.source` (0044) and `promo_codes.source`
    -- (0046). The column is the seam for a second product; the CHECK is what
    -- says none exists yet, and widening it is that product's work rather than
    -- a value inserted here first.
    source text NOT NULL
           CONSTRAINT plan_catalog_entitlements_source_is_a_known_source
           CHECK (source IN ('mark8ly')),

    -- `plangate`'s four matrix keys, NOT the three priced plans. `trial` IS
    -- one of these and `marketplace` is not — see the header for both reasons.
    plan text NOT NULL
         CONSTRAINT plan_catalog_entitlements_plan_is_a_known_plan
         CHECK (plan IN ('trial', 'starter', 'studio', 'pro')),

    -- `plangate`'s `Feature` constants, in `allFeatures` order so the two
    -- lists read side by side. A typo here is an entitlement that renders as
    -- set and gates nothing; that is what this CHECK is for.
    feature text NOT NULL
            CONSTRAINT plan_catalog_entitlements_feature_is_a_known_feature
            CHECK (feature IN (
                'stores', 'images_per_product', 'audit_retention_days',
                'campaign_emails_per_month', 'transactional_emails',
                'webhook_subscriptions', 'custom_domain', 'full_color_palette',
                'announcement_bar', 'remove_powered_by', 'custom_css',
                'custom_code_injection', 'white_label_app', 'csv_import_export',
                'shipping_labels', 'returns', 'reviews', 'tickets', 'gift_cards',
                'read_api', 'full_read_write_api', 'sso', 'uptime_sla',
                'standard_email_support', 'priority_email_support', 'named_csm')),

    -- Entitlement AND limit, in one integer, exactly as the gate stores it.
    -- `0` disabled, `-1` unlimited, `-2` negotiated, positive n a cap. `0` is
    -- also the zero value, so an absent row reads as off; nothing may make an
    -- unset entitlement permissive.
    --
    -- The floor, and no ceiling. A fourth sentinel arriving silently would be
    -- read as a cap of -3 by every consumer rather than failing anywhere.
    value integer NOT NULL
          CONSTRAINT plan_catalog_entitlements_value_is_a_known_sentinel_or_cap
          CHECK (value >= -2),

    -- One value per (revision, source, plan, feature), and the PK says so
    -- rather than a surrogate plus a unique index: the tuple IS the identity
    -- of the cell, there is no supersession within a revision (a change is a
    -- new revision, which is the entire point of 0035), and nothing references
    -- an individual entitlement row. Same argument as
    -- `promo_code_stripe_coupons`' `(promo_code_id, mode)` (0046).
    --
    -- `revision_id` leads because every read is "the entitlements for one
    -- revision" — see the header on why there is no second index.
    PRIMARY KEY (revision_id, source, plan, feature)
);
