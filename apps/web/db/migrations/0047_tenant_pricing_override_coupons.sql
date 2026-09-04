-- 0047_tenant_pricing_override_coupons.sql
--
-- What this console MINTED in Stripe for one tenant, so a second grant can be
-- refused and a half-finished one can be found again (tesserix-home#331).
--
-- ══ THERE IS NO DEFINITION TABLE HERE, AND THAT IS THE DECISION ══
--
-- 0046 has two tables because a promo code is authored once and materialised
-- into N Stripe accounts later: the definition is mode-independent and outlives
-- every coupon minted from it, so "what was authored" and "what exists in this
-- account" are genuinely two facts.
--
-- A per-tenant override has no such gap. The terms are chosen and minted in one
-- act, for one tenant, in one mode; there is no state between authoring and
-- minting for a definition row to occupy, and no second account a single
-- tenant's override is later replayed into. A `tenant_pricing_overrides`
-- definition table would therefore be a table whose every row is created in the
-- same statement as its only child, which is one table wearing two names.
--
-- And the DECISION — who granted this, why, and that it is in force — is not
-- this database's to hold. `apps/console/lib/tenant-lifecycle-write.ts` states
-- the estate's position on a federated write:
--
--     the audit row for this change is written by the PRODUCT, inside its own
--     transaction, bound to the state change it describes … a console-side
--     audit row would put a second, less trustworthy account of the same event
--     in a different database — and the two would disagree the first time a
--     write half-succeeded.
--
-- mark8ly attaches the coupon to the customer and audits the grant in that
-- transaction (tesserix/mark8ly#660). So there is no `reason` column below: the
-- reason is mandatory at the console boundary and is PASSED THROUGH to mark8ly,
-- and a copy kept here would be a second answer to "why does this tenant pay
-- less" that nothing can reconcile with the first.
--
-- What is left is exactly one fact, and it is one only this console knows: this
-- console created Stripe Coupon `co_…` in this account, for this tenant, on
-- this date. That is the same fact `promo_code_stripe_coupons` holds, and this
-- table is deliberately the same shape.
--
-- ══ NO DISCOUNT TERMS COLUMNS EITHER ══
--
-- `percent_off`, `amount_off`, `currency`, `duration` and `duration_in_months`
-- are FIXED on a Stripe Coupon once it exists — the reason 0046's
-- `UpdatePromoCodeInput` refuses to edit terms at all, and the reason
-- `stripe-write.ts` has no `updateCoupon`. So a copy here could not drift, and
-- the drift argument 0046 makes about `max_redemptions` does not apply.
--
-- They are absent for the weaker but sufficient reason: nothing needs them.
-- The two things this table exists to answer are "does this tenant already have
-- one" (the key below) and "which object do I go and look at" (the id below).
-- Rendering the terms is Stripe's account to answer, and columns added on the
-- guess that a surface might one day want them are columns whose correctness
-- nobody is checking. Add them when a reader exists.
--
-- ══ WHY THIS IS NOT KEYED (tenant_id, mode) OUTRIGHT ══
--
-- `promo_code_stripe_coupons` can use the bare pair as its primary key because
-- it has no supersession: a coupon's discount is immutable, so "change the
-- discount" is a NEW definition rather than a second coupon against the old
-- one, and the definition is the thing that goes away.
--
-- A TENANT does not go away. #331 asks for removal in the same breath as
-- application ("Removal is as audited as application"), and a tenant whose
-- override was removed in March must be able to receive a different one in
-- June. Under a bare `PRIMARY KEY (tenant_id, mode)` that second grant is
-- refused forever by a row describing a coupon nobody is using — and the only
-- ways out are deleting the row (which erases the pointer to a coupon that
-- still exists in a real Stripe account) or a later migration that rewrites the
-- uniqueness rule under live data.
--
-- So: a surrogate key, `removed_at` as the retirement marker, and the
-- at-most-one rule as a PARTIAL unique index over the live rows. This is
-- That is `plan_catalog_publications` (0035) exactly, down to the parts: a
-- surrogate `id`, a `superseded_at`/`superseded_by` pair with a biconditional
-- keeping them coherent, and `plan_catalog_publications_one_live_per_mode` as a
-- partial unique index over the un-superseded rows. It chose that shape because
-- re-publishing a superseded revision is a second row for the same pair; a
-- tenant re-granted an override is the same situation with a different subject.
--
-- And 0035's warning about that index carries over verbatim: it is A CEILING,
-- NEVER A FLOOR. It refuses a second live row; it cannot require that a tenant
-- with a live row is actually being charged less, because the charge happens in
-- another product's database. Only mark8ly can answer that.
--
-- `removed_at` and `removed_by` are NOT WRITTEN BY THE GRANT PATH. #331's T1
-- only ever inserts; T4 (removal, the counterpart of mark8ly's detach) is what
-- sets them. They are declared now rather than in a later migration because the
-- uniqueness rule below is stated in terms of them, and getting the uniqueness
-- rule right afterwards means altering a table that holds live pointers into a
-- billing account.
--
-- ══ RE-RUNNABILITY ══
--
-- `IF NOT EXISTS` throughout, every constraint declared INSIDE the CREATE TABLE
-- rather than by a later ALTER. Same rule 0046 states and the same reason:
-- migrations here are applied by hand, and a file that aborts on its second
-- application wedges every migration after it (tesserix-home#509).
--
-- ══ APPLY THIS BEFORE MERGING ══
--
-- Kargo deploys the console on merge; `db:migrate` does not ride along. Apply
-- 0047 to production BEFORE the PR carrying it merges, or the deployed console
-- queries a table that does not exist.

CREATE TABLE IF NOT EXISTS tenant_pricing_override_coupons (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The NAMESPACED tenant id, `<source>:<product id>` — exactly the string
    -- the tenant directory renders and `setTenantLifecycle` sends. Stored whole
    -- rather than split into (source, product_id): platform-api splits it
    -- itself to decide which product to call, and a bare product id passed to
    -- that boundary is refused rather than silently aimed at a default. A row
    -- here holding the bare id would be a row whose tenant cannot be acted on.
    --
    -- No separate `source` column for the same reason 0046 gives against a
    -- second spelling of a closed set: the source is the prefix, and two places
    -- to write it is two places to disagree.
    tenant_id text NOT NULL
              CONSTRAINT tenant_pricing_override_coupons_tenant_id_is_namespaced
              CHECK (tenant_id ~ '^[^:[:space:]]+:[^[:space:]]+$'),

    -- Which Stripe account the coupon below lives in. The same closed
    -- vocabulary and the same spelling as `promo_code_stripe_coupons.mode`
    -- (0046) and `plan_catalog_publish_attempts.mode` (0038): every Stripe id
    -- in this database is reachable from exactly one mode, and this row is no
    -- exception — a `test` coupon id is meaningless against the live account.
    mode text NOT NULL
         CONSTRAINT tenant_pricing_override_coupons_mode_is_a_stripe_mode
         CHECK (mode IN ('test', 'live')),

    -- `co_…`. NOT NULL because this row is written only AFTER the coupon
    -- exists, so a row whose id is unknown has nothing to say — 0046's wording
    -- for the identical column.
    --
    -- The blank CHECK is not decoration: `''` is NOT NULL, so without it an
    -- empty string records a mint that did not happen, in the one spelling
    -- `NOT NULL` cannot see.
    stripe_coupon_id text NOT NULL
                     CONSTRAINT tenant_pricing_override_coupons_coupon_id_is_not_blank
                     CHECK (btrim(stripe_coupon_id) <> ''),

    -- The operator who minted it, as a bare identity with no FK — operator
    -- identity lives in Zitadel, not in this database, so there is nothing to
    -- point at. Matches `promo_codes.created_by` and
    -- `plan_catalog_revisions.created_by`.
    --
    -- Named `granted_by` rather than `created_by` because the two halves of
    -- this row are a grant and a retirement, and `created_by`/`removed_by`
    -- would read as if they described different kinds of act.
    granted_by text NOT NULL
               CONSTRAINT tenant_pricing_override_coupons_granted_by_is_not_blank
               CHECK (btrim(granted_by) <> ''),
    granted_at timestamptz NOT NULL DEFAULT now(),

    -- The retirement half. Both NULL is a live override; both set is a retired
    -- one. See the header — T4 writes these, the grant path never does.
    removed_by text,
    removed_at timestamptz,

    -- One biconditional rather than two NULL checks, for the reason 0046 gives
    -- for `promo_codes_discount_currency_accompanies_amount_off`: the two
    -- halves are the same rule, and splitting them lets a future edit satisfy
    -- one and drop the other. A `removed_at` with no `removed_by` is a removal
    -- nobody is accountable for; a `removed_by` with no `removed_at` is a row
    -- the partial index below still counts as live.
    CONSTRAINT tenant_pricing_override_coupons_removal_is_whole
    CHECK ((removed_by IS NULL) = (removed_at IS NULL)),

    -- A retirement cannot precede the grant it retires. `>=` and not `>`: a
    -- grant removed in the same transaction is odd but coherent, whereas a
    -- removal timestamped before its grant can only be a clock or an
    -- input error, and it reads as a live row on any surface ordering by date.
    CONSTRAINT tenant_pricing_override_coupons_removal_follows_grant
    CHECK (removed_at IS NULL OR removed_at >= granted_at)
);

-- AT MOST ONE LIVE OVERRIDE per tenant per Stripe account, and none of the
-- retired ones counted.
--
-- This is the cheap half of the at-most-one rule, and it is deliberately not
-- the authoritative one. Only mark8ly can see a customer's actual discounts
-- (#660), so only mark8ly can answer whether a tenant is really discounted —
-- a coupon minted here and never attached leaves a row that claims more than
-- is true, which is precisely the "minted, not applied" state #331 has to
-- report rather than hide. What this index guarantees is narrower and still
-- worth having: the console will not mint a SECOND real coupon in a real
-- billing account for a tenant it has already minted one for.
--
-- A partial unique index rather than a table constraint, because a table
-- constraint cannot carry a WHERE — and `CREATE UNIQUE INDEX IF NOT EXISTS` is
-- idempotent on its own, so this file needs none of the
-- `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` dance 0035 and 0044 do.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_pricing_override_coupons_one_live_per_tenant
    ON tenant_pricing_override_coupons (tenant_id, mode)
    WHERE removed_at IS NULL;

-- One row per coupon, ever. A `co_…` names one object in one account, so two
-- rows naming the same one is either the same grant recorded twice or two
-- tenants pointed at a single coupon — and the second is the dangerous one:
-- removing the override for one tenant would archive a coupon the other is
-- still being charged against.
--
-- Unretired-rows-only would be wrong here. The uniqueness is a property of the
-- Stripe object, not of whether this console still considers the grant live,
-- and a retired row must keep naming the coupon it retired.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_pricing_override_coupons_coupon_is_recorded_once
    ON tenant_pricing_override_coupons (mode, stripe_coupon_id);
