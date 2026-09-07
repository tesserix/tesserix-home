-- 0051_promo_codes_scoping.sql
--
-- CAMPAIGN SHAPE on a promo code definition: which plans it applies to, and
-- whether it applies only to annual billing (tesserix-home#593).
--
-- 0046 published the discount TERMS and nothing else, so every code the console
-- authors reaches mark8ly with mark8ly's defaults for scope — all plans, both
-- periods — whether or not those suit the campaign. `SAVEOFFER20OFF6MONTHS`
-- shipped that way. It is correctly unscoped, but nobody chose that; it was the
-- only shape the contract could express. These two columns are the shape the
-- redeemer has been able to honour since `000060_promo_codes.up.sql:24-27` and
-- the console has never been able to say.
--
-- ══ WHY ONLY TWO COLUMNS, AND NOT THE OTHER TWO ══
--
-- mark8ly's `promo_codes` carries four fields this table does not. Two of them
-- — `max_per_email` (§7.3) and `min_effective_price_per_currency` (§7.4) — are
-- DELIBERATELY NOT PUBLISHED AND NOT AUTHORABLE, and that is a decision rather
-- than an omission to be tidied up later (#593, settled 2026-09-06).
--
-- (§ references throughout are to mark8ly's
-- `docs/superpowers/specs/2026-04-17-subscription-model-design.md`, whose §7
-- covers promo rules and abuse prevention. Named once because the convention is
-- mark8ly's and nothing in THIS repo would tell a reader where to look.)
--
-- They are abuse controls, not campaign shape. The difference is what a wrong
-- value costs: a code scoped to the wrong plan is a campaign that underperforms
-- and is noticed, while a `max_per_email` raised from 1 to 100 is a code that
-- works BETTER, is noticed by nobody, and is a discount farm. An authoring UI
-- that can raise `max_per_email` is an authoring UI that can switch off an
-- abuse control THROUGH THE SAME FORM AND THE SAME PERMISSION as an ordinary
-- campaign edit — a capability the console does not have today and does not
-- acquire here.
--
-- So the boundary is: the console authors what a campaign IS, and mark8ly keeps
-- what protects it from being farmed. Widening that is a mark8ly change with
-- its own review, not a column added here because the shape happened to fit.
-- This is written in the schema and not only on the issue, because the next
-- person to notice the gap will read this file and will not read #593.
--
-- (mark8ly's ingest omits both fields from `upsertColumns`
-- — `services/marketplace-api/internal/billing/consolepromo/store.go:32` —
-- so a console publication cannot overwrite them today. Do NOT read that as
-- mark8ly having made this same decision independently: its comment gives the
-- reason as "mark8ly policy the console cannot express", which is a statement
-- about what the CONTRACT could
-- carry, not about what the console SHOULD be trusted with. The two happen to
-- agree on these two fields and stop agreeing on the other two — mark8ly#795
-- moves `allowed_plans` and `annual_only` INTO that list for exactly the reason
-- this file adds them here. The boundary drawn above is this schema's, and it
-- has to hold on its own argument.)
--
-- ══ WHY `annual_only boolean` AND NOT `allowed_periods text[]` ══
--
-- The symmetric array is the nicer shape. It is rejected on purpose.
--
-- mark8ly's redeemer can express exactly one period restriction:
--
--     if in.PromoCode.AnnualOnly && in.Period != subscription.PeriodAnnual {
--         return ValidationResult{Accepted: false, RejectReason: RejectReasonAnnualOnly}
--     }
--
-- There is no monthly-only branch, and there is no reject reason for one. So an
-- `allowed_periods text[]` here would let an operator author `{monthly}`, have
-- it accepted, have it render as a restriction on every surface that shows the
-- code — and have every annual checkout redeem it anyway. A control that reads
-- as enforced and is not is worse than an absent one, because the absent one is
-- visibly absent.
--
-- MIRROR WHAT THE REDEEMER CAN HONOUR. The asymmetry between the two columns
-- below is real and is recorded rather than papered over: `allowed_plans` is a
-- set because mark8ly checks membership in a set, and `annual_only` is a
-- boolean because mark8ly checks a boolean.
--
-- ══ NULL MEANS EVERY PLAN; THE EMPTY ARRAY IS UNSTORABLE ══
--
-- Unscoped is the default and the overwhelmingly common case, so it gets the
-- value a column arrives with. What must not exist is a SECOND spelling of it.
--
-- mark8ly's plan check is guarded by `len(in.PromoCode.AllowedPlans) > 0`
-- (`services/marketplace-api/internal/promo/validator.go:107`), so `{}` and
-- NULL are THE SAME FACT to the only redeemer there is: both mean every plan.
-- But `{}` does not read that way. It is an array with a scoping constraint's
-- name on it, it renders as "scoped" to anything that asks whether the field is
-- set, and it redeems as
-- unscoped. Every reader would then need a branch distinguishing "null" from
-- "empty" and concluding they are identical — which is 0043's standing argument
-- and 0046's for `max_redemptions > 0`, one object over.
--
-- NOTE FOR ANYONE CHANGING THIS: `{}` is NOT "a code no plan can redeem". That
-- reading is intuitive, it is what #593's discussion assumed, and it is wrong
-- against the redeemer as written. The constraint below is right for the reason
-- given above — two spellings of one fact — and not for that one. Stated
-- explicitly so the rule is not later "corrected" on a false premise.
--
-- ══ WHY THE VOCABULARY IS CHECKED RATHER THAN FREE TEXT ══
--
-- `starter`, `studio`, `pro`. The closed set, and the same spelling as
-- mark8ly's `pricing.Plan` constants
-- (`services/marketplace-api/internal/billing/pricing/catalog.go:41-43`) and as
-- every `mark8ly_<plan>_<period>_…_v1` lookup key this console already
-- stores.
--
-- The failure this prevents is a TYPO, and it is a silent one in both
-- directions. `prro` is accepted by a free-text column, renders as a scoped
-- code on the console list and in the published catalog, is ingested happily —
-- and matches no plan at redemption, so the code applies to nothing. Nobody
-- sees it until a merchant who was sent the code cannot use it, at which point
-- the evidence is a rejection reason in another product's metrics.
--
-- Case is a weaker argument than it looks and is not what this constraint rests
-- on: mark8ly compares with `strings.EqualFold` (`validator.go:110`), so
-- `Starter` would in fact
-- redeem. Lower-case is enforced anyway because it is the canonical form
-- everywhere else in this schema and one spelling is cheaper than two — but the
-- rule that earns its keep is membership, not case.
--
-- The cost of the closed set is that adding a fourth plan is a migration. That
-- is the point rather than the price, and it is the same trade
-- `promo_codes_source_is_a_known_source` (0046) and
-- `plan_catalog_parity_runs_source_is_a_known_source` (0044) already make.
--
-- ══ NO BACKFILL ══
--
-- `allowed_plans` is NULL on every existing row and stays there.
-- `SAVEOFFER20OFF6MONTHS` is live and correctly unscoped; NULL is its right
-- value, not a placeholder awaiting one. `annual_only` fills with `false` on
-- existing rows, which is the same statement: no live code is annual-only.
--
-- ══ THE DEFAULT ON `annual_only` IS PERMANENT, UNLIKE 0044'S ══
--
-- 0044 added a `NOT NULL DEFAULT` and 0045 removed it, because that default
-- existed only to backfill and to let the PREVIOUS console image keep inserting
-- during the rollout window. There is no follow-up file here and there must not
-- be one: `false` is what "not annual-only" MEANS, and `NOT NULL` with no
-- default would make every writer state the common case explicitly forever.
--
-- The rollout-window property 0044 depends on holds here for free. Migrations
-- are applied to prod before the PR carrying them merges, so there is always a
-- window where these columns exist and the pre-#593 console image is still
-- serving. That image's `createPromoCode` names neither column; the default
-- covers `annual_only` and the nullable `allowed_plans` covers itself, so the
-- old image keeps inserting successfully throughout.
--
-- ══ RE-RUNNABILITY ══
--
-- `ADD COLUMN IF NOT EXISTS` for the columns, and `DROP CONSTRAINT IF EXISTS` /
-- `ADD CONSTRAINT` for each CHECK — Postgres has no `ADD CONSTRAINT IF NOT
-- EXISTS`, so the drop-then-add pair is what makes an ALTER-shaped migration
-- survive its second application. That is 0035's and 0044's pattern and this
-- file uses it unchanged rather than inventing a `DO $$ … $$` variant.
--
-- Unlike 0046 and 0047 this file cannot put its constraints inside a
-- `CREATE TABLE`, so the pair is unavoidable. Migrations here are applied by
-- hand and a runner that aborts on a re-applied file wedges every migration
-- after it — tesserix-home#509, and the reason
-- `migration-idempotency.integration.test.ts` exists.
--
-- One thing the pair does NOT cover, stated rather than implied: `ADD COLUMN IF
-- NOT EXISTS` skips on the column NAME alone, so a second application would
-- no-op over a pre-existing `allowed_plans` of the wrong type without
-- complaining. Re-runnability is not the same as convergence, and this file
-- claims only the first.
--
-- ══ APPLY THIS BEFORE MERGING ══
--
-- Kargo deploys the console on merge; `db:migrate` does not ride along. Apply
-- 0051 to production BEFORE the PR carrying it merges, or the deployed console
-- selects columns that do not exist.

-- Which plans this code applies to. NULL = every plan; see the header for why
-- there is no second spelling of that.
ALTER TABLE promo_codes
    ADD COLUMN IF NOT EXISTS allowed_plans text[];

-- Annual billing only. `false` is the semantic default and stays — see the
-- header on why this is not 0044's temporary one.
ALTER TABLE promo_codes
    ADD COLUMN IF NOT EXISTS annual_only boolean NOT NULL DEFAULT false;

-- The closed vocabulary. `<@` is subset containment, so it admits any
-- combination of the three and refuses anything else.
--
-- WHAT IT ALSO REFUSES, and does not name well: an array containing a NULL
-- element is not contained in anything, because array containment does not
-- treat NULLs as equal to each other or to a value. So `{pro,NULL}` violates
-- this constraint too. The next one names that case properly; both statements
-- about such a row are true and Postgres reports whichever it reaches first.
ALTER TABLE promo_codes
    DROP CONSTRAINT IF EXISTS promo_codes_allowed_plans_are_known_plans;
ALTER TABLE promo_codes
    ADD CONSTRAINT promo_codes_allowed_plans_are_known_plans
    CHECK (allowed_plans IS NULL
           OR allowed_plans <@ ARRAY['starter', 'studio', 'pro']::text[]);

-- No NULL elements. `array_position` searches with `IS NOT DISTINCT FROM`, so
-- it is the one builtin that can find a NULL rather than propagate one; it
-- returns the subscript of the first NULL, or NULL if there is none.
--
-- Worth a constraint of its own even though the containment rule above already
-- rejects these rows, because a NULL element is a DIFFERENT MISTAKE from a
-- misspelt plan — it is an authoring path that dropped a value on the floor,
-- not one that typed the wrong one — and the two want different fixes. 0046's
-- reason for splitting the two canonical-form rules on `code`: each name states
-- exactly what it enforces, and a violation says which rule broke.
ALTER TABLE promo_codes
    DROP CONSTRAINT IF EXISTS promo_codes_allowed_plans_has_no_null_elements;
ALTER TABLE promo_codes
    ADD CONSTRAINT promo_codes_allowed_plans_has_no_null_elements
    CHECK (allowed_plans IS NULL
           OR array_position(allowed_plans, NULL) IS NULL);

-- Non-empty when present. `{}` is the second spelling of NULL — see the header,
-- and note in particular that it is NOT "a code no plan can redeem".
--
-- `cardinality` and not `array_length(allowed_plans, 1)`: the latter returns
-- NULL for an empty array rather than 0, so `array_length(...) > 0` would be
-- NULL, and a CHECK that evaluates to NULL PASSES. The empty array would have
-- been stored by the constraint written to forbid it.
ALTER TABLE promo_codes
    DROP CONSTRAINT IF EXISTS promo_codes_allowed_plans_is_not_empty;
ALTER TABLE promo_codes
    ADD CONSTRAINT promo_codes_allowed_plans_is_not_empty
    CHECK (allowed_plans IS NULL OR cardinality(allowed_plans) > 0);

-- No duplicates. `{pro,pro}` scopes to exactly what `{pro}` scopes to, so it is
-- a third spelling of a fact that already has one, and it makes any surface
-- rendering "2 plans" wrong.
--
-- Postgres CHECKs admit no subqueries and no aggregates, so the natural
-- `cardinality(...) = cardinality(ARRAY(SELECT DISTINCT unnest(...)))` is not
-- available. The form below counts how many DISTINCT plans are present by
-- asking after each one by name, and requires the array to be exactly that
-- long. It is total on its own: `= ANY` over an array containing NULL yields
-- NULL, and `CASE WHEN NULL THEN 1 ELSE 0 END` is 0, so no row escapes by
-- making the expression NULL.
--
-- THE COST, stated because it is a real one: this constraint is written against
-- the vocabulary, so adding a fourth plan means editing this expression as well
-- as the containment rule above, and forgetting it would silently allow that
-- plan to appear twice. The alternative — a subquery-free, vocabulary-
-- independent dedup — does not exist in Postgres without adding an IMMUTABLE
-- helper function, which this schema has no precedent for and which would be a
-- new convention to maintain for one rule on one column.
ALTER TABLE promo_codes
    DROP CONSTRAINT IF EXISTS promo_codes_allowed_plans_has_no_duplicates;
ALTER TABLE promo_codes
    ADD CONSTRAINT promo_codes_allowed_plans_has_no_duplicates
    CHECK (allowed_plans IS NULL
           OR cardinality(allowed_plans) =
                (CASE WHEN 'starter' = ANY (allowed_plans) THEN 1 ELSE 0 END)
              + (CASE WHEN 'studio'  = ANY (allowed_plans) THEN 1 ELSE 0 END)
              + (CASE WHEN 'pro'     = ANY (allowed_plans) THEN 1 ELSE 0 END));

-- No index on either column. The two reads on this table are unchanged —
-- lookup-by-code, served by `promo_codes_code_unique`, and the console's full
-- list, a table of tens of rows. 0046's rule stands: an index chosen before a
-- query exists is one nobody can justify later.
