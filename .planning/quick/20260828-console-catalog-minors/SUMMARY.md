---
id: 260828-catalog-minors
slug: console-catalog-minors
date: 2026-08-28
issue: 411
status: complete
---

# Three minors from the catalog authoring review

Three findings deferred from #396's review, each small, each with a test.
Merged as `ba41083` (PR #414).

| | |
|---|---|
| `fcec958` | `fix(console)`: dedupe archived orphans by price id and type source as CatalogSource |
| `79b06cc` | `fix(console)`: make the refused-mode publish plan unable to carry a fingerprint |
| `37d413a` | `fix(console)`: the fallback refusal comment claimed wording it does not share |

## 1. Orphans could be reported twice for one Stripe Price

`archivedStripePriceIds` selected `DISTINCT op.stripe_price_id, op.lookup_key,
op.source`. That de-duplicates the common case — recovery is a fresh attempt
rather than a replay, so one Price id appears across several attempts' logs —
but **not** when the same price id was recorded under two different lookup keys
across retries: the tuple differs, both rows survive, and `findOrphans` emits
the same `priceId` twice.

Now `DISTINCT ON (op.stripe_price_id)` ordered by `op.started_at DESC`, showing
the most recent attempt's lookup key.

**The judgement call, recorded because it is arguable either way.** A Stripe
Price is a single object — one thing for an operator to go and clean up, however
many lookup keys it was logged under — so two rows is noise for the action being
taken, and the newest key reflects the plan's current shape rather than a stale
one. What is lost: a curious reader no longer sees that the price carried two
keys at all, which is itself weak evidence that something odd happened during
retries. The doc comment concedes that rather than pretending the choice is free.

**The real defect was the absent test**, not the duplicate row. It is now
covered: two attempts, same price id, different lookup keys, asserting one row
carrying the newer key. It genuinely fails against the old query — `toMatchObject`
on an array enforces length, so the old tuple-`DISTINCT` returning two rows fails
on count, not merely on content. Ordering is deterministic: the fixture sets
`startedAt` values a day apart rather than relying on `now()`.

## 2. `source` typed `string` where `CatalogSource` exists

`Orphan.source` (`lib/billing/orphans.ts`) and `ArchivedStripePrice.source`
(`lib/db/publish-repo.ts`) were `string` while `CatalogSource` is declared in
`lib/billing/source-policy.ts` and is what those values are — in a codebase that
otherwise threads `SINGLE_SOURCE` carefully rather than inlining the literal.

Both retyped. Worth noting the retyping added **no unsafe cast to production
code**: the query no longer re-selects `op.source` to cast it, it echoes the
caller's already-typed parameter, which is sound because the `WHERE` clause
scopes every returned row to exactly that value.

One test keeps an explicit `as CatalogSource` with a comment — it deliberately
exercises the DB layer (a plain `text` column) past the app-level union, to prove
source scoping works for a second product.

`publish-outcome.tsx`'s `PublishOutcomeOrphan.source` stays `string` on purpose:
`orphans.ts` is `server-only` and value-importing it into a client component
drags `pg`/`stripe` into the browser bundle.

## 3. The refused-mode plan could carry an empty fingerprint

`observeAndPlan` short-circuits before observing Stripe when `checkMode` refuses
the mode — correct, and the reason a `mode=live` page load no longer makes a paid
`prices.list` call. But the plan it built for that path carried `fingerprint: ""`.

Harmless at the time, since both callers bail before reading it. A trap later,
because an empty fingerprint is a *plausible* value rather than an obviously
absent one — the same reasoning that made `baselineCurrency` nullable in #396
instead of leaving it a guessed string.

`observeAndPlan` now returns a discriminated union on `modeRefused`, so the
refused branch's plan is `Omit<PublishPlan, "fingerprint">` and has no field to
read. `PublishPlan` itself is untouched, and the narrowing is compiler-enforced:
`publishAction` narrows via `if (result.modeRefused) throw` before destructuring.

## What review caught, and why it is recorded here

The first draft of item 3's dead-code fallback carried a comment claiming it threw
the "same wording the `refused` branch above already threw". It does not —
`checkMode`'s message names the mode, and this fallback structurally cannot,
because the guard verdict it would quote is precisely what is absent on that
branch. Corrected in `37d413a` to "equivalent in effect, deliberately different in
wording".

That was the **fifth instance in one day** of this codebase shipping a comment
asserting something the code does not do — and it appeared inside the PR whose own
item 3 exists to stop plausible-but-wrong values. The other four: a SQL status
filter contradicting its own doc header (Critical), a throw message claiming
"draft revision" with no draft check (Critical), an acknowledgement matched by rule
name but described as matching judgement, and a test comment justifying itself on
grounds two existing tests already covered.

Every one was caught by a reviewer asked specifically whether the comment matches
the code. None was caught by tests, typecheck, or lint — none of which read prose.

## Verification

- `pnpm --filter console exec vitest run` — 150 files / 2437 tests (2436 before, +1)
- `pnpm --filter console exec tsc --noEmit` — zero errors
- `pnpm --filter console lint` — zero warnings (`eslint --max-warnings 0`)
- `pnpm --filter console build` — green

## Out of scope, deliberately

Nothing touches `parity.ts`, the parity-run tables, or any migration. #392 is
parked because it would disturb the 7-day observation window #327's go-live
decision depends on.
