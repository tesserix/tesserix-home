---
slug: console-catalog-minors
issue: tesserix-home#411
created: 2026-08-28
---

# Three minors from the catalog authoring review

All three were found reviewing #396, classed Minor, and deferred deliberately.
Each is a one-or-two-line change plus a test. Behaviour changes in exactly one
of them (item 1), and that one needs its test written first.

## 1. `DISTINCT` does not de-duplicate one price id under two lookup keys

`apps/console/lib/db/publish-repo.ts`, `archivedStripePriceIds`, selects
`DISTINCT op.stripe_price_id, op.lookup_key, op.source`. Its doc comment
explains the `DISTINCT` as what stops `findOrphans` reporting the same orphan
twice, because recovery is a fresh attempt rather than a replay, so one Stripe
Price id can be the target of an `archive` operation in more than one attempt's
log.

That holds for the common case. It fails when the **same price id** was recorded
under **two different lookup keys** across retried attempts: the tuple differs,
both rows survive, and `findOrphans` emits the same `priceId` twice.

Impact is presentational — a duplicated row in a list an operator reads, not a
wrong write. But the comment hedges ("for that reason alone") rather than stating
the limit, and the case has **no test**.

**Decide and implement:** either de-duplicate on `stripe_price_id` alone, or keep
the current behaviour and state the limit plainly in the comment. If
de-duplicating, the lookup key is currently carried for display, so choose
deliberately which key to show for a price that has had two, and say why.

Either way: **add an integration test for the two-keys-one-price case.** It has no
coverage today, which is the actual defect. `publish-operations.integration.test.ts`
applies migrations through 0038 and is the right home.

## 2. `source` typed `string` where `CatalogSource` exists

`Orphan.source` (`apps/console/lib/billing/orphans.ts`) and
`ArchivedStripePrice.source` (`apps/console/lib/db/publish-repo.ts`) are both
`string`, while `CatalogSource` is declared in `apps/console/lib/billing/source-policy.ts`
and is what these values actually are.

Widening to `string` at the boundary discards the one guarantee the named type
gives, in a codebase that otherwise threads `SINGLE_SOURCE` carefully rather than
inlining the literal. Note the precedent from #396: a type was made optional to fit
a test fixture and that was reverted — the fixture was at fault, not the type.

Check every consumer compiles; if a call site genuinely holds an unvalidated
string, that call site is where validation belongs, not a widened type.

## 3. `observeAndPlan` returns `fingerprint: ""` on the refused-mode path

`apps/console/app/(console)/platform/billing/catalog/actions.ts`. `observeAndPlan`
short-circuits before observing Stripe when `checkMode` refuses the mode — correct,
and the reason a `mode=live` page load no longer makes a paid `prices.list` call.
The plan it constructs for that path carries `fingerprint: ""`.

Harmless today: both callers (`planPublishAction`, `publishAction`) bail on the
refusal before reading `plan.fingerprint`. It is a trap for the next caller, because
an empty fingerprint is a *plausible* value rather than an obviously absent one —
the same reasoning that made `baselineCurrency` nullable during #396 rather than
leaving it a guessed string.

**Preferred:** make the refused path's return shape unable to carry a fingerprint at
all, so a future caller gets a type error rather than an empty string that compares
equal to nothing. If that forces a large refactor, say so and fall back to an
explicitly-absent value with a comment, but try the type route first.

## Verification (all required)

- `pnpm --filter console exec vitest run` — full suite, currently 2436 passing
- `pnpm --filter console exec tsc --noEmit` — zero errors
- `pnpm --filter console lint` — clean; CI runs `eslint --max-warnings 0` and this
  is what caught the last branch's only CI failure
- `pnpm --filter console build`

## Out of scope

Anything touching the parity check or its migrations — tesserix-home#392 is parked
until #327's 7-day observation window closes, and this task must not disturb it.
