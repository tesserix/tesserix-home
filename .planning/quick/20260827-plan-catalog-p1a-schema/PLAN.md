---
slug: plan-catalog-p1a-schema
date: 2026-08-27
mode: quick
issue: 326
---

# Plan catalog P1a, part 1 — schema + seed

First of two PRs for #326 phase P1a. This one is the catalog table and its
seed, with no Stripe involvement at all. The read-only Stripe client, the
comparator and the scheduled job are part 2.

Split because part 1 is unambiguous and unblocked, while part 2 needs a Stripe
credential that does not exist yet.

## Ground truth, measured today — NOT taken from the issue

`cd mark8ly/services/marketplace-api && go run ./cmd/pricing-dump` emits, from
`internal/billing/pricing/catalog.go`:

- **78 data rows**, one per (descriptor × currency).
  - 42 `developed` = 6 descriptors (3 plans × 2 periods) × 7 currencies
    (`usd cad gbp eur aud nzd sgd`)
  - 36 `ppp` = 6 descriptors × 6 currencies (`idr inr myr php thb vnd`)
- **42 distinct `lookup_key`s** = 6 developed (one key shared across its 7
  currencies, because `currency_options` merge onto one Stripe Price) + 36 ppp
  (one Price, therefore one key, per currency).
- **`tax_behavior` is non-empty on exactly 6 of the 78 rows** — the AUD rows,
  all `exclusive`. The other 72 are the empty string.

**The issue's phased-plan comment says "81 `UnitAmountMinor` entries". It is
78.** Do not write a test asserting 81, and do not adjust the count to make one
pass. The verified CSV is committed alongside this plan as `pricing-v1.csv`;
that file is the expected side.

## What to build

### 1. Migration `apps/web/db/migrations/0032_plan_catalog.sql`

Next in sequence — 0031 is the highest today.

Two tables, mirroring the real shape rather than flattening it:

- `plan_catalog_prices` — one row per **descriptor**, keyed by `lookup_key`.
  Carries `plan`, `period`, `tier`, and `lookup_key UNIQUE`. 42 rows.
- `plan_catalog_amounts` — one row per **(descriptor × currency)**. Carries
  `currency`, `unit_amount_minor bigint`, `tax_behavior`, and a FK to the
  price. 78 rows.

**Why two tables and not one.** The one-table shape is what makes the naive
comparator wrong. A developed descriptor is ONE Stripe Price whose
`currency_options` carry six further currencies; a flat 78-row table loses the
fact that seven of those rows are one Price, and the comparator then tries to
match 78 catalog rows against 42 Stripe Prices. Modelling the join now is what
stops part 2 from having to reconstruct it.

Constraints that make bad data unstorable rather than merely discouraged,
following 0031's `platform_tools_subdomain_is_a_dns_label` precedent:

- `currency` CHECK: exactly three lowercase letters. A `USD` row and a `usd`
  row must not be able to coexist — Stripe's are lowercase.
- `unit_amount_minor` CHECK: `> 0`. There is no free plan in this catalog, and
  a zero would read as "free" rather than "not set".
- `tax_behavior` CHECK: one of `'inclusive'`, `'exclusive'`, `'unspecified'`.
  **Store `'unspecified'`, never the empty string or NULL** — see below.
- `period` CHECK: `'monthly'` or `'annual'`. `tier` CHECK: `'developed'` or
  `'ppp'`.
- `UNIQUE (price_id, currency)`.

### 2. The `tax_behavior` normalisation — the decision that keeps the window alive

The catalog's own comment (`catalog.go:47`) reads: *`"exclusive" for AU GST; ""
elsewhere (Stripe default)`*. Stripe's default for a Price created without
`tax_behavior` is the literal value `unspecified`, and that is what the API
returns when part 2 reads it back.

So `""` in the CSV and `unspecified` in Stripe are **the same state**. If the
seed stores `''` and part 2's comparator compares strings, it reports a
difference on 72 of 78 rows the first time it runs — and a check that opens
with 72 false positives is ignored by day two, which makes the 7-day window
theatre. Normalising at the seed, in the column's CHECK, is what prevents that.

Write the mapping down in a SQL comment on the column, not just here.

### 3. Seed, inline in the migration

`INSERT INTO … VALUES` in the migration body, following 0031's precedent for
`platform_tool_groups`. Generated from the committed `pricing-v1.csv` so the
values are reviewable in the diff — every amount visible to a reviewer, no
build step, no second parser of `catalog.go` (which is the duplication #326
exists to remove).

### 4. Test: `apps/console/lib/db/plan-catalog.integration.test.ts`

Follow the existing `*.integration.test.ts` convention in `lib/db/` (pglite).

- Every one of the **78** amounts is present, with the exact
  `(plan, period, tier, currency, unit_amount_minor)` tuple from
  `pricing-v1.csv`. Read the CSV in the test and assert against it — a
  hand-transcribed expectation is a third copy of the catalog, which is the
  bug this issue exists to kill.
- Exactly **42** rows in `plan_catalog_prices`, and the 6 developed descriptors
  each carry 7 amounts while the 36 ppp descriptors carry 1 each.
- The 6 AUD rows are `exclusive`; the other 72 are `unspecified` and **none**
  are `''` or NULL.
- The CHECK constraints actually reject: an uppercase currency, a zero amount,
  a `tax_behavior` of `''`. Assert the insert fails — a constraint nobody tests
  is a comment.

## Verification

- `pnpm test` in the console workspace; rebuild `console-core` first.
- `pnpm --filter web db:migrate` against a local database, then re-run it — the
  migration must be re-runnable, matching 0031's `IF NOT EXISTS` style.

## Explicitly NOT in this PR

- Any Stripe client, key, fetch or comparator. That is part 2.
- Any console surface. That is P1b.
- Any write path to Stripe, ever, per the issue's DoD.

## Blocking note for whoever merges

**The migration must be applied to prod BEFORE this PR merges.** Kargo
auto-deploys the console on merge and `db:migrate` does not ride along, so
merging first means the app runs against a database without the table. This is
the estate convention, not a preference.
