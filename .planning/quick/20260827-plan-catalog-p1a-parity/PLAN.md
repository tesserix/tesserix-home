---
slug: plan-catalog-p1a-parity
date: 2026-08-27
mode: quick
issue: 326
---

# Plan catalog P1a, part 2 — the parity check

Second of two PRs for #326 phase P1a. Part 1 (PR #371) landed the catalog:
`plan_catalog_prices` (42 rows, keyed by `lookup_key`) and
`plan_catalog_amounts` (78 rows, one per descriptor × currency).

This PR builds the thing the phase exists for: a check that compares the
catalog against live Stripe Prices and **reports** differences. It is what
starts the 7-day observation window that gates #327 and, through it,
mark8ly #303/#304/#305.

## The hard constraint: no write path to Stripe, structurally

The issue's DoD says "no write path to Stripe anywhere in this change", and P2
later revokes mark8ly's Stripe write key **on the strength of this window**. So
read-only has to be true by construction, not by review:

- `lib/billing/stripe-read.ts` exports a type whose ONLY method is
  `listPrices()`. No create, no update, no archive — not "unused", *absent*, so
  a future edit cannot quietly acquire one without adding a method and being
  seen to do it.
- The underlying `Stripe` instance is private to that module and never
  returned. Returning it would hand every caller the full write API.
- `server-only` at the top, as `lib/auth/operator-token-store.ts` does.
- The credential is a Stripe **restricted key** scoped to read on
  Products/Prices — decided on the issue. The code must not assume more, and
  must fail with a clear message when the key is absent rather than throwing a
  raw Stripe error.

## The comparator — the part that decides whether the window means anything

`lib/billing/parity.ts`. A **pure function**: catalog rows in, Stripe prices
in, a structured diff out. No I/O, no database, no `stripe` import — only
types. That keeps it exhaustively testable against fixtures and keeps it clear
of any module with server ancestry.

It **reports**. It never throws on a difference and never asserts equality.

### The shape asymmetry it has to get right

The catalog has 78 amounts but only **42** `lookup_key`s, because a `developed`
descriptor is ONE Stripe Price whose `currency_options` carry six further
currencies, while each `ppp` descriptor is its own Price. So:

- Group catalog amounts by `lookup_key` → 42 expected Prices.
- For a Stripe Price, the currencies it covers are its own `currency` plus every
  key of `currency_options`; the amount for each is `unit_amount` and
  `currency_options[c].unit_amount` respectively. Same for `tax_behavior`.
- A naive one-row-per-Price comparison lines up 78 against 42 and reports
  nonsense. Do not write one.

### Difference kinds, reported distinctly

Both directions matter, per the issue:

- `price_missing_in_stripe` — a catalog `lookup_key` with no live Price
- `price_missing_in_catalog` — a live Price in our namespace with no catalog row
- `currency_missing_in_stripe` / `currency_missing_in_catalog` — a matched key
  where one side covers a currency the other does not
- `amount_mismatch` — same key + currency, different `unit_amount_minor`
- `tax_behavior_mismatch`

Each difference carries `lookup_key`, `currency` where applicable, and both
values, so a report is actionable without a second query.

### Two traps that would poison the signal

**1. `tax_behavior`.** The catalog stores `unspecified` (part 1 normalised it;
`''` is unstorable). Stripe returns `unspecified` for a Price created without
one. These now compare directly — do NOT reintroduce a mapping, and do not
treat `null`/`undefined` from Stripe as a difference from `unspecified`.

**2. Zero-decimal currencies — do not "fix" this.** `catalog.go:159` claims
Stripe stores IDR and VND ×100. IDR is not a zero-decimal currency in Stripe,
so ×100 is simply correct there. **VND is**, so ×100 would mean ₫32,900,000 for
a plan priced at ₫329,000.

The comparator must **not** normalise, scale, or special-case this. Compare
verbatim and report the difference. But when an `amount_mismatch` is on a
Stripe zero-decimal currency AND the two values differ by exactly a factor of
100, set a `zeroDecimalSuspect: true` flag on that difference — so the VND
question surfaces as a named, legible finding rather than an unexplained
number. Hard-code the zero-decimal set as a named constant with a comment; VND
is in it, IDR is not.

## Storage: `plan_catalog_parity_runs`

Migration `apps/web/db/migrations/0033_plan_catalog_parity_runs.sql`. Follow
0031/0032's style.

The window is "clean for 7 consecutive days", so it has to be a **query over
stored runs**, not someone's recollection:

- `id`, `ran_at timestamptz NOT NULL DEFAULT now()`
- `outcome` CHECK in (`'clean'`, `'differences'`, `'failed'`) — three states,
  not a boolean. A run that could not reach Stripe is **not** clean, and
  collapsing it into `false` would let an outage read as a difference (or, far
  worse, a failure read as clean).
- `difference_count integer NOT NULL DEFAULT 0`
- `differences jsonb NOT NULL DEFAULT '[]'` — the full report
- `error text` — set only when `outcome = 'failed'`
- CHECK: `outcome = 'clean'` implies `difference_count = 0`; `'differences'`
  implies `> 0`. Make an incoherent row unstorable.

## The runner

`apps/console/app/api/internal/parity-check/route.ts`, `POST`.

- Guarded — it must not be publicly invocable. Use the console's existing
  internal-access convention; read `lib/internal-access.ts` and follow what the
  other server entry points do rather than inventing a scheme.
- Reads the catalog, calls `listPrices()`, runs the comparator, writes one row.
- Returns the outcome as JSON.
- **Every failure path writes a `failed` row.** A check that silently does
  nothing when Stripe is unreachable produces a gap in the window that looks
  identical to a clean day — which is the single worst failure this design can
  have.

## Tests

- `parity.test.ts` — the comparator, against fixtures. Cover every difference
  kind; a fully-matching catalog producing zero differences; the developed
  fan-out (one Price, seven currencies) matching correctly; `unspecified` vs
  `unspecified` NOT being a difference; and a VND ×100 mismatch producing
  `amount_mismatch` with `zeroDecimalSuspect: true` while an IDR ×100 mismatch
  does NOT set the flag.
- `stripe-read.test.ts` — a guard test asserting the exported client type
  exposes no method whose name suggests a write (`create`, `update`, `del`,
  `archive`). Name them individually so it fails on the next change rather than
  counting.
- `0033` migration test in `lib/db/`, pglite, following part 1's
  `plan-catalog.integration.test.ts`: the outcome CHECK rejects a `clean` row
  with differences and a `differences` row with none.
- Route test: absent key → a `failed` row, not a throw; a clean comparison →
  a `clean` row.

## Verification

- Rebuild `console-core` before app tests.
- `pnpm test`, `pnpm typecheck`, `pnpm lint --max-warnings 0`.
- `next build`. **This matters more than usual here**: `stripe` is a Node
  library and `parity.ts` must stay importable without dragging it into a
  browser bundle. tsc will not catch that; the build will.

## Explicitly NOT in this PR

- Any console surface. That is P1b.
- The Kubernetes CronJob that calls the route — it lives in the `tesserix-k8s`
  repo and is a separate change. Note it in the PR body as the remaining step
  before the clock actually starts.
- Any write to Stripe, in any form.
- Any change to mark8ly, including the VND question.
