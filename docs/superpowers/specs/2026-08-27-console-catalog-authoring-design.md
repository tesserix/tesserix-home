# The console as the plan catalog's authoring surface

**Status:** design, third draft — scope reduced after two review rounds
**Date:** 2026-08-27
**Issues:** tesserix-home#326 (P1a, landed), #327 (P2, gated), §P of `BACKLOG.md`

## Scope, and why it shrank

Two rounds of specialist review found that each earlier draft's central mechanism
did not survive contact. The second round found a structural blocker:

> **The catalog cannot express a price creation.** It stores `lookup_key, plan,
> period, tier, currency, unit_amount_minor, tax_behavior`. A Stripe Price create
> needs `product`, `recurring.interval`, `currency`, `unit_amount` and
> `currency_options`. There is no product id anywhere in the catalog, `period`
> maps to no interval, and in live mode the three Products do not exist at all.

So "bootstrapping live is convergence through the same executor" — the load-bearing
justification for retiring `billing-bootstrap` — was not buildable.

**v1 therefore edits prices that already exist.** Amounts and tax behaviour, in
test mode, with guards, an operation log and independent verification. That is
the thing actually asked for: stop opening the Stripe Dashboard to change a
price. Every gap the reviews found was about *creation* and *bootstrap
retirement*, not editing.

### In scope (v1)

- Editing `unit_amount_minor` and `tax_behavior` on the 42 existing prices.
- Test mode only. Live has no catalog to edit (§1.9).
- Draft → plan → confirmed publish, with guards.
- An operation log, orphan detection, and verification by the parity check.

### Phase 2, deliberately deferred

- Creating prices and products. Requires the catalog to carry `product` and
  `recurring.interval`, and the comparator to check them.
- Bootstrapping live through the console.
- Retiring `billing-bootstrap`.
- Promo codes, per-tenant overrides (§P P4/P5).
- Kora's catalog — see §13.

## 1. Facts, with honest provenance

A previous draft put inferences in a section headed "verified". Each item below
is marked **[V]** verified against a primary source, **[I]** inference from one,
or **[X]** needs a cheap test-mode experiment before being relied on.

**1.1 [V] Stripe Prices are mostly immutable.** `PriceUpdateParams` accepts
exactly `active`, `currency_options`, `expand`, `lookup_key`, `metadata`,
`nickname`, `tax_behavior`, `transfer_lookup_key`. `unit_amount`, `currency`,
`recurring`, `product` are absent. Changing an amount means a new Price.

**1.2 [V] `transfer_lookup_key` is atomic and available on create.** *"Will
atomically remove the lookup key from the existing price, and assign it to this
price."* So the key is never unclaimed under any ordering.

**1.3 [V] The old Price keeps `active: true` and loses its `lookup_key`.**
Therefore **the archive step must carry the old Price id captured before the
create** — resolving by lookup key at archive time resolves to the *new* price.
mark8ly's `FindPriceByLookupKey` filters `Active: true` and would do exactly
that.

*Correction to draft 2: "addressable only by its Stripe id" was loose. It stays
listable by `product` + `active`, which matters for §9.2.*

**1.4 [V] `tax_behavior` cannot be changed once set** to `inclusive` or
`exclusive`. All six `aud` cells are already `exclusive`.
**[I]** That it *can* be set from `unspecified` is inferred from the
restriction's wording; no source states it affirmatively. **[X]** Confirm in
test mode before relying on the `update_tax_behavior` operation.
Note `null` (never set) and `'unspecified'` are distinct states.

**1.5 [V] The baseline currency is always `usd`, and `Options` holds all seven
currencies including it.** `price.go` filters the baseline out because *"Stripe
rejects the create call if `currency_options` contains the top-level currency"* —
a failure that stuck a bootstrap run once, recorded in that file's `price:v3:`
idempotency key. The filter is needed on the **update** path too.

**1.6 [X] Whether a partial `currency_options` update removes absent
currencies is UNKNOWN.** Draft 2 asserted it does, reasoning from the field
being `Emptyable`. That inference is invalid: `metadata` in the same interface
is also `Emptyable` and is documented as **merging**. No source states either
behaviour for `currency_options`.

**The mitigation is safe under both readings and stands regardless: always
resend all six non-baseline currencies.** Settle it with a test-mode experiment
anyway, because the answer decides whether a bug here is loud or silent.

**1.7 [V] Zero-decimal currencies need converting on the write path too.**
`toStripeUnitAmount` (currently module-private in `parity.ts`) divides by 100 for
the 16 zero-decimal currencies. **A write path that skips it sends every VND
price 100× wrong.** This is the same defect class that was found and fixed in the
comparator on 2026-08-27. Export the function; do not reimplement it.

**1.8 [V] The arithmetic.** 78 amounts across 42 lookup keys: 36 developed
non-`usd`, 6 developed `usd`, 36 PPP.

**1.9 [V] Live has never been bootstrapped** — 0 prices, 0 products, 0
subscriptions. **[V]** Both mark8ly billing secrets hold `sk_test_` keys despite
`prod-` prefixes.

**1.10 [V] `billing-bootstrap` is skip-if-exists, not a sync.** Re-running it
after an amount change is a silent no-op. It remains the only tool that can
create a Price from a descriptor — which is why v1 does not retire it.

## 2. The model: three-way, not two-way

Desired state is the draft. Observed state is Stripe. But a two-way diff cannot
distinguish *what I changed* from *what drifted* — so publishing would silently
revert a Dashboard edit without telling anyone, and §7's breadth guard would be
meaningless ("40 entries" could be 40 intended changes or 1 intended plus 39
drift corrections).

So the plan is computed from three inputs:

| input | role |
|---|---|
| the published revision | **ancestor** — what we last intended |
| the draft | **desired** |
| `listPrices(mode)` | **observed** |

Each plan entry is labelled **`intended`** (draft differs from ancestor) or
**`drift-correction`** (observed differs from ancestor, draft does not). Both are
published; only the labelling differs, and the operator sees both counts.

Observed state is required — a `usd` edit mints a Price carrying all seven
currencies, so drift in any of the other six would otherwise be applied silently
under a plan that never showed it.

The comparison reuses `compareCatalogToStripe`, which already solves the 42-vs-78
shape asymmetry and reconciles zero-decimal currencies. A second diff
implementation would have to solve both again and would disagree unadjudicatably.

**What "empty plan" means, stated precisely:** the amounts and tax behaviours
agree. It does **not** mean Stripe matches desired state — the comparator ignores
`product`, `recurring`, `nickname` and `active`. v1 does not create prices, so
this is a bounded claim rather than a hole; phase 2 must widen the comparator
before it can create anything.

### 2.1 The observation is fingerprinted

The operator confirms a plan computed at T and it executes at T+n. Neither
apply-as-shown nor re-plan-at-execution is safe alone: the first risks a stale
captured price id, the second executes a plan nobody approved with guards
evaluated against something unseen.

So the plan persists a **fingerprint** — a hash over the observed
`(lookup_key, currency, unit_amount, tax_behavior)` set. At execution the
observation is retaken; if the fingerprint moved, the publish **aborts** and the
operator re-plans. Confirmation then means something.

## 3. Data model

### 3.1 The migration is bigger than a constraint swap

`plan_catalog_prices` has **no `revision_id` column today**, and
`lookup_key` is globally `UNIQUE` — so a draft and a published revision cannot
both hold `mark8ly_pro_annual_developed_v1`. In order, in one transaction:

1. create `plan_catalog_revisions`
2. add `revision_id` to `plan_catalog_prices`, nullable
3. backfill all 42 rows to a synthetic baseline revision
4. set `NOT NULL`
5. **drop** `plan_catalog_prices_lookup_key_key`
6. add `UNIQUE (revision_id, lookup_key)`
7. create `plan_catalog_publications`, seed a `test` publication for the baseline

Skipping step 5 makes draft creation fail on its first INSERT, presenting as an
application bug for a reason the application cannot see.

### 3.2 Publication lives on the (mode, revision) edge

```
plan_catalog_revisions     id, note, created_by, created_at,
                           based_on_revision_id   -- the ancestor, §2
plan_catalog_publications  id (surrogate PK), mode, revision_id,
                           published_at, published_by,
                           superseded_at, superseded_by
                           partial unique on (mode) WHERE superseded_at IS NULL
```

- **draft** = a revision with no publication
- **published for a mode** = its current publication row
- **superseded** = derivable
- **`not_bootstrapped`** = no publication row for that mode

**The PK is a surrogate, not `(mode, revision_id)`** — re-publishing a previously
superseded revision is a second row with the same pair.

**`publications.revision_id` is `ON DELETE RESTRICT`**, not `CASCADE`. Copying
the cascade from `prices.revision_id` would make "discard a stale revision"
silently delete publish history.

**`based_on_revision_id` answers draft provenance.** With test published ahead of
live there is no single "the published revision" to copy from, and it is also the
ancestor §2 needs.

### 3.3 "Exactly one published" is not enforceable, and the transaction needs a lock

Partial unique indexes enforce a ceiling, never a floor. What is enforceable is
at most one live publication per mode.

Retire-then-promote in one transaction is **not sufficient on its own**: under
`READ COMMITTED`, two concurrent publishes race — B's
`UPDATE … WHERE superseded_at IS NULL` targets whatever is live *now*, so if A
committed in between, B silently retires A's brand-new publication. Take
`pg_advisory_xact_lock` on the mode first.

The document claims only what the transaction provides: no external reader
observes zero. Not "exactly one" as a schema property.

### 3.4 At most one draft IS worth an index

Draft 2 called this a UI constraint. That is the same reasoning that produced
§3.1's trap — two operators, two drafts, one silently lost. It is one partial
index; spend it.

### 3.5 The queries that go wrong without a mode

`readCatalogAmounts()` takes no mode and no revision. It must become
`readCatalogAmounts(mode)`, joining the live publication:

```sql
SELECT p.lookup_key, a.currency, a.unit_amount_minor, a.tax_behavior
  FROM plan_catalog_publications pub
  JOIN plan_catalog_prices  p ON p.revision_id = pub.revision_id
  JOIN plan_catalog_amounts a ON a.price_id = p.id
 WHERE pub.mode = $1 AND pub.superseded_at IS NULL
 ORDER BY p.lookup_key, a.currency
```

Covered by existing indexes; cheaper than today's unfiltered scan.

`plan_catalog_parity_runs` gains **`publication_id`**, not `revision_id` — it
carries both mode and revision, and it is what the run was actually clean
against. (#378's `0034` adds `mode` to that table and must merge first.)

### 3.6 The operation log

Referenced by §5 and §9.2, so it is specified here rather than left to invention.

```
plan_catalog_publish_operations
    id, publication_attempt_id, sequence,
    kind,                  -- update_currency_options | replace_price | ...
    lookup_key, currency,
    status,                -- pending | succeeded | failed
    stripe_call,           -- create | update | archive  (one row PER CALL:
                           --  a replace_price is TWO rows)
    stripe_price_id,       -- captured before create (§1.3); the archived id
    idempotency_key,
    error, started_at, finished_at
```

**One row per Stripe call, not per plan entry** — a `replace_price` is a create
and an archive, and §9.2 needs the archived id specifically. Indexed on
`lookup_key` so the 2am question — *what happened to this price* — is one query.

## 4. The publish plan

| operation | when | in place? |
|---|---|---|
| `update_currency_options` | non-baseline amount changed | yes — **resend all six** (§1.6), **baseline filtered out** (§1.5) |
| `replace_price` | `usd` or PPP amount changed | no — create+transfer, archive by captured id (§1.3) |
| `replace_price` | `tax_behavior` changes from a set value (§1.4) | no |
| `update_tax_behavior` | `tax_behavior` changes from `unspecified` [X] | yes |

`create_price` and `archive_price` are phase 2. A catalog row with no Stripe
price, or a Stripe price with no catalog row, is **reported as unpublishable** in
v1 rather than silently skipped.

Every amount sent to Stripe passes through `toStripeUnitAmount` (§1.7).

## 5. Execution

### 5.1 Write-ahead, always

Each operation row is persisted with `status: pending` **before** the Stripe
call, and updated after. If that order inverts, a crash between the two produces
the "Stripe changed with no record" gap this design exists to prevent. §11 tests
it with a mock that fails after the DB write and before the network call.

### 5.2 Idempotency keys are a guard, not a guarantee

Keyed `(publication_attempt_id, sequence, attempt)`. The attempt counter is
required: Stripe replays **cached failures**, and `price.go` already bumped a key
v1→v3 for exactly that deadlock. Keys also expire after 24h.

Correctness comes from the fingerprint (§2.1) and re-planning, not from the keys.

### 5.3 The draft locks, and the lock expires

A plan the operator approved must not execute against a draft they then changed.

**The lock is derived, not a flag**: a draft is locked while it has a publish
attempt whose operations are not all terminal. A crashed publish therefore
cannot wedge it forever — the attempt is marked failed by a timeout
(`activeDeadlineSeconds`-style), and the draft frees. A flag with no release
path is worse than no lock.

### 5.4 What the operator sees when it half-fails

Not "logged, and detectable later". The publish action returns, synchronously,
which operations succeeded, which failed, the reason, and **the current state of
Stripe as the log knows it** — plus a direct link to re-plan. The orphan check
(§9.2) runs automatically at the end of a failed publish rather than waiting for
the nightly run.

## 6. Existing subscribers

**[V]** A subscription item stores no `unit_amount`; the amount resolves from the
live Price at invoice time. **[V]** Archiving does not reprice existing
subscriptions. **[I]** Therefore an in-place `currency_options` change reprices
existing subscribers of that currency at renewal — this last step is not
documented by Stripe and is **[X]** worth a test-mode experiment.

| operation | existing subscribers |
|---|---|
| `replace_price` | **unaffected** — `unit_amount` immutable, archiving does not reprice |
| `update_currency_options` | **repriced at next renewal** |

Two calibrations draft 2 got wrong by overcorrecting:

- **Today this affects nobody.** Live has 0 subscriptions (§1.9) and test mode
  has no real customers. It is a forward-looking invariant, not a present hazard.
- **The blast radius is not "36 cells".** **[V]** A subscription's currency is
  fixed at creation, so exposure is limited to currencies live subscribers were
  actually created in.

**§6 cannot be fully honoured in v1.** Saying "which currencies have live
subscribers" requires reading subscriptions, and `stripe-read.ts` states
outright that it performs no Subscription reads and that the key must not be
widened for it. v1 therefore **states the rule in the UI** — that in-place edits
reprice existing subscribers at renewal — without claiming to know who. Widening
the read scope is a deliberate decision for phase 2, not a side effect.

## 7. Guards

Mechanism safety does not protect against a correct mechanism publishing a wrong
number. A dropped zero publishes cleanly and the parity check confirms `clean`,
because it *is* clean.

- **Magnitude — measured against the ancestor**, not observed Stripe. A dropped
  zero is a divergence from prior intent; against observed, correcting real drift
  would trip it and a typo coinciding with drift would pass. Threshold: **±25%**
  requires a typed confirmation naming the plan.
- **Breadth — counted in plan entries, labelled.** "40 intended" and "1 intended,
  39 drift" are different events. Over **10 intended entries** requires the same
  confirmation.
- **Currency coverage.** A developed price must carry exactly its seven
  currencies. A draft dropping `gbp` is not a Stripe error, it is checkout failing
  in the UK, and no operation in §4 catches it.
- **Mode.** v1 is test-only, enforced in code. When live is enabled, publishing
  to it requires typing the mode name — the estate lost an hour to a live/test key
  mix-up on 2026-08-27, and live's first publish is the largest action this tool
  will ever take.

Units are **plan entries** throughout — one `usd` edit is one entry that writes
seven amounts. Draft 2 used cells, entries and amounts interchangeably.

## 8. Credentials and authorization

`lib/billing/mark8ly/stripe-write.ts` — exactly `createPrice`, `updatePrice`,
`archivePrice`; `server-only`; private instance; own credential
(`STRIPE_WRITE_KEY_TEST` / `_LIVE`), mirroring `stripe-read.ts` and its guard
test. The parity check keeps the read-only key. Honestly: a CI-enforced boundary,
not a privilege boundary — both keys live in the same pod.

**Publishing requires `billing` + a new risk verb `publish-catalog`.**
`capabilities.ts` separates surfaces from risk verbs precisely so a surface grant
does not carry an unweighed blast radius.

**This is a deploy precondition, not one line.** Those strings are a contract
with Zitadel — the role must exist on the *Platform Console* project **and be
assigned** before merge, or publishing is dead for every operator with a
`CapabilityError` that names no cause.

Why not `rotate-credentials`, which already covers *"Payment-gateway keys, Stripe
settings"*: that verb is about credentials, and holding it should not imply the
ability to change prices. Different blast radius, different grant.

## 9. Verification

### 9.1 The parity check

Runs after publishing, and nightly. Now takes a mode (#378).

### 9.2 Orphan detection, via the operation log

`parity.ts:403` skips every price with a null or non-namespaced `lookup_key`, and
`stripePriceCount` counts the post-filter map — so a `replace_price` whose create
succeeded and whose archive failed leaves an active Price the check reports as
`clean`, with the expected 42.

Draft 2 proposed finding it by `product`; that is not implementable —
`StripePriceLike` has no `product` field, it is not expanded, and the catalog
stores no product ids.

**The implementable rule: query the operation log for archived price ids and
check whether they are still `active`.** The log is not what makes an orphan
identifiable — it is the only thing that makes it detectable.

## 10. The sources of truth v1 does not fix

§P names three hand-maintained copies. v1 makes the console authoritative for
**amounts in Stripe test mode** and leaves the others:

- `catalog.go` — still the bootstrap's input. Not retired; see scope.
- `pricing-data.ts` — **what the marketing site renders.** A console publish that
  changes a price makes marketing advertise one number while checkout charges
  another. Customer-visible, and invisible to both the parity check and the
  orphan check because neither knows the marketing page exists.

**This is accepted, named, and must be filed as a follow-up** (§P P3b covers the
snapshot approach). It is stated here because a design aimed at ending
three-copy drift must not quietly leave one copy diverging further.

## 11. Testing

- The classifier, pure, over every §4 row.
- **`toStripeUnitAmount` on the write path** — publishing VND sends
  `catalogMinor / 100` (§1.7).
- Baseline filtered out of `currency_options` on update as well as create (§1.5).
- All six non-baseline currencies resent (§1.6).
- Archive targets the **captured** id, with a fixture where resolving by lookup
  key would archive the wrong Price (§1.3).
- Write-ahead: a mock failing between DB write and network call leaves `pending`.
- Fingerprint mismatch aborts the publish (§2.1).
- Guards refuse; the ancestor baseline is used, not observed.
- Orphan detection finds an archived-but-still-active id (§9.2).
- Read client still exposes no write method.
- **Integration tests publish under a `ci_` `namespacePrefix`**, never
  `mark8ly_`. The real test-mode catalog is where the 7-day window is being
  measured; a test that mutates it certifies fiction.
- **[X] experiments**, run once against test mode and recorded here: does a
  partial `currency_options` update drop absent currencies (§1.6); can
  `tax_behavior` move from `unspecified` (§1.4); does an in-place amount change
  alter an existing subscription's next invoice (§6).

## 12. Rollout

The mode dimension already provides the phasing:

1. Migration + schema, applied to prod before merge (estate convention).
2. Zitadel role created and assigned (§8).
3. Read-only revision UI — the catalog rendered per mode, no editing.
4. Editing + plan + guards, publish disabled.
5. Publish enabled for **test mode only**, soaked.
6. Live enabled — only after live is bootstrapped by the existing CLI.

Realistically **3–4 weeks** for two people including review. The earlier drafts'
confidence implied days; it is not days.

## 13. What generalises

The transferable kernel is **declared desired state + observed state + a common
ancestor + converge + verify independently**. That is storefront-agnostic.

Not generic, and dangerous to copy: *what a price is*, *how many storefronts*,
and *Stripe's immutability rules* — the create-and-replace dance exists only
because of them.

Kora is deferred with evidence rather than by preference: it sells credit packs
in integer paise with 18% GST computed in code, a 2% platform fee, 30-day
validity and a quota grant; Cashfree is being removed (kora#479) and StoreKit IAP
becomes the rail before public launch (kora#487), putting part of its catalog in
App Store Connect where Apple owns the tiers and takes 15–30%. An abstraction
designed against mark8ly alone would be designed wrong.

**Namespacing:** either move `parity.ts`, `parity-run.ts`, `stripe-read.ts` and
`plan-catalog-repo.ts` into `lib/billing/mark8ly/` in the same change, or drop
the recommendation. Half-namespaced is worse than either end state — the next
reader cannot tell which convention is current. **Recommendation: drop it for
v1**, and do it when a second product actually arrives, since the move is
mechanical and the second case will reveal the right seam.

## 14. Open questions

1. **Rollback.** Publications make re-publishing a previous revision
   expressible, but it is not undo — a replaced Price stays archived and
   re-publishing mints another. **Recommendation: do not offer it in v1**, and
   say so in the UI, rather than implying an undo that does not exist.
2. **Discoverability.** Nothing tells the other operator a publish happened.
   `published_by`/`published_at` exist but are rendered nowhere. For two people
   this is tolerable; as a reference pattern it gets copied. v1: render them on
   the catalog surface.
3. **Does `marketplace-api` read the catalog from the console?** The invariant:
   *nothing on the request path of a customer payment may depend on the console
   being reachable.* Checkout resolves from Stripe by `lookup_key`. A synchronous
   read at checkout should be rejected; a cached sync is fine.
