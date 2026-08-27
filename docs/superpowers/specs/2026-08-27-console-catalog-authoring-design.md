# The console as the plan catalog's authoring surface

**Status:** design, second draft — first draft reviewed and substantially wrong
**Date:** 2026-08-27
**Issues:** tesserix-home#326 (P1a, landed), #327 (P2, gated), §P of `BACKLOG.md`

## Why there is a second draft

Four specialist reviews of the first draft found errors serious enough to
rewrite rather than patch. They are listed here rather than quietly fixed,
because each one is a trap the implementation could fall back into:

1. **The headline safety claim was inverted.** The first draft said an edit
   never changes what a live customer pays. That is false for 36 of 78 cells —
   see §6. The operation it called benign is the dangerous one.
2. **The verification could not see its own worst failure.** A half-applied
   `replace_price` leaves an orphan the parity check structurally cannot
   report — see §9.2.
3. **`tax_behavior` cannot be updated in place** once set, and six cells are
   already set — see §1.4.
4. **The schema could not hold a draft** at all — see §3.1.
5. **Revision status and mode contradicted each other** — see §3.2.
6. **Idempotency keys replay cached failures and expire in 24h**, so the resume
   path deadlocked on the failure it existed for — see §5.3.
7. **No guard against a correct mechanism publishing a wrong number** — §7.
8. **It shipped a third source of truth** — §10.

## Purpose

Make the console the place a mark8ly price is changed, so changing one does not
mean opening the Stripe Dashboard, and so the catalog stops being maintained in
places that can quietly disagree.

Intended as the reference pattern other products follow. §12 states what
generalises and — more importantly — what does not.

## Non-goals

- Promo codes, global discounts (§P P4), per-tenant overrides (§P P5).
- Kora's catalog. Kora is mid-migration: Cashfree is being removed (kora#479)
  and StoreKit IAP becomes the rail before public launch (kora#487), putting
  part of its catalog in App Store Connect where Apple owns the price tiers.
  Designing for it now means guessing. See §12.
- Migrating existing subscribers between prices.

## 1. Established facts

Verified against the running system and the installed SDK on 2026-08-27.
**Corrections from the first draft are marked.**

**1.1 Stripe Prices are mostly immutable.** `PriceUpdateParams` accepts exactly
`active`, `currency_options`, `expand`, `lookup_key`, `metadata`, `nickname`,
`tax_behavior`, `transfer_lookup_key`. `unit_amount`, `currency`, `recurring`
and `product` cannot change. Altering a headline amount means creating a new
Price and archiving the old.

**1.2 `transfer_lookup_key` is atomic, and available on create.**
*"Will atomically remove the lookup key from the existing price, and assign it
to this price."* So create-and-claim is one call and the key is never unclaimed
under any ordering.

**CORRECTION.** The first draft ordered creates before archives "so a lookup key
is never unclaimed". That reasoning was wrong — atomicity already guarantees it.
The real reason to capture the old Price first is §1.3.

**1.3 The old Price is left with `lookup_key: null`,** addressable only by its
Stripe id. Therefore **the archive step must carry the old Price id captured
before the create.** Resolving the old price by lookup key at archive time
resolves to the *new* price and archives what was just minted. mark8ly's
existing `FindPriceByLookupKey` filters `Active: true` and would do exactly
that.

**1.4 `tax_behavior` cannot be changed once set.** The SDK: *"Once specified as
either `inclusive` or `exclusive`, it cannot be changed."* All six `aud` cells
are already `exclusive`.

**CORRECTION.** The first draft listed `update_tax_behavior` as an in-place
operation. It is in-place **only from `unspecified`**; otherwise it is a
replacement.

**1.5 The baseline currency is always `usd`,** and `Options` holds **all seven**
currencies including the baseline.

**CORRECTION.** The first draft said `Options` holds "the other six". It does
not. `stripe/price.go` filters the baseline out at the Stripe boundary because
*"Stripe rejects the create call if `currency_options` contains the top-level
currency"* — a failure that already stuck a bootstrap run once. A plan builder
that iterates `Options` naively reproduces it.

**1.6 `currency_options` updates replace the whole map.** The field is
`Emptyable`. Sending only the changed currency **deletes the other five.** Every
in-place update must resend all six non-baseline currencies.

**1.7 The arithmetic.** Of 78 amounts: 36 developed non-`usd`, 6 developed
`usd`, 36 PPP — across 42 lookup keys. Confirmed against `pricing-dump`.

**1.8 The catalog matches Stripe test mode today** — 42 keys, 78 amounts, 0
differences, correct intervals, three correctly-mapped products.

**1.9 Live has never been bootstrapped** — 0 prices, 0 products, 0
subscriptions. Both mark8ly billing secrets hold `sk_test_` keys despite `prod-`
prefixes.

**1.10 `billing-bootstrap` is mode-agnostic but does not reconcile.** It is
skip-if-exists: `FindPriceByLookupKey` → if found, log "reusing" and move on.
Re-running it after an amount change is a **silent no-op**, not a sync.

## 2. The model: desired state, observed state, converge

The console's catalog is the **desired state**. Stripe is **observed state**.
Publishing is convergence, and verification is an independent re-observation.

The first draft planned by diffing draft against the published revision. That
was wrong in a way worth naming: a `usd` edit mints a new Price carrying all
seven currencies, six of them read from the draft. If Stripe had drifted on any
of those six — the exact thing the parity check exists to catch — the replace
would silently apply six changes the plan never showed.

So the plan is computed from **observed Stripe**, reusing `compareCatalogToStripe`:

```
plan = classify(compareCatalogToStripe(draftAmounts, listPrices(mode)), mode)
```

That function already solves the 42-vs-78 shape asymmetry, already reconciles
zero-decimal currencies, and is exhaustively fixture-tested. A second diff
implementation would have to solve all of it again and would disagree in ways
nobody could adjudicate.

**What this buys:**

- **Resume is re-observe and re-plan.** There is no pending-outcome to
  reconcile, so §5.3's 24-hour idempotency window stops being load-bearing.
- **Re-running a completed publish yields an empty plan** — a checkable
  statement, stronger than "repeats nothing".
- **A half-finished publish and ordinary drift are the same thing**, which is
  correct: both are "Stripe does not match desired state".
- **Bootstrapping live is not a special case** — it is convergence from an empty
  observation, a 42-entry plan through the same executor. §10.

**The cost, stated honestly.** The write path and the verification now share a
diff implementation, so a comparator bug makes both wrong in the same direction.
That trade is worth taking; the independence that matters here is **credential
and module** independence (§8), which is untouched. §9 does not claim
algorithmic independence.

## 3. Data model

### 3.1 The existing unique constraint must go

`plan_catalog_prices.lookup_key` is currently `UNIQUE` globally. A draft and a
published revision both hold `mark8ly_pro_annual_developed_v1`, so **draft
creation fails on its first INSERT** until this is replaced by
`UNIQUE (revision_id, lookup_key)`.

This is not optional and must land in the same migration. Missed, it presents
as an application bug for a reason the application cannot see.

### 3.2 Publication belongs on the (mode, revision) edge

The first draft put `status` on the revision and asserted "exactly one
published". That contradicts publishing per mode — and test-ahead-of-live is the
*normal* working state, not an edge case.

```
plan_catalog_revisions      id, note, created_by, created_at        -- no status
plan_catalog_publications   (mode, revision_id), published_at, published_by,
                            superseded_at
                            -- partial unique on (mode) WHERE superseded_at IS NULL
```

- **draft** = a revision with no publication
- **published for a mode** = its current publication row
- **superseded** = derivable, not a state anyone must remember to transition
- **`not_bootstrapped`** = live has no publication row. The special case in the
  first draft disappears.

"At most one draft" is a UI constraint; enforce it in the authoring flow rather
than spending an index on it.

### 3.3 "Exactly one published" is not enforceable

Postgres partial unique indexes enforce a **ceiling**, never a floor. "Never
zero" needs a deferred constraint trigger, which is not worth it here.

What is enforceable: at most one live publication per mode, plus an atomic
retire-then-promote in one transaction so no reader observes zero. **The
document must claim that and not more** — "exactly one" is a property of the
publish transaction, not of the schema.

### 3.4 Two queries that go silently wrong

- **`readCatalogAmounts()` has no revision filter.** The moment a draft exists it
  returns rows from every revision, duplicate lookup keys and all, and the
  comparator's grouping merges them. It must join the published publication for
  the mode, **in the same PR as the migration**.
- **`plan_catalog_parity_runs` has no `revision_id`.** Once "published" is
  mutable, a `clean` row three days old is ambiguous about *which* catalog it was
  clean against — and that table exists precisely to be trustworthy after the
  fact. Add the column.

### 3.5 Snapshot, not deltas

120 rows per revision. Deltas would solve a storage problem that does not exist
while making every query walk a chain. Draft creation is `INSERT … SELECT` in a
transaction — partial failure would otherwise leave a draft whose diff reads as
"everything archived".

`ON DELETE CASCADE` on `amounts.price_id` already makes discarding a draft a
single delete. A happy accident of the existing schema.

## 4. The publish plan

One entry per operation, classified by §1:

| operation | when | in place? |
|---|---|---|
| `update_currency_options` | non-baseline amounts changed | yes — **resend all six** (§1.6) |
| `replace_price` | `usd` or PPP amount changed | no — create+transfer, then archive by **captured id** (§1.3) |
| `replace_price` | `tax_behavior` changes from a set value (§1.4) | no |
| `update_tax_behavior` | `tax_behavior` changes from `unspecified` | yes |
| `create_price` | key absent from Stripe | — |
| `archive_price` | key absent from the catalog | — |

The screen leads with counts and **flags the repricing ones loudest** (§6) —
not the replacements, which is what the first draft got backwards.

## 5. Execution

### 5.1 Ordering

Create-then-archive per replacement, with the old Price id captured before the
create (§1.3). Not for lookup-key continuity — `transfer_lookup_key` is atomic
(§1.2) — but because the old price becomes unaddressable by key.

### 5.2 The operation log is audit, not recovery

Every operation is persisted **before** the Stripe call, with status `pending`,
and updated with the outcome and any resulting Stripe ids. If that order ever
inverts, a crash between the two produces exactly the "Stripe changed with no
record" gap this design claims to prevent. §11 tests it explicitly.

Recovery is §2's re-observe-and-re-plan. The log answers *what did we attempt
and what did Stripe say* — including the archived price's id, so orphans (§9.2)
are findable.

### 5.3 Idempotency keys are a guard, not a guarantee

Keyed on `(revision_id, operation_id, attempt)`. The attempt counter is
required: Stripe replays **cached failures**, and this codebase has already
deadlocked on that — `price.go` bumped a key v1→v3 for it. Keys also expire
after 24 hours, so they cannot carry a resume left overnight.

Correctness comes from convergence. The keys only prevent double-submit within
one attempt.

### 5.4 The draft locks while a publish is in flight

Operation ids bind to persisted, immutable plan rows. A draft edited mid-publish
could otherwise make a resumed operation reuse a key for a semantically
different call — Stripe returns the cached result, the call never happens, and
nothing errors.

## 6. What this does to existing subscribers — corrected

**A subscription item stores no amount.** Its fields are `price`, `plan`,
`quantity`, `discounts`, `tax_rates`; the amount resolves from the live Price at
invoice time, including `currency_options`.

| operation | cells | existing subscribers |
|---|---|---|
| `replace_price` | 42 | **unaffected** — `unit_amount` is immutable, and archiving does not reprice |
| `update_currency_options` | 36 | **repriced at next renewal**, silently |

The first draft had this exactly backwards, calling replacement the scary
operation and in-place updates benign. **The confirmation must be loudest on the
in-place path**, and the surface must say plainly which currencies have live
subscribers on them.

The honest statement: *existing subscriptions keep their original Price object;
that is not the same as keeping their original amount.*

## 7. Guards against a correct mechanism publishing a wrong number

Every safety property in the first draft protected against mechanism failure.
None protected against a dropped zero — which publishes cleanly, and which the
parity check then confirms as `clean`, because it *is* clean: catalog and Stripe
agree on the wrong price.

Pure functions in the plan builder, beside the classifier:

- **Magnitude** — refuse or hard-confirm any amount moving more than a set
  percentage.
- **Breadth** — a routine edit touches 1–7 cells. A 40-entry plan is a bootstrap
  or a mistake; make the operator say which.
- **Currency coverage** — a developed price must carry exactly its seven
  currencies. A draft that drops `gbp` is not a Stripe error, it is checkout
  failing in the UK, and no operation in §4 catches it because "fewer
  currencies" is a legitimate `update_currency_options`.

`0032`'s `unit_amount_minor > 0` CHECK is this instinct at the row level. These
are its siblings at the plan level.

## 8. Credentials and authorization

`lib/billing/mark8ly/stripe-write.ts` — exactly `createPrice`, `updatePrice`,
`archivePrice`. `server-only`, private Stripe instance never exported, its own
credential (`STRIPE_WRITE_KEY_TEST` / `_LIVE`), mirroring `stripe-read.ts`'s
construction and its guard test.

**The parity check keeps the read-only client and key.** #327 revokes mark8ly's
write key on the strength of that window; a check that could write would
undercut it.

Note honestly: this is a CI- and review-enforced boundary, not a privilege
boundary — both keys live in the same pod.

**Publishing requires `billing` *and* a new risk verb `publish-catalog`.**
`capabilities.ts` already separates surfaces from risk verbs, with its own
rationale: *"Seeing a surface and being trusted with its destructive verb are
different questions, and keeping them separate is what stops a surface grant
quietly carrying a blast radius nobody weighed."* `hard-delete` + `crm` erases a
contact; either alone does not. Gating publish on `billing` alone would upgrade
every existing grant — anyone who can view subscription state could change what
mark8ly charges — without one of those grants being re-reviewed.

A review argued a second capability is process for its own sake in a two-person
estate. The counter-argument taken here: the pattern exists, adding a verb is
one line, and this is the surface #327's argument rests on.

## 9. Verification

### 9.1 The parity check

After publishing, catalog and Stripe should agree, and the existing check says
so on its next run or immediately via the operator-triggered route.

### 9.2 Orphan detection — new, and required

The parity check **cannot** see the worst failure this design can produce.
`parity.ts:403` skips every price whose `lookup_key` is null or outside the
namespace. A `replace_price` whose create succeeded and whose archive failed
leaves an active Price with a null key — invisible, while the check reports
`clean`.

So a separate check: **an active Price in this Stripe account with no
`lookup_key` and a `product` belonging to the catalog is an orphan.** Report it
distinctly; it is a signal of a half-applied publish, not of drift.

The operation log (§5.2) carries the id, so an orphan is identifiable rather
than merely detectable.

## 10. Retiring `billing-bootstrap`

After this ships there would otherwise be **two writers** to Stripe's catalog
and **three sources of truth**: `catalog.go`, the console tables, and whatever
the Dashboard holds. #326 exists to stop exactly that; shipping a third place is
a regression dressed as progress.

Because bootstrapping live is convergence from an empty observation (§2),
`billing-bootstrap` has no remaining job once this works. It is retired in the
same change, and `catalog.go` reduces to lookup-key constants.

Stated explicitly because "we will delete it later", plus a working CLI, is not
a combination that ends in deletion.

## 11. Testing

- **The classifier, as a pure function** — every cell class in §4, including
  `tax_behavior` from `unspecified` versus from a set value.
- **Baseline filtering** — the plan never sends `usd` inside `currency_options`
  (§1.5).
- **Whole-map replacement** — an in-place update resends all six non-baseline
  currencies (§1.6).
- **Archive targets the captured id**, proven by a fixture where resolving by
  lookup key would archive the wrong Price (§1.3).
- **Write-ahead ordering** — a mock failing after the DB write but before the
  network call leaves a `pending` row (§5.2).
- **Convergence** — re-running a completed publish produces an empty plan.
- **Guards** — magnitude, breadth and currency-coverage each refuse.
- **Orphan detection** — an active null-key price is reported (§9.2).
- **Read client still has no write methods.**
- **Integration**: publish a draft against Stripe **test mode**, then run the
  parity check and assert `clean`. Cheap, because test mode is where the catalog
  already lives.

## 12. What generalises

**The transferable kernel** is *declared desired state + observed state +
converge + verify independently*. That is storefront-agnostic and applies as
readily to App Store Connect as to Stripe. The first draft named a UI-shaped
kernel ("draft → typed plan → confirmed publish"), which does not transfer.

**Not generic, and dangerous to copy:**

- *What a price is.* mark8ly's is a Stripe Price with `currency_options` and PPP
  siblings. Kora's is a credit pack in integer paise with 18% GST computed in
  code, a 2% platform fee, 30-day validity and a quota grant — and after
  kora#487 part of it lives in App Store Connect, where Apple owns the tiers and
  takes 15–30%.
- *How many storefronts.* mark8ly has one. Kora is heading for three.
- *Stripe's immutability rules* (§1). The create-and-replace dance exists only
  because of them.

**Cheap step to take now:** put mark8ly-specific code under
`lib/billing/mark8ly/` rather than letting it accumulate in the shared
namespace. Otherwise the second case begins with an unpicking exercise, which is
where "we will generalise later" usually dies.

**Named for later:** if Kora's price ends up expressed in Stripe *and* App Store
Connect *and* Play Console, that is three hand-maintained copies of one catalog
— #326's problem rebuilt somewhere new. A cross-storefront parity check is the
same idea and is cheaper to design before the copies exist.

## 13. Open questions

1. **Rollback.** Publications make "re-publish the previous revision"
   expressible, but it is not undo: a replaced Price is archived, and
   re-publishing mints another new one. Decide whether to offer it rather than
   implying an undo that does not exist.
2. **Does `marketplace-api` read the catalog from the console?** The invariant
   this design asserts: *nothing on the request path of a customer payment may
   depend on the console being reachable.* The console is the authoring plane;
   Stripe is the serving plane, and checkout should resolve prices from Stripe
   by `lookup_key`. If §P's P3a means a synchronous read at checkout, it should
   be rejected; a cached sync is fine.
