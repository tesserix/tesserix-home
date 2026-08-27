---
slug: parity-dual-mode
date: 2026-08-27
mode: quick
issue: 326
---

# The parity check covers both Stripe modes

Extends #326 P1a. The check currently reads one Stripe key and writes one row
per run, with no notion of mode.

## What the live run established

Verified 2026-08-27 against every Stripe credential in the estate:

| secret | mode | `mark8ly_*` prices |
|---|---|---|
| `prod-mark8ly-stripe-billing-secret-key` | `sk_test_` | 42 |
| `prod-mark8ly-uat-stripe-billing-secret-key` | `sk_test_` | 42 |
| a `rk_live_` restricted key | live | **0** (also 0 products, 0 subscriptions) |

The catalog exists ONLY in test mode. Live has never been bootstrapped.

The comparator is clean against test: 42/42 prices, 78 amounts, **0
differences** (after the zero-decimal fix in #377).

## The decision this implements

The gate for #327 is now: **7 consecutive days where BOTH modes are `clean`.**
Chosen deliberately over the weaker options, knowing it parks #327 → #328/#329
→ mark8ly #303/#304/#305 behind a live bootstrap that has no date.

This falls out of the schema without special-casing: `not_bootstrapped` is not
`clean`, so "both modes clean" already requires live to have a real catalog.

## The state that must not be collapsed

A mode with **zero** `mark8ly_*` prices is `not_bootstrapped`, NOT 42
`price_missing_in_stripe` differences.

Reporting 42 differences nightly for a mode nobody has launched is noise that
trains people to ignore the report — and the report is the only evidence the
window is made of. `not_bootstrapped` says "nothing here yet"; `differences`
says "something here is wrong". They are different facts and must look
different.

**Only zero counts.** A partial bootstrap — say 20 of 42 — is genuinely
`differences` and must still report as such. That is the case where someone
ran the tool and it half-worked, which is far more dangerous than not running
it at all.

## 1. Migration `0034_parity_runs_mode.sql`

Next in sequence (0033 is highest; prod is at v33 with **0 rows** in this
table, so no backfill concern — but write it to be correct on a non-empty
table anyway, because dev databases have rows).

- `mode text NOT NULL` — CHECK `IN ('test', 'live')`. Add with a
  `DEFAULT 'test'` so the ALTER succeeds on a populated table, then **drop the
  default**: every future writer must state the mode rather than inherit one.
- Extend the outcome CHECK to `('clean', 'differences', 'failed',
  'not_bootstrapped')`.
- Extend the coherence CHECK: `not_bootstrapped` implies
  `difference_count = 0`, exactly as `clean` does. An incoherent row stays
  unstorable.
- Index on `(mode, ran_at DESC)` — the window query is per mode.

Match 0032/0033's commenting register: say what becomes unstorable and why.

## 2. `lib/billing/stripe-read.ts`

- Two env vars: `STRIPE_RESTRICTED_READ_KEY_TEST` and
  `STRIPE_RESTRICTED_READ_KEY_LIVE`. **Both independently optional.** A missing
  key must give THAT MODE a `failed` row — never crash the job and never take
  the other mode down with it.
- `listPrices(mode)`. Keep the memoisation, now per mode AND per key value, so
  rotating one key does not require a restart and does not disturb the other.
- Keep the type free of write methods, and keep the guard test.
- A key whose prefix contradicts its slot (`rk_live_` in the test variable) is
  worth failing loudly — that exact mix-up cost an hour today. Report it as
  `failed` with a message naming the mismatch, rather than silently comparing
  against the wrong account.

## 3. `lib/billing/parity-run.ts`

- `performParityCheck(mode)` returns a `ParityRun` carrying its mode.
- `not_bootstrapped` when the namespace-filtered Stripe price count is exactly
  zero. Otherwise the existing logic is unchanged.

## 4. `lib/db/plan-catalog-repo.ts`

- `recordParityRun` takes the mode and writes it.
- Add `readWindowStatus(days)` returning, per mode, whether the last N days are
  each `clean`. This is what makes "is the window satisfied?" answerable
  without hand-reading rows — and it is the query #327 will actually cite.
  Missing days count as NOT clean: a day with no row is absence of evidence,
  never evidence of agreement.

## 5. `scripts/parity-check.ts` and the route

- Both run **both modes** and write one row each.
- Exit code: 0 when every mode produced a row, whatever the outcome —
  `differences` and `not_bootstrapped` are findings, not crashes. Non-zero only
  when a mode could not be recorded.
- One structured log line per mode.
- A failure in one mode must not prevent the other's row being written. Test
  this explicitly.

## 6. Tests

- Migration: the new CHECKs reject `not_bootstrapped` with differences, an
  unknown mode, and a NULL mode.
- Comparator/runner: zero namespace prices → `not_bootstrapped`; 20 of 42 →
  `differences` and NOT `not_bootstrapped` (the partial-bootstrap case);
  each mode's key missing independently; a mode-prefix mismatch reported.
- Script: two rows written per run; one mode failing still writes the other.
- `readWindowStatus`: 7 clean days in one mode but not the other is NOT
  satisfied; a missing day is NOT satisfied.

## 7. `tesserix-k8s#653` must be updated in step

That PR currently wires a single `STRIPE_RESTRICTED_READ_KEY`. It becomes two
entries, both gated and both `optional: true`. Note it in the PR rather than
silently leaving it stale.

## Verification

- Rebuild `console-core` first. Full console suite, typecheck, lint,
  `next build`.
- Rebuild the cron bundle and confirm `pg` external / `stripe` inlined is
  unchanged.

## NOT in this change

- Bootstrapping live Stripe. That is mark8ly's, and it is the thing the gate
  now waits for.
- Any console surface (P1b).
- Any write to Stripe, in any mode.
