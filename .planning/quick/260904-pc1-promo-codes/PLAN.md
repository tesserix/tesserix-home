---
id: 260904-pc1
slug: promo-codes
date: 2026-09-04
issue: 521
kind: quick
branch: feat/promo-codes-521 (stacked on feat/catalog-redesign-p0, PR #541)
---

# The console owns promo codes (#521)

A merchant types a code during Mark8ly onboarding; it extends the 90-day trial by
N days, and/or applies a price discount. This is the **console half**: owning the
definitions, publishing them, and writing the Stripe coupons. mark8ly redeems.

## Verified before planning, not taken from the issue

- **`StripeCatalogWriter` has no coupon surface.** Six methods, all Product/Price
  (`stripe-write.ts:214-341`). Coupons are net-new here.
- **Nothing promo- or coupon-shaped exists in `apps/console` source.** The only
  matches are `.next/` and `dist/` build artifacts. Greenfield.
- **#331 needs no typed code.** It applies a Coupon to one tenant's customer with a
  mandatory reason. The Stripe object is the same primitive; the console-side
  definition is not. That shapes T2 below.
- **#331's body is stale** — it says "Blocked on #330", and #330 was closed
  not-planned. Worth correcting on the issue when this lands, the way #328's body
  was corrected.

## Decisions, settled — do not re-open these

1. **`max_redemptions` is EXACT, and mark8ly is declared the only consumer.** It
   counts its own redemptions transactionally, which it can do precisely because it
   is the sole redeemer. Say this in the issue AND in the code: a second consumer
   makes the cap distributed and this design stops being correct. The failure mode
   of leaving it implied is someone adding a consumer years from now and never
   learning the cap silently became approximate.
2. **Both effects stack on one code.** `trial_extension_days` and `stripe_coupon_id`
   are independent optionals; at least one required, both allowed. The merchant types
   one code and never learns which mechanism fired.
3. **A repeating coupon combined with a trial extension WARNS at authoring time**, and
   is allowed. Stripe starts a `repeating` duration at the first charge — which is
   after the now-longer trial — so "3 months half price" on a code that also adds 30
   trial days silently begins four months out. Surface that where the operator
   configures it. Do not refuse the combination; it is sometimes exactly what is wanted.
4. **`createCoupon` is a standalone writer method** that promo-code publishing calls,
   not coupon creation welded into the publish path. #331 then reuses it and adds only
   its own apply/remove-against-customer methods. Do NOT build those now — unexercised
   writer code is what this milestone got burned by.

## THE LESSON THIS TASK EXISTS UNDER

Every Stripe writer stub in the suite returns success unconditionally, so nothing
asserted what was actually **sent** to Stripe. That is how a missing
`transfer_lookup_key` survived a green suite and made every price change impossible
for 18 days — the plan was right, the ordering was right, the operation log was
right, and the one wrong thing was a field in the payload no test looked at.

`makeRecordingWriter` (`publish-executor.test.ts:614`) is the answer and the pattern
to copy: it records the spec it is handed so a test asserts the **request**. Every
task below that touches Stripe asserts the request. A test that only checks
`outcome: "succeeded"` is worth nothing here and will be treated as missing.

## Tasks — one atomic commit each

### T1 — Schema and repository

Migration `0046_promo_codes.sql` plus a repo module beside `plan-catalog-repo.ts`.

- Definition carries: code, `trial_extension_days` (nullable int), `stripe_coupon_id`
  (nullable text), validity window, `max_redemptions` (nullable int), active flag,
  and the usual authoring provenance this schema already keeps.
- **Canonical stored form: upper-case, trimmed**, with a unique index on it, and
  input normalised the same way at every boundary. Redemption is then
  case-insensitive by construction rather than by a `lower()` on every read.
  Constraint-name the rule the way `plan_catalog_amounts_currency_is_lowercase_iso_4217`
  does, so the invariant is visible in the schema and not only in TypeScript.
- **A CHECK that at least one effect is present.** Decision 2 allows both and requires
  one; a row with neither is a code that does nothing, and the database should refuse it.
- Integration tests in the established `*.integration.test.ts` style.

**Migration ordering — load-bearing.** Migrations in this estate are applied by hand
and deploys are not: Kargo ships the console automatically on merge, and `db:migrate`
does not ride along. So `0046` must be applied to production **before** this branch
merges, or the deployed console queries a table that does not exist. Flag this in the
PR; do not apply it yourself.

### T2 — `createCoupon` on the writer

Extend `StripeCatalogWriter` with `createCoupon(mode, spec, idempotencyKey)`.

- Percent-off / amount-off, duration (`once` / `repeating` / `forever`), duration in
  months, currency for amount-off, and Stripe's own redemption cap are **Stripe's
  job** — pass them through, do not reimplement them.
- Standalone per decision 4: promo-code publishing calls it; it does not know what a
  promo code is.
- Idempotency key in the same shape the existing five write methods use — read them
  and match, do not invent a second convention.
- **Tests assert the REQUEST**, via a recording writer in `makeRecordingWriter`'s
  shape. At minimum: percent-off and amount-off produce the right Stripe fields and
  never both; `duration: "repeating"` carries `duration_in_months` and the others do
  not; amount-off carries a currency and percent-off does not. Write at least one
  test that you have confirmed FAILS against a deliberately wrong payload — if you
  cannot make it fail, it is not testing the request.

### T3 — `GET /api/v1/promo-catalog`

Mirror `apps/console/app/api/v1/plan-catalog/route.ts` — do not invent a second
contract shape or a second auth story.

- Same Zitadel machine-token auth, same two-step 401-vs-403 split (that route's own
  comment explains why the status codes must not collapse; read it).
- `revision_id` + `ETag` + explicit `Cache-Control`, matching the plan-catalog route.
- **Additive changes only**, same rule, stated in the module doc.
- Serve only what a redeemer needs. `plan-catalog` deliberately excludes
  `published_by` because an operator's identity has no business crossing into a
  product's runtime; apply the same test to every field here and say what you excluded.
- The fail-open constraint is mark8ly's to implement, but the contract must make it
  possible: a redeemer must be able to cache this and treat an unknown code as
  *invalid* rather than erroring a signup. Someone who mistypes a code must still be
  able to finish onboarding.

### T4 — The authoring surface

A **Promo codes** tab in `CatalogSurface` (`catalog-surface.tsx`) — one array entry,
which is what the redesign's shell was built for.

- CRUD over definitions, with the decision-3 warning surfaced where a repeating
  coupon meets a trial extension.
- Creating a discount calls `createCoupon` and stores the returned id on the definition.
- Capability-gated the way the catalog surface is (`canDraft` / `canPublish` pattern,
  each check independent, mirroring what the server action re-checks itself).
- Redemption counts are **read** from mark8ly for display. The console is not the
  writer of redemption state — that ledger is transactional and tenant-scoped and
  lives where redemptions happen. If mark8ly has no endpoint for it yet, render the
  absence honestly rather than a zero.

## Verification for every task

```
pnpm --filter console test:unit
pnpm --filter console typecheck
pnpm --filter console lint
pnpm --filter console build
```

`build` is not optional — it is the only one of the four that sees server-only code
reaching the browser bundle, and #539 shipped past the other three.
